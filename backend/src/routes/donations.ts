import { Router } from 'express';
import {
  acceptDonationHandler,
  cancelDonationHandler,
  createDonationHandler,
  getDonationHandler,
  getDonationHistoryHandler,
  listDonationsHandler,
  overrideDonationHandler,
  updateDonationHandler,
} from '../controllers/donations.controller';
import { authenticate } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { validateBody } from '../middleware/validate';
import { adminOverrideSchema, createDonationSchema, updateDonationSchema } from '../services/donations.service';

export const donationRouter = Router();

donationRouter.post(
  '/',
  authenticate,
  requireRole('PROVIDER'),
  validateBody(createDonationSchema),
  createDonationHandler
);

donationRouter.get('/', authenticate, listDonationsHandler);

donationRouter.get('/history', authenticate, getDonationHistoryHandler);

donationRouter.get('/:id', authenticate, getDonationHandler);

donationRouter.put(
  '/:id',
  authenticate,
  requireRole('PROVIDER'),
  validateBody(updateDonationSchema),
  updateDonationHandler
);

donationRouter.post('/:id/cancel', authenticate, requireRole('PROVIDER'), cancelDonationHandler);

// DON-12: ADMIN-only override (ACCEPTED → CANCELLED | COMPLETED → AVAILABLE).
donationRouter.post(
  '/:id/override',
  authenticate,
  requireRole('ADMIN'),
  validateBody(adminOverrideSchema),
  overrideDonationHandler
);

donationRouter.post('/:id/accept', authenticate, requireRole('RECIPIENT'), acceptDonationHandler);
