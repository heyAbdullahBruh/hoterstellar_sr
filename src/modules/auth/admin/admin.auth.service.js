import crypto from 'crypto';
import { Admin } from './admin.model.js';
import { AdminSession } from './adminSession.model.js';
import { env } from '../../../config/env.js';
import { SECURITY } from '../../../constants/security.js';
import {
  generateRandomToken,
  hashToken,
  generateTokenPair,
} from '../../../utils/token.utils.js';
import { AuthenticationError } from '../../../errors/AuthenticationError.js';
import { NotFoundError } from '../../../errors/NotFoundError.js';
import { BadRequestError } from '../../../errors/BadRequestError.js';
import { ConflictError } from '../../../errors/ConflictError.js';
import { logger } from '../../../utils/logger.js';
import { getBrevoClient } from '../../../config/brevo.js';
import { emitAdminEvent } from '../../../utils/socketEmitter.js';
import { SOCKET_EVENTS } from '../../../constants/socketEvents.js';
import { AdminPasswordReset } from './adminPasswordReset.model.js';
import { adminPasswordResetTemplate } from '../../../emails/templates/adminPasswordResetTemplate.js';
import { adminWelcomeTemplate } from '../../../emails/templates/adminWelcomeTemplate.js';

const TEMP_PASSWORD_EXPIRY_HOURS = 72;
const RESET_TOKEN_EXPIRY_MINUTES = 60;
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'support@hoterstellar.com';

export const adminLogin = async ({ email, password, deviceInfo }) => {
  const admin = await Admin.findOne({ email }).select('+password');

  if (!admin) {
    throw new AuthenticationError('Invalid email or password');
  }

  if (!admin.isActive) {
    throw new AuthenticationError('Account is deactivated');
  }

  const isPasswordValid = await admin.comparePassword(password);

  if (!isPasswordValid) {
    throw new AuthenticationError('Invalid email or password');
  }

  const payload = {
    subs: admin._id.toString(),
    adminId: admin._id.toString(),
    role: admin.role,
    type: 'admin',
  };

  const { accessToken, refreshToken, refreshTokenHash } = generateTokenPair(
    payload,
    env.ADMIN_JWT_SECRET,
    env.ADMIN_ACCESS_TOKEN_EXPIRES_IN,
  );

  await AdminSession.create({
    adminId: admin._id,
    refreshTokenHash,
    deviceInfo: deviceInfo || 'Unknown device',
    issuedAt: new Date(),
    expiresAt: new Date(
      Date.now() + SECURITY.REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000,
    ),
  });

  admin.lastLoginAt = new Date();
  await admin.save();

  logger.info('Admin logged in', { adminId: admin._id, email: admin.email });

  return {
    accessToken,
    refreshToken,
    admin: admin.toSafeObject(),
    mustChangePassword: admin.mustChangePassword,
  };
};

export const adminRefresh = async (refreshToken, deviceInfo) => {
  const refreshTokenHash = hashToken(refreshToken);
  const session = await AdminSession.findOne({ refreshTokenHash }).select(
    '+refreshTokenHash',
  );

  if (!session || !session.isActive()) {
    throw new AuthenticationError('Invalid refresh token');
  }

  const admin = await Admin.findById(session.adminId);

  if (!admin || !admin.isActive) {
    throw new AuthenticationError('Account is deactivated');
  }

  // Rotate refresh token
  session.revokedAt = new Date();
  await session.save();

  const payload = {
    subs: admin._id.toString(),
    adminId: admin._id.toString(),
    role: admin.role,
    type: 'admin',
  };

  const {
    accessToken,
    refreshToken: newRefreshToken,
    refreshTokenHash: newRefreshTokenHash,
  } = generateTokenPair(
    payload,
    env.ADMIN_JWT_SECRET,
    env.ADMIN_ACCESS_TOKEN_EXPIRES_IN,
  );

  const newSession = await AdminSession.create({
    adminId: admin._id,
    refreshTokenHash: newRefreshTokenHash,
    deviceInfo: deviceInfo || 'Unknown device',
    issuedAt: new Date(),
    expiresAt: new Date(
      Date.now() + SECURITY.REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000,
    ),
  });

  session.replacedBySessionId = newSession._id;
  await session.save();

  return {
    accessToken,
    refreshToken: newRefreshToken,
    admin: admin.toSafeObject(),
  };
};

