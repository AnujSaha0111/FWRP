import bcrypt from 'bcryptjs';
import { z } from 'zod';
import type { Organization, PrismaClient, User } from '@prisma/client';
import { OrganizationType } from '@prisma/client';
import { AppError } from '../middleware/error';
import { formatZodError } from '../middleware/validate';
import { getPrisma } from '../lib/prisma';
import { persistAuditEvent } from './audit.service';
import { signAccessToken, signRefreshToken, verifyRefreshToken } from '../utils/jwt';
import { validateAuthClaims } from '../middleware/auth';
import type { AuthUser } from '../types/express';
import { env } from '../config/env';

// AUTH-01: user registration (FR-01). AUTH-02: login (FR-02) below.
// AUTH-03: logout and AUTH-05: refresh rotation live in the controller +
// refreshUser below. AUTH-06: self change + admin reset fallback below (D-13
// option B; email-token flow stays undecided under D-13). Later tasks own
// profile. No tokens are
// issued by registration; only login and refresh issue them.

const MAX_NAME_LENGTH = 200;
const MAX_EMAIL_LENGTH = 254;
const MAX_ADDRESS_LENGTH = 500;
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 128;

// AUTH-04: bcrypt cost policy. Production never hashes below the floor;
// test uses a documented fast cost so the suite stays quick. Resolved through
// a pure function so the policy itself is unit-testable.
export const BCRYPT_MIN_PRODUCTION_COST = 10;
const BCRYPT_PRODUCTION_COST = 10;
const BCRYPT_TEST_COST = 4;

export function resolveBcryptCost(nodeEnv: string = env.NODE_ENV): number {
  if (nodeEnv === 'test') return BCRYPT_TEST_COST;
  return Math.max(BCRYPT_MIN_PRODUCTION_COST, BCRYPT_PRODUCTION_COST);
}

export const BCRYPT_COST = resolveBcryptCost();

const PHONE_PATTERN = /^\+?[0-9\s\-()]{7,20}$/;

export const registerSchema = z
  .object({
    name: z.string().trim().min(1, 'Name is required').max(MAX_NAME_LENGTH),
    email: z.string().trim().max(MAX_EMAIL_LENGTH).email('Email must be a valid email').toLowerCase(),
    phone: z
      .string()
      .trim()
      .min(1, 'Phone is required')
      .regex(PHONE_PATTERN, 'Phone must be a valid phone number'),
    // Not trimmed: spaces are legal password characters.
    password: z
      .string()
      .min(MIN_PASSWORD_LENGTH, 'Password must be at least 8 characters')
      .max(MAX_PASSWORD_LENGTH),
    // Public registration covers provider/recipient/volunteer. Admin accounts
    // are created out-of-band, never via self-registration.
    role: z.enum(['PROVIDER', 'RECIPIENT', 'VOLUNTEER']),
    orgName: z.string().trim().min(1).max(MAX_NAME_LENGTH).optional(),
    address: z.string().trim().min(1).max(MAX_ADDRESS_LENGTH).optional(),
    organizationType: z.nativeEnum(OrganizationType).optional().default('OTHER'),
    // Precise coordinates arrive via D-07 geocoding/manual entry later;
    // 0 marks "unknown" until then (documented, not silently precise).
    latitude: z.number().min(-90).max(90).optional().default(0),
    longitude: z.number().min(-180).max(180).optional().default(0),
  })
  .superRefine((value, ctx) => {
    if (value.role === 'PROVIDER' || value.role === 'RECIPIENT') {
      if (!value.orgName) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['orgName'],
          message: 'Organization name is required for provider/recipient',
        });
      }
      if (!value.address) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['address'],
          message: 'Address is required for provider/recipient',
        });
      }
    }
  });

export type RegisterInput = z.input<typeof registerSchema>;
type RegisterData = z.output<typeof registerSchema>;

export type SafeUser = Pick<
  User,
  'id' | 'name' | 'email' | 'phone' | 'role' | 'organizationId' | 'status' | 'createdAt' | 'updatedAt'
>;

export type SafeOrganization = Pick<
  Organization,
  'id' | 'name' | 'type' | 'address' | 'verificationStatus'
>;

export interface RegisterResult {
  user: SafeUser;
  organization: SafeOrganization | null;
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_COST);
}

