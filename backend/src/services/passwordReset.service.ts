import crypto from 'node:crypto';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { env } from '../config/env';
import { getPrisma } from '../lib/prisma';
import { AppError } from '../middleware/error';
import { formatZodError } from '../middleware/validate';
import { logger } from '../utils/logger';
import { persistAuditEvent } from './audit.service';
import { hashPassword } from './auth.service';
import { emailService as defaultEmailService, type EmailService } from './email.service';

// ---------------------------------------------------------------------------
// SEC-02: password reset by email (replaces the AUTH-06 admin-only fallback as
// the self-service path; the admin reset stays).
//
// - forgot: always the same 202 answer whether or not the email exists (no
//   account enumeration). For an ACTIVE account, earlier unused tokens are
//   invalidated and a new single-use token is stored as its SHA-256 hash; the
//   raw token only travels in the emailed link. The email is sent after commit.
// - reset: the token must exist, be unused and unexpired, and its account
//   ACTIVE. The password update, token consumption and session revocation
//   (tokenVersion++) happen in one transaction; the token can never be reused.

const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 128;

export const forgotPasswordSchema = z
  .object({ email: z.string().trim().toLowerCase().email('A valid email is required').max(254) })
  .strict();

export const resetPasswordSchema = z
  .object({
    token: z.string().trim().min(32, 'Invalid or expired reset link').max(200),
    newPassword: z
      .string()
      .min(MIN_PASSWORD_LENGTH, 'Password must be at least 8 characters')
      .max(MAX_PASSWORD_LENGTH),
  })
  .strict();

export const FORGOT_PASSWORD_RESPONSE = {
  message: 'If an account exists for this email, a reset link has been sent.',
} as const;

const INVALID_TOKEN = () => new AppError(400, 'INVALID_RESET_TOKEN', 'Invalid or expired reset link');

export function hashResetToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function parse<T extends z.ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
  const parsed = schema.safeParse(input ?? {});
  if (!parsed.success) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Validation failed', formatZodError(parsed.error));
  }
  return parsed.data;
}

export function resetLink(rawToken: string): string {
  const url = new URL('/reset-password', env.APP_BASE_URL);
  url.searchParams.set('token', rawToken);
  return url.toString();
}

export async function requestPasswordReset(
  input: unknown,
  now: Date = new Date(),
  email: EmailService = defaultEmailService,
  client: PrismaClient = getPrisma()
): Promise<typeof FORGOT_PASSWORD_RESPONSE> {
  const { email: address } = parse(forgotPasswordSchema, input);
  try {
    const user = await client.user.findUnique({
      where: { email: address },
      select: { id: true, name: true, email: true, status: true },
    });
    if (!user || user.status !== 'ACTIVE') return FORGOT_PASSWORD_RESPONSE;

    const raw = crypto.randomBytes(32).toString('base64url');
    await client.$transaction(async (tx) => {
      // Only the newest link works.
      await tx.passwordResetToken.updateMany({ where: { userId: user.id, usedAt: null }, data: { usedAt: now } });
      await tx.passwordResetToken.create({
        data: {
          userId: user.id,
          tokenHash: hashResetToken(raw),
          expiresAt: new Date(now.getTime() + env.PASSWORD_RESET_TTL_MINUTES * 60 * 1000),
        },
      });
      await persistAuditEvent(
        { actorId: user.id, action: 'PASSWORD_RESET_REQUESTED', entityType: 'User', entityId: user.id },
        tx
      );
    });

    const link = resetLink(raw);
    const minutes = env.PASSWORD_RESET_TTL_MINUTES;
    try {
      await email.send({
        to: user.email,
        type: 'PASSWORD_RESET',
        subject: 'FWRP: Reset your password',
        text: `Hi ${user.name},\n\nUse this link within ${minutes} minutes to choose a new password:\n${link}\n\nIf you did not ask for this, ignore this email.`,
        html:
          `<p>Hi ${user.name.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)},</p>` +
          `<p><a href="${link}">Choose a new password</a> (valid for ${minutes} minutes).</p>` +
          `<p>If you did not ask for this, ignore this email.</p>`,
      });
    } catch (err) {
      // Same answer to the caller either way; never log the token or address.
      logger.warn({ userId: user.id, code: (err as { code?: string }).code }, 'Password reset email failed');
    }
    return FORGOT_PASSWORD_RESPONSE;
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(500, 'PASSWORD_RESET_FAILED', 'Password reset request failed');
  }
}

export async function resetPassword(
  input: unknown,
  now: Date = new Date(),
  client: PrismaClient = getPrisma()
): Promise<{ reset: true }> {
  const { token, newPassword } = parse(resetPasswordSchema, input);
  const tokenHash = hashResetToken(token);
  const record = await client.passwordResetToken
    .findUnique({
      where: { tokenHash },
      select: { id: true, userId: true, expiresAt: true, usedAt: true, user: { select: { status: true } } },
    })
    .catch(() => {
      throw new AppError(500, 'PASSWORD_RESET_FAILED', 'Password reset failed');
    });
  if (!record || record.usedAt !== null || record.expiresAt.getTime() <= now.getTime() || record.user.status !== 'ACTIVE') {
    throw INVALID_TOKEN();
  }

  const passwordHash = await hashPassword(newPassword);
  try {
    await client.$transaction(async (tx) => {
      // Consume first: of two concurrent uses, only one succeeds.
      const consumed = await tx.passwordResetToken.updateMany({
        where: { id: record.id, usedAt: null, expiresAt: { gt: now } },
        data: { usedAt: now },
      });
      if (consumed.count !== 1) throw INVALID_TOKEN();
      await tx.passwordResetToken.updateMany({ where: { userId: record.userId, usedAt: null }, data: { usedAt: now } });
      // SEC-03: a reset ends every existing session.
      await tx.user.update({
        where: { id: record.userId },
        data: { passwordHash, tokenVersion: { increment: 1 } },
      });
      await persistAuditEvent(
        { actorId: record.userId, action: 'PASSWORD_RESET_COMPLETED', entityType: 'User', entityId: record.userId },
        tx
      );
    });
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(500, 'PASSWORD_RESET_FAILED', 'Password reset failed');
  }
  return { reset: true };
}