export const adminLogout = async (refreshToken) => {
  if (!refreshToken) {
    return true;
  }

  const refreshTokenHash = hashToken(refreshToken);
  const session = await AdminSession.findOne({ refreshTokenHash });

  if (session && session.isActive()) {
    session.revokedAt = new Date();
    await session.save();
  }

  return true;
};

export const changePassword = async (adminId, currentPassword, newPassword) => {
  const admin = await Admin.findById(adminId).select('+password');

  if (!admin) {
    throw new NotFoundError('Admin not found');
  }

  const isPasswordValid = await admin.comparePassword(currentPassword);

  if (!isPasswordValid) {
    throw new AuthenticationError('Current password is incorrect');
  }

  admin.password = newPassword;
  admin.mustChangePassword = false;
  await admin.save();

  // Revoke all sessions
  await AdminSession.updateMany(
    { adminId: admin._id, revokedAt: null },
    { revokedAt: new Date() },
  );

  // ALSO invalidate any pending reset tokens
  await AdminPasswordReset.updateMany(
    { adminId: admin._id, usedAt: null, invalidatedAt: null },
    { invalidatedAt: new Date() },
  );

  logger.info('Admin changed password', { adminId: admin._id });

  return true;
};

export const createAdmin = async (adminData, createdByAdminId) => {
  const { email, name, role } = adminData;

  const existingAdmin = await Admin.findOne({ email });
  if (existingAdmin) {
    throw new ConflictError('Admin with this email already exists');
  }

  // Verify creator exists
  const creator = await Admin.findById(createdByAdminId);

  // Generate temporary password (16 chars, base64-url-safe)
  const tempPassword = crypto
    .randomBytes(12)
    .toString('base64')
    .replace(/[+/=]/g, '')
    .slice(0, 16);

  const admin = await Admin.create({
    email,
    name,
    role,
    password: tempPassword,
    mustChangePassword: true,
    createdBy: createdByAdminId,
  });

  // Send welcome email with temp password
  const brevoClient = getBrevoClient();
  if (brevoClient) {
    try {
      const loginUrl = `${env.CLIENT_DASHBOARD_URL}/login`;
      const html = adminWelcomeTemplate({
        name: admin.name,
        email: admin.email,
        tempPassword,
        role: admin.role,
        loginUrl,
        createdByName: creator?.name || 'Super Administrator',
        createdByEmail: creator?.email || '',
        createdAt: admin.createdAt || new Date(),
        tempPasswordExpiryHours: TEMP_PASSWORD_EXPIRY_HOURS,
        supportEmail: process.env.SUPPORT_EMAIL || 'support@hoterstellar.com',
      });

      await brevoClient.sendEmail({
        to: admin.email,
        subject: `Welcome to Hoterstellar — Your ${roleLabelFor(admin.role)} Account`,
        html,
      });

      logger.info('Admin welcome email sent', {
        adminId: admin._id,
        email: admin.email,
      });
    } catch (error) {
      logger.error('Failed to send admin welcome email', {
        adminId: admin._id,
        error: error.message,
      });
    }
  } else {
    logger.warn('Brevo not configured — admin welcome email not sent', {
      adminId: admin._id,
    });
  }

  emitAdminEvent(SOCKET_EVENTS.ADMIN_CREATED, {
    adminId: admin._id,
    email: admin.email,
    name: admin.name,
    role: admin.role,
  });

  logger.info('Admin created', {
    adminId: admin._id,
    createdBy: createdByAdminId,
    role: admin.role,
  });

  return admin.toSafeObject();
};

const roleLabelFor = (role) => {
  const map = {
    super_admin: 'Super Admin',
    admin: 'Admin',
    manager: 'Manager',
  };
  return map[role] || 'Admin';
};

/**
 * Request password reset — sends email with reset link.
 * Always returns success (prevents email enumeration).
 */
