import { Router } from 'express';
import { acceptDonationHandler } from '../controllers/donations.controller';
import { authenticate } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';

// ORG-05: recipient-only acceptance with a server-side VERIFIED gate (the
// service re-checks role + organization status; never trusts client ids).
// All other donation workflows belong to Phase 6+; unmatched paths fall
// through to the central 404 handler.
export const donationRouter = Router();

donationRouter.post('/:id/accept', authenticate, requireRole('RECIPIENT'), acceptDonationHandler);
