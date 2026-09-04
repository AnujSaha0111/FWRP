import { z } from 'zod';
import type { Organization, PrismaClient, User } from '@prisma/client';
import { AppError } from '../middleware/error';
import { formatZodError } from '../middleware/validate';
import { getPrisma } from '../lib/prisma';
import { persistAuditEvent } from './audit.service';

// AUTH-08: self user profile (FR-01 account data). Email is intentionally NOT
// changeable here (re-verification flow belongs to a later task), and neither
// are role/status/organizationId: the strict schema below rejects them, so no
// privilege escalation is possible through this endpoint. Address maps to the
// caller's Organization (schema has no per-user address column); users without
// an organization cannot set one.

const MAX_NAME_LENGTH = 200;
const MAX_ADDRESS_LENGTH = 500;
const PHONE_PATTERN = /^\+?[0-9\s\-()]{7,20}$/;

export const updateProfileSchema = z
  .object({
    name: z.string().trim().min(1, 'Name must be non-empty').max(MAX_NAME_LENGTH).optional(),
    phone: z
      .string()
      .trim()
      .min(1, 'Phone must be non-empty')
      .regex(PHONE_PATTERN, 'Phone must be a valid phone number')
      .optional(),
    address: z.string().trim().min(1, 'Address must be non-empty').max(MAX_ADDRESS_LENGTH).optional(),
  })
  .strict()
  .refine((value) => value.name !== undefined || value.phone !== undefined || value.address !== undefined, {
    message: 'At least one of name, phone, address is required',
    path: ['name'],
  });

export type UpdateProfileInput = z.input<typeof updateProfileSchema>;

export interface ProfileResult {
  user: Pick<
    User,
    'id' | 'name' | 'email' | 'phone' | 'role' | 'organizationId' | 'status' | 'createdAt' | 'updatedAt'
  >;
  organization: Pick<Organization, 'id' | 'name' | 'type' | 'address' | 'verificationStatus'> | null;
}

type UserWithOrg = User & { organization: Organization | null };

function toProfile(user: UserWithOrg): ProfileResult {
  const { id, name, email, phone, role, organizationId, status, createdAt, updatedAt } = user;
  const org = user.organization;
  return {
    user: { id, name, email, phone, role, organizationId, status, createdAt, updatedAt },
    organization: org
      ? { id: org.id, name: org.name, type: org.type, address: org.address, verificationStatus: org.verificationStatus }
      : null,
  };
}

function mapProfileError(err: unknown, operation: 'read' | 'update'): AppError {
  if (err instanceof AppError) return err;
  if (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'P2025'
  ) {
    return new AppError(404, 'NOT_FOUND', 'User not found');
  }
  // Never leak SQL, connection details, or user data internals.
  return new AppError(
    500,
    operation === 'read' ? 'PROFILE_READ_FAILED' : 'PROFILE_UPDATE_FAILED',
    operation === 'read' ? 'Failed to read profile' : 'Failed to update profile',
  );
}

function requireActive(user: UserWithOrg | null): asserts user is UserWithOrg {
  if (!user) {
    throw new AppError(404, 'NOT_FOUND', 'User not found');
  }
  if (user.status !== 'ACTIVE') {
    throw new AppError(401, 'UNAUTHORIZED', 'Account is not active');
  }
}

// Owner id always comes from the session (req.user), never from input.
export async function getProfile(userId: string): Promise<ProfileResult> {
  if (typeof userId !== 'string' || userId.trim() === '') {
    throw new AppError(400, 'VALIDATION_ERROR', 'Validation failed', [
      { field: 'userId', message: 'User id is required' },
    ]);
  }
  const client: PrismaClient = getPrisma();
  let user: UserWithOrg | null;
  try {
    user = await client.user.findUnique({
      where: { id: userId },
      include: { organization: true },
    });
  } catch (err) {
    throw mapProfileError(err, 'read');
  }
  requireActive(user);
  return toProfile(user);
}

export async function updateProfile(userId: string, input: UpdateProfileInput): Promise<ProfileResult> {
  const parsed = updateProfileSchema.safeParse(input);
  if (!parsed.success) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Validation failed', formatZodError(parsed.error));
  }
  if (typeof userId !== 'string' || userId.trim() === '') {
    throw new AppError(400, 'VALIDATION_ERROR', 'Validation failed', [
      { field: 'userId', message: 'User id is required' },
    ]);
  }
  const client: PrismaClient = getPrisma();
  let current: UserWithOrg | null;
  try {
    current = await client.user.findUnique({
      where: { id: userId },
      include: { organization: true },
    });
  } catch (err) {
    throw mapProfileError(err, 'update');
  }
  requireActive(current);
  const existing: UserWithOrg = current;
  if (parsed.data.address !== undefined && !existing.organizationId) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Validation failed', [
      { field: 'address', message: 'Address requires an organization' },
    ]);
  }

  const userData: { name?: string; phone?: string } = {};
  if (parsed.data.name !== undefined) userData.name = parsed.data.name;
  if (parsed.data.phone !== undefined) userData.phone = parsed.data.phone;

  try {
    const updated = await client.$transaction(async (tx) => {
      const user =
        Object.keys(userData).length > 0
          ? await tx.user.update({ where: { id: userId }, data: userData })
          : existing;
      let organization = existing.organization;
      if (parsed.data.address !== undefined && existing.organizationId) {
        organization = await tx.organization.update({
          where: { id: existing.organizationId },
          data: { address: parsed.data.address },
        });
      }
      const oldValue: Record<string, unknown> = { id: existing.id, name: existing.name, phone: existing.phone };
      const newValue: Record<string, unknown> = { id: user.id, name: user.name, phone: user.phone };
      if (existing.organization) oldValue.address = existing.organization.address;
      if (organization) newValue.address = organization.address;
      await persistAuditEvent(
        {
          actorId: userId,
          action: 'PROFILE_UPDATE',
          entityType: 'User',
          entityId: userId,
          oldValue,
          newValue,
        },
        tx,
      );
      return { user, organization };
    });
    return toProfile({ ...updated.user, organization: updated.organization } as UserWithOrg);
  } catch (err) {
    throw mapProfileError(err, 'update');
  }
}

export interface UsersService {
  getProfile(userId: string): Promise<ProfileResult>;
  updateProfile(userId: string, input: UpdateProfileInput): Promise<ProfileResult>;
}

export const usersService: UsersService = {
  getProfile: (userId) => getProfile(userId),
  updateProfile: (userId, input) => updateProfile(userId, input),
};