export const requestPasswordReset = async (email, requestMeta = {}) => {
  const { ip = '', userAgent = '' } = requestMeta;

  const admin = await Admin.findOne({ email });

  // Always return success to prevent email enumeration
  if (!admin) {
    logger.info('Password reset requested for non-existent email', { email });
    return true;
  }

  if (!admin.isActive) {
    logger.warn('Password reset requested for deactivated admin', { email });
    return true;
  }

  // Invalidate all previous unused reset tokens for this admin
  await AdminPasswordReset.updateMany(
    {
      adminId: admin._id,
      usedAt: null,
      invalidatedAt: null,
    },
    { invalidatedAt: new Date() },
  );

  // Generate token
  const rawToken = generateRandomToken(32);
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(
    Date.now() + RESET_TOKEN_EXPIRY_MINUTES * 60 * 1000,
  );

  await AdminPasswordReset.create({
    adminId: admin._id,
    tokenHash,
    requestedIp: ip,
    requestedUserAgent: userAgent,
    expiresAt,
  });

  // Build reset URL
  const resetUrl = `${env.CLIENT_DASHBOARD_URL}/reset-password?token=${rawToken}`;

  // Send email
  const brevoClient = getBrevoClient();
  if (brevoClient) {
    try {
      const html = adminPasswordResetTemplate({
        name: admin.name,
        email: admin.email,
        resetUrl,
        expiresInMinutes: RESET_TOKEN_EXPIRY_MINUTES,
        requestedIp: ip,
        requestedDevice: userAgent,
        requestedAt: new Date(),
        supportEmail: SUPPORT_EMAIL,
      });

      const result = await brevoClient.sendEmail({
        to: admin.email,
        subject: 'Reset Your Hoterstellar Admin Password',
        html,
        text: `Reset your Hoterstellar Admin password by visiting: ${resetUrl}\n\nThis link expires in ${RESET_TOKEN_EXPIRY_MINUTES} minutes and can only be used once.\n\nIf you did not request this, ignore this email.`,
      });

      console.log('Password reset email sent', {
        adminId: admin._id,
        email: admin.email,
        result,
      });

      logger.info('Password reset email sent', {
        adminId: admin._id,
        email: admin.email,
      });
    } catch (error) {
      console.log('Failed to send password reset email', {
        error: error.message,
      });
      logger.error('Failed to send password reset email', {
        adminId: admin._id,
        error: error.message,
      });
    }
  } else {
    logger.warn('Brevo not configured — password reset email not sent', {
      adminId: admin._id,
    });
  }

  return true;
};

/**
 * Reset password using token — verifies, updates, revokes sessions.
 */
export const resetPassword = async (
  rawToken,
  newPassword,
  requestMeta = {},
) => {
  const { ip = '', userAgent = '' } = requestMeta;

  if (!rawToken || !newPassword) {
    throw new BadRequestError('Token and new password are required');
  }

  const tokenHash = hashToken(rawToken);

  const resetRecord = await AdminPasswordReset.findOne({
    tokenHash,
    usedAt: null,
    invalidatedAt: null,
    expiresAt: { $gt: new Date() },
  });

  if (!resetRecord) {
    logger.warn('Invalid or expired password reset token used', { ip });
    throw new BadRequestError('Invalid or expired reset token');
  }

  const admin = await Admin.findById(resetRecord.adminId).select('+password');

  if (!admin) {
    // Token references a non-existent admin — mark invalid and fail
    resetRecord.invalidatedAt = new Date();
    await resetRecord.save();
    throw new BadRequestError('Invalid or expired reset token');
  }

  if (!admin.isActive) {
    resetRecord.invalidatedAt = new Date();
    await resetRecord.save();
    throw new BadRequestError('Account is deactivated');
  }

  // Update password (model pre-save hook will hash it)
  admin.password = newPassword;
  admin.mustChangePassword = false;
  admin.lastLoginAt = admin.lastLoginAt || null;
  await admin.save();

  // Mark token as used
  resetRecord.usedAt = new Date();
  await resetRecord.save();

  // Revoke all active sessions for this admin
  await AdminSession.updateMany(
    { adminId: admin._id, revokedAt: null },
    { revokedAt: new Date() },
  );

  logger.info('Admin password reset successful', {
    adminId: admin._id,
    email: admin.email,
    ip,
    userAgent,
  });

  return true;
};
