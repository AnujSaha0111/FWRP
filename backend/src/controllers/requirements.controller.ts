import type { NextFunction, Request, Response } from 'express';
import {
  cancelRequirement,
  createRequirement,
  getRequirementHistory,
  listRequirements,
  updateRequirement,
} from '../services/requirements.service';
import { AppError } from '../middleware/error';

// REQ-01: recipient requirement creation. The acting recipient identity comes
// from the authenticated session; ownership (organization_id) is derived
// server-side in the service. The strict body schema rejects server-controlled
// fields (status/organizationId/quantity_fulfilled/timestamps/identity).
export async function createRequirementHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return next(new AppError(401, 'UNAUTHORIZED', 'Authentication required'));
    }
    const result = await createRequirement(userId, req.body);
    res.status(201).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

// REQ-02: owner-organization requirement edit. Identity comes from the session;
// ownership is the persisted requirement organization, re-checked in the
// service. Strict partial body rejects server-controlled fields.
export async function updateRequirementHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return next(new AppError(401, 'UNAUTHORIZED', 'Authentication required'));
    }
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const result = await updateRequirement(id, userId, req.body);
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

// REQ-07: owner-organization requirement cancellation. The requirement id
// comes from the path and the recipient identity from the session; the service
// re-checks role + persisted ownership and the REQ-04 lifecycle guard. No
// request body is consumed, so status/ownership cannot be steered by the client.
export async function cancelRequirementHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return next(new AppError(401, 'UNAUTHORIZED', 'Authentication required'));
    }
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const result = await cancelRequirement(id, userId);
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

// REQ-05: read-only requirement browsing. Caller identity/role come from the
// session + DB; page/limit plus the supported filters (food_category, priority,
// status) are the only query values consumed. Role visibility (ADMIN all /
// RECIPIENT own+OPEN) is applied as a database predicate in the service.
export async function listRequirementsHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return next(new AppError(401, 'UNAUTHORIZED', 'Authentication required'));
    }
    const result = await listRequirements(userId, req.query as Record<string, unknown>);
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

// REQ-06: read-only requirement history. Identity + organization scope come
// from the session (RECIPIENT own organization / ADMIN all); only page/limit
// are consumed from the query. Matched-donation linkage is deferred to
// Phase 8 MATCH-* / D-06 — no Match data is read or exposed.
export async function getRequirementHistoryHandler(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return next(new AppError(401, 'UNAUTHORIZED', 'Authentication required'));
    }
    const result = await getRequirementHistory(userId, req.query as Record<string, unknown>);
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}
