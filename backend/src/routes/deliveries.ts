import { Router } from 'express';
import {
  assignDeliveryHandler,
  confirmHandoverHandler,
  confirmReceiptHandler,
  getDeliveryHandler,
  listDeliveriesHandler,
  pendingAssignmentsHandler,
  reassignDeliveryHandler,
  respondToAssignmentHandler,
  updateDeliveryStatusHandler,
} from '../controllers/deliveries.controller';
import { authenticate } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { validateBody, validateQuery } from '../middleware/validate';
import {
  assignDeliverySchema,
  confirmReceiptSchema,
  listDeliveriesQuerySchema,
  reassignDeliverySchema,
  respondToAssignmentSchema,
  updateDeliveryStatusSchema,
} from '../services/delivery.service';

// LOG-03..LOG-07, DELCONF-01..03 (PRD §7.1-7.4, §8, FR-12..FR-15). Reads are
// role-scoped in the service (ADMIN all / VOLUNTEER own / PROVIDER own
// donations / RECIPIENT own organization). `requireRole` is defense-in-depth;
// the service re-checks role, ownership and the delivery state machine. The
// BE-04 placeholder is retired.
export const deliveryRouter = Router();

deliveryRouter.get('/', authenticate, validateQuery(listDeliveriesQuerySchema), listDeliveriesHandler);

// Registered before /:id so `pending` is never parsed as a delivery id.
deliveryRouter.get('/pending', authenticate, requireRole('ADMIN'), pendingAssignmentsHandler);

deliveryRouter.post('/', authenticate, requireRole('ADMIN'), validateBody(assignDeliverySchema), assignDeliveryHandler);

deliveryRouter.get('/:id', authenticate, getDeliveryHandler);

deliveryRouter.post(
  '/:id/reassign',
  authenticate,
  requireRole('ADMIN'),
  validateBody(reassignDeliverySchema),
  reassignDeliveryHandler
);

deliveryRouter.post(
  '/:id/respond',
  authenticate,
  requireRole('VOLUNTEER'),
  validateBody(respondToAssignmentSchema),
  respondToAssignmentHandler
);

deliveryRouter.post(
  '/:id/status',
  authenticate,
  requireRole('VOLUNTEER'),
  validateBody(updateDeliveryStatusSchema),
  updateDeliveryStatusHandler
);

deliveryRouter.post('/:id/handover', authenticate, requireRole('PROVIDER'), confirmHandoverHandler);

deliveryRouter.post(
  '/:id/confirm',
  authenticate,
  requireRole('RECIPIENT'),
  validateBody(confirmReceiptSchema),
  confirmReceiptHandler
);
