import type { NextFunction, Request, Response } from 'express';
import {
  getMyOrganization,
  listOrganizations,
  reviewOrganization,
  updateMyOrganization,
  verifyOrganization,
} from '../services/organizations.service';
import { AppError } from '../middleware/error';
import { parsePagination } from '../utils/pagination';

// AUTH-09: caller's own organization only. The organization id resolves from
// the session user row inside the service; no org id is accepted from input.
export async function getMyOrganizationHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return next(new AppError(401, 'UNAUTHORIZED', 'Authentication required'));
    }
    const result = await getMyOrganization(userId);
    res.status(200).json({ success: true, data: { organization: result } });
  } catch (err) {
    next(err);
  }
}

export async function updateMyOrganizationHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return next(new AppError(401, 'UNAUTHORIZED', 'Authentication required'));
    }
    const result = await updateMyOrganization(userId, req.body);
    res.status(200).json({ success: true, data: { organization: result } });
  } catch (err) {
    next(err);
  }
}

function requireAdminId(req: Request): string {
  // requireRole('ADMIN') already ran on the route; this guards direct calls.
  // The id itself is not passed onward: verification writes carry no actor
  // until ORG-06 owns audit attribution.
  const adminId = req.user?.id;
  if (!adminId) {
    throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  }
  return adminId;
}

// ORG-02 admin handlers. The target organization id comes from the route
// parameter only (req.params.id); body ids are rejected by strict schemas,
// so members cannot steer verification onto another organization.
export async function adminListOrganizationsHandler(req: Request, res: Response, next: NextFunction) {
  try {
    // Authentication + ADMIN role enforced by route middleware; listing needs
    // no actor identity beyond that.
    const status = (req.query as { status?: 'PENDING' | 'UNDER_REVIEW' | 'VERIFIED' | 'REJECTED' }).status;
    const params = parsePagination(req.query as Record<string, unknown>);
    const result = await listOrganizations({ status }, { page: params.page, limit: params.limit });
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

export async function adminReviewOrganizationHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await reviewOrganization(idOf(req), requireAdminId(req));
    res.status(200).json({ success: true, data: { organization: result } });
  } catch (err) {
    next(err);
  }
}

export async function adminVerifyOrganizationHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await verifyOrganization(idOf(req), requireAdminId(req), req.body);
    res.status(200).json({ success: true, data: { organization: result } });
  } catch (err) {
    next(err);
  }
}

function idOf(req: Request): string {
  return Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
}