function toSafeUser(user: User): SafeUser {
  const { id, name, email, phone, role, organizationId, status, createdAt, updatedAt } = user;
  return { id, name, email, phone, role, organizationId, status, createdAt, updatedAt };
}

function toSafeOrganization(org: Organization): SafeOrganization {
  const { id, name, type, address, verificationStatus } = org;
  return { id, name, type, address, verificationStatus };
}

function isPrismaKnownError(err: unknown): err is { code: string } {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    typeof (err as { code: unknown }).code === 'string'
  );
}

// FR-01 registration: validate, hash, then create Organization (when the role
// needs one) + User + audit log atomically in one transaction. Returns 201
// payload data (user without passwordHash). No tokens issued (AUTH-02).
export async function registerUser(input: RegisterInput): Promise<RegisterResult> {
  const parsed = registerSchema.safeParse(input);
  if (!parsed.success) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Validation failed', formatZodError(parsed.error));
  }
  const data: RegisterData = parsed.data;
  const client: PrismaClient = getPrisma();

  const existing = await client.user
    .findUnique({ where: { email: data.email } })
    .catch((err: unknown) => {
      throw mapRegistrationError(err);
    });
  if (existing) {
    throw new AppError(409, 'CONFLICT', 'Email is already registered');
  }

  const passwordHash = await hashPassword(data.password);
  const needsOrganization = data.role === 'PROVIDER' || data.role === 'RECIPIENT';

  try {
    return await client.$transaction(async (tx) => {
      let organization: Organization | null = null;
      if (needsOrganization) {
        organization = await tx.organization.create({
          data: {
            name: data.orgName as string,
            type: data.organizationType,
            address: data.address as string,
            latitude: data.latitude,
            longitude: data.longitude,
          },
        });
      }
      const user = await tx.user.create({
        data: {
          name: data.name,
          email: data.email,
          phone: data.phone,
          passwordHash,
          role: data.role,
          organizationId: organization ? organization.id : null,
        },
      });
      await persistAuditEvent(
        {
          actorId: user.id,
          action: 'USER_REGISTER',
          entityType: 'User',
          entityId: user.id,
          oldValue: null,
          newValue: {
            id: user.id,
            email: user.email,
            role: user.role,
            organizationId: user.organizationId,
            status: user.status,
          },
        },
        tx,
      );
      return {
        user: toSafeUser(user),
        organization: organization ? toSafeOrganization(organization) : null,
      };
    });
  } catch (err) {
    throw mapRegistrationError(err);
  }
}

function mapRegistrationError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (isPrismaKnownError(err)) {
    // P2002: email uniqueness race between pre-check and insert.
    if (err.code === 'P2002') {
      return new AppError(409, 'CONFLICT', 'Email is already registered');
    }
  }
  // Never leak passwords, hashes, SQL, or connection details.
  return new AppError(500, 'REGISTRATION_FAILED', 'Registration failed');
}

// ---------------------------------------------------------------------------
// AUTH-02: login (FR-02). Validates credentials, issues access + refresh
// tokens via the BE-07 JWT utilities. Read-only: no transaction, no audit row.

export const loginSchema = z.object({
  email: z.string().trim().max(MAX_EMAIL_LENGTH).email('Email must be a valid email').toLowerCase(),
  // min(1) only: login must not enforce creation-time password policy, and
  // short input simply fails verification below.
  password: z.string().min(1, 'Password is required').max(MAX_PASSWORD_LENGTH),
});

export type LoginInput = z.input<typeof loginSchema>;

export interface LoginResult {
  user: SafeUser;
  accessToken: string;
  refreshToken: string;
}

// Single generic message for unknown user, wrong password, and inactive
// account alike: callers must not learn which emails exist or why auth failed.
const INVALID_CREDENTIALS = 'Invalid email or password';

// Valid-format dummy hash so bcrypt.compare runs (and takes the same time)
// even when no active user exists — no account enumeration via timing.
const DUMMY_HASH = '$2b$04$nX5nMFPI8Q0sGM3SAb2t2Og41RK83oZ/0A7TL4j1SI4rkEaBuv8R.';

function invalidCredentials(): AppError {
  return new AppError(401, 'UNAUTHORIZED', INVALID_CREDENTIALS);
}

