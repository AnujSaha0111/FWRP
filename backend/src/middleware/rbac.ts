import type { Request, Response, NextFunction } from 'express';
import { AppError } from './error';
import type { Role } from '@prisma/client';
import { getPrismaIfConfigured } from '../lib/prisma';

export function requireRole(...roles: Role[]) {
  const allowed = new Set<string>(roles);
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      return next(new AppError(401, 'UNAUTHORIZED', 'Authentication required'));
    }
    if (!allowed.has(req.user.role)) {
      return next(new AppError(403, 'FORBIDDEN', 'Insufficient permissions'));
    }
    next();
  };
}

type GetOrganization = (orgId: string) => Promise<{ verificationStatus: string } | null>;

export function requireVerifiedOrg(getOrganization?: GetOrganization) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) {
      return next(new AppError(401, 'UNAUTHORIZED', 'Authentication required'));
    }
    const orgId = req.user.organizationId;
    if (!orgId) {
      return next(new AppError(403, 'FORBIDDEN', 'Organization verification required'));
    }

    // If caller injected resolver, use it (test/mock path, no live DB required)
    let org: { verificationStatus: string } | null = null;
    if (getOrganization) {
      try {
        org = await getOrganization(orgId);
      } catch {
        return next(new AppError(500, 'INTERNAL_ERROR', 'Organization lookup failed'));
      }
    } else {
      // Default path: try Prisma if configured, else preserve boundary without fake DB behavior
      const prisma = getPrismaIfConfigured();
      if (!prisma) {
        // No live DB — cannot verify. Preserve boundary: treat as unverified without fabricating.
        // For code-only iteration, return 403 to avoid silent allow.
        return next(new AppError(403, 'FORBIDDEN', 'Organization verification required'));
      }
      try {
        org = await prisma.organization.findUnique({
          where: { id: orgId },
          select: { verificationStatus: true },
        });
      } catch {
        return next(new AppError(500, 'INTERNAL_ERROR', 'Organization lookup failed'));
      }
    }

    if (!org) {
      return next(new AppError(403, 'FORBIDDEN', 'Organization not found'));
    }
    if (org.verificationStatus !== 'VERIFIED') {
      return next(new AppError(403, 'FORBIDDEN', 'Organization not verified'));
    }
    next();
  };
}

export function requireOwnership(
  getOwnerId: (req: Request) => string | null | undefined | Promise<string | null | undefined>
) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) {
      return next(new AppError(401, 'UNAUTHORIZED', 'Authentication required'));
    }
    let ownerId: string | null | undefined;
    try {
      ownerId = await getOwnerId(req);
    } catch {
      return next(new AppError(400, 'VALIDATION_ERROR', 'Invalid ownership context'));
    }
    if (!ownerId || typeof ownerId !== 'string') {
      return next(new AppError(400, 'VALIDATION_ERROR', 'Missing ownership context'));
    }
    if (ownerId !== req.user.id) {
      return next(new AppError(403, 'FORBIDDEN', 'Not authorized for this resource'));
    }
    next();
  };
}
