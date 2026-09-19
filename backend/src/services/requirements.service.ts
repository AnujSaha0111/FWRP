import type { PrismaClient, Requirement, RequirementStatus, User } from '@prisma/client';
import { Priority } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../middleware/error';
import { formatZodError } from '../middleware/validate';
import { getPrisma } from '../lib/prisma';
import { strictDateField } from '../utils/validation';

export const createRequirementSchema = z
  .object({
    food_category: z.string().trim().min(1, 'food_category is required').max(200),
    food_type: z.string().trim().min(1, 'food_type is required').max(200),
    quantity_required: z
      .number({ invalid_type_error: 'quantity_required must be a number' })
      .positive('quantity_required must be greater than 0')
      .finite(),
    required_by: strictDateField('required_by'),
    priority: z.nativeEnum(Priority, {
      errorMap: () => ({ message: 'priority must be a valid Priority' }),
    }),
    location: z.string().trim().min(1, 'location is required').max(500),
  })
  .strict();

export type CreateRequirementInput = z.input<typeof createRequirementSchema>;

export interface RequirementProfile {
  id: string;
  organization_id: string;
  food_category: string;
  food_type: string;
  quantity_required: number;
  quantity_fulfilled: number;
  required_by: Date;
  priority: Priority;
  location: string;
  status: RequirementStatus;
  created_at: Date;
  updated_at: Date;
}

export interface CreateRequirementResult {
  requirement: RequirementProfile;
}

type RecipientWithOrg = Pick<User, 'id' | 'role' | 'status'> & {
  organization: { id: string; verificationStatus: string } | null;
};

function mapRequirementMutationError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'P2003'
  ) {
    return new AppError(404, 'NOT_FOUND', 'Referenced record not found');
  }
  // Never leak SQL, connection details, or row internals.
  return new AppError(500, 'REQUIREMENT_CREATE_FAILED', 'Failed to create requirement');
}

function toRequirementProfile(requirement: Requirement): RequirementProfile {
  return {
    id: requirement.id,
    organization_id: requirement.organizationId,
    food_category: requirement.foodCategory,
    food_type: requirement.foodType,
    quantity_required: requirement.quantityRequired,
    quantity_fulfilled: requirement.quantityFulfilled,
    required_by: requirement.requiredBy,
    priority: requirement.priority,
    location: requirement.location,
    status: requirement.status,
    created_at: requirement.createdAt,
    updated_at: requirement.updatedAt,
  };
}

export async function createRequirement(
  userId: string,
  input: unknown
): Promise<CreateRequirementResult> {
  if (typeof userId !== 'string' || userId.trim() === '') {
    throw new AppError(400, 'VALIDATION_ERROR', 'Validation failed', [
      { field: 'userId', message: 'User id is required' },
    ]);
  }

  const parsed = createRequirementSchema.safeParse(input);
  if (!parsed.success) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Validation failed', formatZodError(parsed.error));
  }
  const data = parsed.data;

  // FR-07: the requirement deadline must be in the future.
  if (data.required_by.getTime() <= Date.now()) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Validation failed', [
      { field: 'required_by', message: 'required_by must be in the future' },
    ]);
  }

  const client: PrismaClient = getPrisma();

  // REQ-01 gate: identity comes ONLY from the authenticated session user row.
  let caller: RecipientWithOrg | null;
  try {
    caller = (await client.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        role: true,
        status: true,
        organization: { select: { id: true, verificationStatus: true } },
      },
    })) as RecipientWithOrg | null;
  } catch (err) {
    throw mapRequirementMutationError(err);
  }
  if (!caller) {
    throw new AppError(404, 'NOT_FOUND', 'User not found');
  }
  if (caller.status !== 'ACTIVE') {
    throw new AppError(401, 'UNAUTHORIZED', 'Account is not active');
  }
  // Belt-and-suspenders behind the route's requireRole('RECIPIENT').
  if (caller.role !== 'RECIPIENT') {
    throw new AppError(403, 'FORBIDDEN', 'Only recipients can create requirements');
  }
  if (!caller.organization || caller.organization.verificationStatus !== 'VERIFIED') {
    throw new AppError(403, 'FORBIDDEN', 'Organization is not verified');
  }

  try {
    const requirement = await client.requirement.create({
      data: {
        // Ownership is derived from the session caller's verified organization.
        organizationId: caller.organization.id,
        foodCategory: data.food_category,
        foodType: data.food_type,
        quantityRequired: data.quantity_required,
        requiredBy: data.required_by,
        priority: data.priority,
        location: data.location,
        // quantityFulfilled keeps the model default (0).
        status: 'OPEN',
      },
    });
    return { requirement: toRequirementProfile(requirement) };
  } catch (err) {
    throw mapRequirementMutationError(err);
  }
}

export interface RequirementsService {
  createRequirement(userId: string, input: unknown): Promise<CreateRequirementResult>;
}

export const requirementsService: RequirementsService = {
  createRequirement: (userId, input) => createRequirement(userId, input),
};