export async function loginUser(input: LoginInput): Promise<LoginResult> {
  const parsed = loginSchema.safeParse(input);
  if (!parsed.success) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Validation failed', formatZodError(parsed.error));
  }
  const client: PrismaClient = getPrisma();

  let user: User | null;
  try {
    user = await client.user.findUnique({ where: { email: parsed.data.email } });
  } catch (err) {
    throw mapLoginError(err);
  }
  const candidate = user && user.status === 'ACTIVE' ? user : null;
  let verified = false;
  try {
    verified = await bcrypt.compare(
      parsed.data.password,
      candidate ? candidate.passwordHash : DUMMY_HASH,
    );
  } catch (err) {
    throw mapLoginError(err);
  }
  if (!candidate || !verified) {
    throw invalidCredentials();
  }
  const claims = {
    id: candidate.id,
    email: candidate.email,
    role: candidate.role,
    organizationId: candidate.organizationId ?? null,
  };
  return {
    user: toSafeUser(candidate),
    accessToken: signAccessToken(claims),
    refreshToken: signRefreshToken(claims),
  };
}

function mapLoginError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  // Never leak emails, passwords, hashes, SQL, or connection details.
  return new AppError(500, 'LOGIN_FAILED', 'Login failed');
}

// ---------------------------------------------------------------------------
// AUTH-05: refresh rotation (stateless). Verifies the refresh token with the
// BE-07 refresh secret + shared claim rules, then issues a FRESH pair — the
// old refresh token is superseded client-side by the rotated cookies/body.
// No database, no server session store, no reuse-detection table (that would
// be a schema change); revocation/status-freshness belongs to later phases.

export interface RefreshResult {
  user: Pick<AuthUser, 'id' | 'email' | 'role' | 'organizationId'>;
  accessToken: string;
  refreshToken: string;
}

export async function refreshUser(token: unknown): Promise<RefreshResult> {
  if (typeof token !== 'string' || token.trim() === '') {
    throw new AppError(401, 'UNAUTHORIZED', 'Refresh token required');
  }
  if (token.split('.').length !== 3) {
    throw new AppError(401, 'UNAUTHORIZED', 'Invalid token');
  }
  let decoded: AuthUser;
  try {
    decoded = verifyRefreshToken(token);
  } catch (err) {
    if ((err as Error)?.name === 'TokenExpiredError') {
      throw new AppError(401, 'UNAUTHORIZED', 'Token expired');
    }
    // Wrong secret, wrong algorithm, malformed signature: never leak details.
    throw new AppError(401, 'UNAUTHORIZED', 'Invalid token');
  }
  if (!validateAuthClaims(decoded)) {
    throw new AppError(401, 'UNAUTHORIZED', 'Invalid token payload');
  }
  const claims = {
    id: decoded.id,
    email: decoded.email,
    role: decoded.role,
    organizationId: decoded.organizationId ?? null,
  };
  return {
    user: claims,
    accessToken: signAccessToken(claims),
    refreshToken: signRefreshToken(claims),
  };
}

export interface AuthService {
  register(input: RegisterInput): Promise<RegisterResult>;
  login(input: LoginInput): Promise<LoginResult>;
  refresh(token: unknown): Promise<RefreshResult>;
  changePassword(userId: string, input: ChangePasswordInput): Promise<PasswordChangeResult>;
  adminResetPassword(
    adminId: string,
    targetUserId: unknown,
    input: AdminResetInput,
  ): Promise<AdminResetResult>;
  hashPassword(password: string): Promise<string>;
}

export const authService: AuthService = {
  register: (input) => registerUser(input),
  login: (input) => loginUser(input),
  refresh: (token) => refreshUser(token),
  changePassword: (userId, input) => changePassword(userId, input),
  adminResetPassword: (adminId, targetUserId, input) => adminResetPassword(adminId, targetUserId, input),
  hashPassword,
};

// ---------------------------------------------------------------------------
// AUTH-06: password reset fallback (D-13 option B, documented choice).
// D-13 option A (email token flow) needs a reset-token store plus live SMTP
// delivery; neither exists (no token table by schema-freeze, mock-only email
// in dev/test), so AUTH-06 ships the sanctioned fallback: an authenticated
// user changes their own password, and an admin resets any user's password.
// The email-token flow remains available once D-13 is decided. D-13 itself
// stays unresolved (team decision).

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required').max(MAX_PASSWORD_LENGTH),
  // Same creation policy as registration (AUTH-01): 8-128 chars.
  newPassword: z
    .string()
    .min(MIN_PASSWORD_LENGTH, 'Password must be at least 8 characters')
    .max(MAX_PASSWORD_LENGTH),
});

