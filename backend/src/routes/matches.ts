import { Router } from 'express';
import {
  acceptMatchHandler,
  getMatchHandler,
  listMatchesHandler,
  refreshDonationMatchesHandler,
  refreshRequirementMatchesHandler,
  rejectMatchHandler,
} from '../controllers/matches.controller';
import { authenticate } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { validateQuery } from '../middleware/validate';
import { listMatchesQuerySchema } from '../services/matching.service';

// MATCH-07: ranked recommendations (ADMIN all / PROVIDER own donations /
// RECIPIENT own organization's requirements; scope decided in the service).
// MATCH-08: single match. MATCH-09: recipient rejection. MATCH-10: owner- or
// admin-triggered regeneration. MATCH-11: scheduled refresh (jobs/). ACCEPT-01:
// recipient acceptance of a recommendation (allocation + Donation ACCEPTED, one
// transaction). Generation also runs automatically after donation/requirement
// create, edit and cancel. The BE-04 placeholder is retired.
export const matchRouter = Router();

matchRouter.get(
  '/',
  authenticate,
  requireRole('ADMIN', 'PROVIDER', 'RECIPIENT'),
  validateQuery(listMatchesQuerySchema),
  listMatchesHandler
);

matchRouter.post(
  '/donations/:donationId/refresh',
  authenticate,
  requireRole('ADMIN', 'PROVIDER'),
  refreshDonationMatchesHandler
);

matchRouter.post(
  '/requirements/:requirementId/refresh',
  authenticate,
  requireRole('ADMIN', 'RECIPIENT'),
  refreshRequirementMatchesHandler
);

matchRouter.get('/:id', authenticate, requireRole('ADMIN', 'PROVIDER', 'RECIPIENT'), getMatchHandler);

matchRouter.post('/:id/reject', authenticate, requireRole('ADMIN', 'RECIPIENT'), rejectMatchHandler);

matchRouter.post('/:id/accept', authenticate, requireRole('RECIPIENT'), acceptMatchHandler);
