import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../middleware/error';
import {
  assignDelivery,
  confirmHandover,
  confirmReceipt,
  getDelivery,
  listDeliveries,
  listPendingAssignments,
  reassignDelivery,
  respondToAssignment,
  updateDeliveryStatus,
} from '../services/delivery.service';
import {
  addAvailability,
  deleteAvailability,
  listAvailableVolunteers,
  listMyAvailability,
} from '../services/volunteers.service';

// LOG-01..LOG-07, DELCONF-01..03: thin handlers. Identity always comes from the
// session; role scope, ownership and state guards are enforced in the services.

function sessionUserId(req: Request): string {
  const userId = req.user?.id;
  if (!userId) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  return userId;
}

function param(req: Request, name: string): string {
  const value = req.params[name];
  return Array.isArray(value) ? value[0] : value;
}

type Handler = (req: Request) => Promise<unknown>;

function handle(fn: Handler, status = 200) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.status(status).json({ success: true, data: await fn(req) });
    } catch (err) {
      next(err);
    }
  };
}

export const listDeliveriesHandler = handle((req) => listDeliveries(sessionUserId(req), req.query));
export const pendingAssignmentsHandler = handle((req) => listPendingAssignments(sessionUserId(req)));
export const getDeliveryHandler = handle((req) => getDelivery(sessionUserId(req), param(req, 'id')));
export const assignDeliveryHandler = handle((req) => assignDelivery(sessionUserId(req), req.body), 201);
export const reassignDeliveryHandler = handle((req) =>
  reassignDelivery(sessionUserId(req), param(req, 'id'), req.body)
);
export const respondToAssignmentHandler = handle((req) =>
  respondToAssignment(sessionUserId(req), param(req, 'id'), req.body)
);
export const updateDeliveryStatusHandler = handle((req) =>
  updateDeliveryStatus(sessionUserId(req), param(req, 'id'), req.body)
);
export const confirmHandoverHandler = handle((req) => confirmHandover(sessionUserId(req), param(req, 'id')));
export const confirmReceiptHandler = handle((req) =>
  confirmReceipt(sessionUserId(req), param(req, 'id'), req.body)
);

export const listMyAvailabilityHandler = handle(async (req) => ({
  windows: await listMyAvailability(sessionUserId(req)),
}));
export const addAvailabilityHandler = handle((req) => addAvailability(sessionUserId(req), req.body), 201);
export const deleteAvailabilityHandler = handle((req) => deleteAvailability(sessionUserId(req), param(req, 'id')));
export const availableVolunteersHandler = handle((req) => listAvailableVolunteers(sessionUserId(req), req.query));