export type ChangePasswordInput = z.input<typeof changePasswordSchema>;

export interface PasswordChangeResult {
  changed: true;
}

export const adminResetSchema = z.object({
  newPassword: z
    .string()
    .min(MIN_PASSWORD_LENGTH, 'Password must be at least 8 characters')
    .max(MAX_PASSWORD_LENGTH),
});

export type AdminResetInput = z.input<typeof adminResetSchema>;

export interface AdminResetResult {
  changed: true;
  userId: string;
}

const WRONG_CURRENT_PASSWORD = 'Current password is incorrect';

function mapPasswordError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (isPrismaKnownError(err) && err.code === 'P2025') {
    return new AppError(404, 'NOT_FOUND', 'User not found');
  }
  // Never leak passwords, hashes, SQL, or connection details.
  return new AppError(500, 'PASSWORD_UPDATE_FAILED', 'Password update failed');
}

// Authenticated self-change. Proves the current password, then updates the
// hash and writes the audit row atomically. Owner is taken from the session,
// never from request input, so one user cannot change another's password.
export async function changePassword(
  userId: string,
  input: ChangePasswordInput,
): Promise<PasswordChangeResult> {
  const parsed = changePasswordSchema.safeParse(input);
  if (!parsed.success) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Validation failed', formatZodError(parsed.error));
  }
  if (parsed.data.currentPassword === parsed.data.newPassword) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Validation failed', [
      { field: 'newPassword', message: 'New password must be different' },
    ]);
  }
  const client: PrismaClient = getPrisma();
  let user: User | null;
  try {
    user = await client.user.findUnique({ where: { id: userId } });
  } catch (err) {
    throw mapPasswordError(err);
  }
  if (!user || user.status !== 'ACTIVE') {
    throw new AppError(401, 'UNAUTHORIZED', WRONG_CURRENT_PASSWORD);
  }
  let verified = false;
  try {
    verified = await bcrypt.compare(parsed.data.currentPassword, user.passwordHash);
  } catch (err) {
    throw mapPasswordError(err);
  }
  if (!verified) {
    throw new AppError(401, 'UNAUTHORIZED', WRONG_CURRENT_PASSWORD);
  }
  const passwordHash = await hashPassword(parsed.data.newPassword);
  try {
    await client.$transaction(async (tx) => {
      await tx.user.update({ where: { id: userId }, data: { passwordHash } });
      await persistAuditEvent(
        {
          actorId: userId,
          action: 'PASSWORD_CHANGE',
          entityType: 'User',
          entityId: userId,
          oldValue: null,
          newValue: { id: userId },
        },
        tx,
      );
    });
  } catch (err) {
    throw mapPasswordError(err);
  }
  return { changed: true };
}

// Admin fallback: an ADMIN (checked by requireRole on the route) sets any
// user's password. Target existence is reported (404) since administrators
// are authorized to enumerate accounts; the hash policy matches registration.
export async function adminResetPassword(
  adminId: string,
  targetUserId: unknown,
  input: AdminResetInput,
): Promise<AdminResetResult> {
  const parsed = adminResetSchema.safeParse(input);
  if (!parsed.success) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Validation failed', formatZodError(parsed.error));
  }
  if (typeof targetUserId !== 'string' || targetUserId.trim() === '') {
    throw new AppError(400, 'VALIDATION_ERROR', 'Validation failed', [
      { field: 'userId', message: 'Target user id is required' },
    ]);
  }
  const client: PrismaClient = getPrisma();
  let target: User | null;
  try {
    target = await client.user.findUnique({ where: { id: targetUserId } });
  } catch (err) {
    throw mapPasswordError(err);
  }
  if (!target) {
    throw new AppError(404, 'NOT_FOUND', 'User not found');
  }
  const passwordHash = await hashPassword(parsed.data.newPassword);
  try {
    await client.$transaction(async (tx) => {
      await tx.user.update({ where: { id: target.id }, data: { passwordHash } });
      await persistAuditEvent(
        {
          actorId: adminId,
          action: 'PASSWORD_RESET',
          entityType: 'User',
          entityId: target.id,
          oldValue: null,
          newValue: { id: target.id },
        },
        tx,
      );
    });
  } catch (err) {
    throw mapPasswordError(err);
  }
  return { changed: true, userId: target.id };
}
