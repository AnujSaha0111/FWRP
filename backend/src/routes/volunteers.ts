import { Router } from 'express';
import {
  addAvailabilityHandler,
  availableVolunteersHandler,
  deleteAvailabilityHandler,
  listMyAvailabilityHandler,
} from '../controllers/deliveries.controller';
import { authenticate } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { validateBody, validateQuery } from '../middleware/validate';
import { availableVolunteersQuerySchema, createAvailabilitySchema } from '../services/volunteers.service';

// LOG-01: volunteer availability (self only — the volunteer comes from the
// session) and the ADMIN lookup of free volunteers for a donation pickup.
export const volunteersRouter = Router();

volunteersRouter.get('/me/availability', authenticate, requireRole('VOLUNTEER'), listMyAvailabilityHandler);

volunteersRouter.post(
  '/me/availability',
  authenticate,
  requireRole('VOLUNTEER'),
  validateBody(createAvailabilitySchema),
  addAvailabilityHandler
);

volunteersRouter.delete('/me/availability/:id', authenticate, requireRole('VOLUNTEER'), deleteAvailabilityHandler);

volunteersRouter.get(
  '/available',
  authenticate,
  requireRole('ADMIN'),
  validateQuery(availableVolunteersQuerySchema),
  availableVolunteersHandler
);
