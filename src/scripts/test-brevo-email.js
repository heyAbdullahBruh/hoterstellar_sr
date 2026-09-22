// scripts/test-brevo-email.mjs
//
// Standalone Brevo transactional-email probe.
// Usage:
//   node scripts/test-brevo-email.mjs you@example.com
//
// Reads (in order of preference):
//   BREVO_API_KEY  /  BREVO_SMTP_KEY  /  BREVO_KEY
//   BREVO_SENDER_EMAIL  /  EMAIL_FROM  /  MAIL_FROM
//   BREVO_SENDER_NAME   /  EMAIL_FROM_NAME
//
// Prints the FULL Brevo response body on failure — the reason the
// "Request failed with status code 400" was invisible until now.

import 'dotenv/config';
import axios from 'axios';

const TO = process.argv[2];
if (!TO) {
  console.error(
    'Usage: node scripts/test-brevo-email.mjs <recipient@example.com>',
  );
  process.exit(1);
}

const API_KEY =
  process.env.BREVO_API_KEY ||
  process.env.BREVO_SMTP_KEY ||
  process.env.BREVO_KEY;

const SENDER_EMAIL =
  process.env.BREVO_SENDER_EMAIL ||
  process.env.EMAIL_FROM ||
  process.env.MAIL_FROM;

const SENDER_NAME =
  process.env.BREVO_SENDER_NAME ||
  process.env.EMAIL_FROM_NAME ||
  'Hoterstellar';

// ── Preflight: catch config problems before we even call Brevo ──
const problems = [];
if (!API_KEY)
  problems.push('Missing BREVO_API_KEY (or BREVO_SMTP_KEY / BREVO_KEY).');
else if (!API_KEY.startsWith('xkeysib-')) {
  problems.push(
    `BREVO_API_KEY does not start with "xkeysib-". Got prefix: "${API_KEY.slice(0, 8)}…". ` +
      `You may have pasted the SMTP key or the wrong credential.`,
  );
}
if (API_KEY && API_KEY !== API_KEY.trim()) {
  problems.push(
    'BREVO_API_KEY has leading/trailing whitespace — trim it in .env.',
  );
}
if (!SENDER_EMAIL) {
  problems.push('Missing BREVO_SENDER_EMAIL (or EMAIL_FROM / MAIL_FROM).');
}
if (SENDER_EMAIL && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(SENDER_EMAIL)) {
  problems.push(`Sender email looks malformed: "${SENDER_EMAIL}".`);
}
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(TO)) {
  problems.push(`Recipient email looks malformed: "${TO}".`);
}

if (problems.length) {
  console.error('\n✖ Configuration problems detected before calling Brevo:');
  for (const p of problems) console.error(`   • ${p}`);
  console.error('\nFix these and re-run.\n');
  process.exit(2);
}

// ── Build the exact payload shape your backend should be sending ──
const payload = {
  sender: { email: SENDER_EMAIL, name: SENDER_NAME },
  to: [{ email: TO }],
  subject: 'Hoterstellar — Brevo test email',
  htmlContent: `
    <div style="font-family:system-ui,Segoe UI,Roboto,sans-serif;color:#111">
      <h2 style="margin:0 0 12px">Brevo test email</h2>
      <p>If you can read this, your Brevo transactional email setup works.</p>
      <p style="color:#666;font-size:13px">
        Sent ${new Date().toISOString()} from <code>${SENDER_EMAIL}</code>
      </p>
    </div>
  `,
  textContent:
    'Brevo test email — if you can read this, your transactional email setup works.',
  // Uncomment to tag this send in Brevo's logs so you can filter test traffic:
  // tags: ['brevo-selftest'],
};

console.log('\n→ Preflight OK');
console.log(`  Endpoint:  https://api.brevo.com/v3/smtp/email`);
console.log(`  Sender:    ${SENDER_EMAIL} (${SENDER_NAME})`);
console.log(`  Recipient: ${TO}`);
console.log(`  API key:   ${API_KEY.slice(0, 10)}…${API_KEY.slice(-4)}\n`);

try {
  const res = await axios.post('https://api.brevo.com/v3/smtp/email', payload, {
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'api-key': API_KEY,
    },
    timeout: 20000,
  });

  console.log('✔ Brevo accepted the send.');
  console.log(`  HTTP ${res.status}`);
  console.log(`  messageId: ${res.data?.messageId ?? '(none returned)'}`);
  console.log(
    '\nCheck the recipient inbox (and Brevo → Transactional → Logs).\n',
  );
  process.exit(0);
} catch (err) {
  const status = err.response?.status;
  const body = err.response?.data;

  console.error('✖ Brevo rejected the request.\n');
  if (status) console.error(`  HTTP ${status}`);
  if (body) {
    console.error('  Response body:');
    console.error(
      JSON.stringify(body, null, 2)
        .split('\n')
        .map((l) => '    ' + l)
        .join('\n'),
    );
  } else if (err.request) {
    console.error('  No response received (network / DNS / TLS).');
    console.error(`  ${err.message}`);
  } else {
    console.error(`  ${err.message}`);
  }

  // Translate the common causes into an actionable hint.
  const code = body?.code || body?.error?.code;
  const message = body?.message || body?.error?.message || '';
  console.error('\n  Likely cause:');
  if (status === 401) {
    console.error(
      '   • API key rejected. Regenerate it in Brevo → SMTP & API → API Keys',
    );
    console.error('     and confirm it starts with "xkeysib-".');
  } else if (status === 400 && /sender/i.test(message)) {
    console.error(
      '   • Sender not verified. Add/verify it in Brevo → Senders, Domains & Dedicated IPs.',
    );
  } else if (status === 400 && /recipient|email/i.test(message)) {
    console.error(
      '   • Recipient rejected. Confirm the address is a valid mailbox.',
    );
  } else if (status === 400 && /html|content/i.test(message)) {
    console.error(
      '   • Missing htmlContent/textContent or invalid payload shape.',
    );
  } else if (status === 400 && code === 'invalid_parameter') {
    console.error(
      '   • One or more fields have the wrong type. Compare your payload against the\n' +
        '     exact shape printed above — especially "to" (must be an array of objects).',
    );
  } else if (status === 402) {
    console.error('   • Brevo quota exhausted or account suspended.');
  } else if (status === 429) {
    console.error('   • Rate limited by Brevo. Back off and retry.');
  } else if (status >= 500) {
    console.error(
      '   • Brevo-side error. Retry shortly; check status.brevo.com.',
    );
  } else {
    console.error(
      '   • Compare the printed payload with Brevo API v3 docs; the body above is authoritative.',
    );
  }
  console.error('');
  process.exit(3);
}
