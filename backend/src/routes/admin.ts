import { Router } from 'express';
import { adminResetHandler } from '../controllers/auth.controller';
import {
  adminListOrganizationsHandler,
  adminReviewOrganizationHandler,
  adminVerifyOrganizationHandler,
} from '../controllers/organizations.controller';
import { authenticate } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { validateBody, validateQuery } from '../middleware/validate';
import { adminResetSchema } from '../services/auth.service';
import { listOrganizationsQuerySchema, verifyOrganizationSchema } from '../services/organizations.service';

// AUTH-06 admin password-reset fallback (D-13 option B) + ORG-02 admin
// verification workflow. Other admin workflows (Phase 5 verification UI
// backend beyond this, Phase 16 hardening) arrive later.
export const adminRouter = Router();

adminRouter.put(
  '/users/:id/password',
  authenticate,
  requireRole('ADMIN'),
  validateBody(adminResetSchema),
  adminResetHandler,
);

adminRouter.get(
  '/organizations',
  authenticate,
  requireRole('ADMIN'),
  validateQuery(listOrganizationsQuerySchema),
  adminListOrganizationsHandler,
);

adminRouter.put(
  '/organizations/:id/review',
  authenticate,
  requireRole('ADMIN'),
  adminReviewOrganizationHandler,
);

adminRouter.put(
  '/organizations/:id/verify',
  authenticate,
  requireRole('ADMIN'),
  validateBody(verifyOrganizationSchema),
  adminVerifyOrganizationHandler,
);
