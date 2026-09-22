import { Router } from 'express';
import {
  cancelRequirementHandler,
  createRequirementHandler,
  getRequirementHistoryHandler,
  listRequirementsHandler,
  updateRequirementHandler,
} from '../controllers/requirements.controller';
import { authenticate } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { validateBody } from '../middleware/validate';
import { createRequirementSchema, updateRequirementSchema } from '../services/requirements.service';

// REQ-01: recipient-only requirement creation (verified organization enforced
// in the service). REQ-02: owner-organization editing (OPEN/PARTIALLY_FULFILLED
// only, enforced in the service). REQ-05: authenticated read-only browsing
// (ADMIN all / RECIPIENT own+OPEN; the service decides role visibility).
// REQ-06: authenticated read-only history (RECIPIENT own organization /
// ADMIN all; the service decides scope). REQ-07: owner-organization
// cancellation via POST /:id/cancel (RECIPIENT only; the service re-checks the
// persisted organization and the REQ-04 lifecycle guard). Expiry/fulfillment
// automation belong to later tasks; unmatched paths fall through to the central
// 404 handler (the BE-04 placeholder was retired when the first live
// requirement endpoint arrived).
export const requirementRouter = Router();

requirementRouter.post(
  '/',
  authenticate,
  requireRole('RECIPIENT'),
  validateBody(createRequirementSchema),
  createRequirementHandler
);

// REQ-06: history is registered before the browse route (and before any future
// GET /:id) so `/history` is never parsed as a requirement id.
requirementRouter.get('/history', authenticate, getRequirementHistoryHandler);

requirementRouter.get('/', authenticate, listRequirementsHandler);

requirementRouter.put(
  '/:id',
  authenticate,
  requireRole('RECIPIENT'),
  validateBody(updateRequirementSchema),
  updateRequirementHandler
);

// REQ-07: owner-organization cancellation. Action-style transition endpoint
// matching the project's POST /:id/<action> convention; no body is consumed and
// the target status is fixed server-side. `requireRole` is defense-in-depth —
// the service re-checks role + persisted ownership + the REQ-04 guard.
requirementRouter.post('/:id/cancel', authenticate, requireRole('RECIPIENT'), cancelRequirementHandler);

