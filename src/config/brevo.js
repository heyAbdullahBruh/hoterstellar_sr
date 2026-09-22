import axios from 'axios';
import { env } from './env.js';
import { logger } from '../utils/logger.js';

let brevoConfigured = false;

export const isBrevoConfigured = () => {
  return brevoConfigured;
};

export const verifyBrevoOnStartup = async () => {
  if (!env.BREVO_API_KEY || !env.BREVO_SENDER_EMAIL) {
    logger.warn('Brevo not configured - email features disabled');
    brevoConfigured = false;
    return false;
  }

  try {
    const response = await axios.get('https://api.brevo.com/v3/account', {
      headers: {
        'api-key': env.BREVO_API_KEY,
        'Content-Type': 'application/json',
      },
      timeout: 5000,
    });

    if (response.status === 200) {
      logger.info('Brevo email service verified');
      brevoConfigured = true;
      return true;
    }
  } catch (error) {
    logger.warn('Brevo verification failed', { error: error.message });
    brevoConfigured = false;
    return false;
  }

  brevoConfigured = false;
  return false;
};

export const getBrevoClient = () => {
  if (!brevoConfigured) {
    return null;
  }

  return {
    sendEmail: async ({ to, subject, html, text }) => {
      // Auto-generate plain text if not provided
      // Brevo requires non-empty textContent — empty string is rejected
      const plainText =
        text && text.trim() ? text : stripHtmlToText(html) || subject;

      try {
        const response = await axios.post(
          'https://api.brevo.com/v3/smtp/email',
          {
            sender: {
              email: env.BREVO_SENDER_EMAIL,
              name: env.BREVO_SENDER_NAME || 'Hoterstellar',
            },
            to: [{ email: to }],
            subject,
            htmlContent: html,
            textContent: plainText,
          },
          {
            headers: {
              'api-key': env.BREVO_API_KEY,
              'Content-Type': 'application/json',
            },
            timeout: 10000,
          },
        );
        return response.data;
      } catch (error) {
        const status = error.response?.status;
        const body = error.response?.data;

        logger.error('Brevo email send failed', {
          status,
          body: body ? JSON.stringify(body) : null,
          message: error.message,
        });

        const enriched = new Error(
          body?.message || error.message || 'Brevo email send failed',
        );
        enriched.status = status;
        enriched.brevoBody = body;
        enriched.originalError = error;
        throw enriched;
      }
    },
  };
};

/**
 * Convert HTML to plain text for email fallback.
 * Removes tags, decodes basic entities, collapses whitespace.
 */
const stripHtmlToText = (html) => {
  if (!html) return '';

  return (
    html
      // Remove <style> and <script> blocks entirely
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      // Convert <br> and block elements to newlines
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|h[1-6]|tr|li)>/gi, '\n')
      // Remove all remaining tags
      .replace(/<[^>]+>/g, '')
      // Decode common entities
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&copy;/g, '©')
      // Collapse multiple newlines/spaces
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
};
