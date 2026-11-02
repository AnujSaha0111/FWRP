import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { AppError } from '../middleware/error';
import { authenticate } from '../middleware/auth';
import { validateQuery } from '../middleware/validate';
import {
  getNotification,
  listNotifications,
  markAllAsRead,
  markAsRead,
  unreadCount,
} from '../services/notification.service';

// NOTIF-01: self-scoped notification inbox. The owner always comes from the
// session; every service call filters by userId, so other users' ids answer
// 404. No create/delete over HTTP: notifications are produced by business
// events. The BE-04 placeholder is retired.
export const notificationRouter = Router();

export const listNotificationsQuerySchema = z
  .object({
    unread: z.enum(['true', 'false']).optional(),
    page: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();

function userId(req: Request): string {
  const id = req.user?.id;
  if (!id) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  return id;
}

function param(req: Request): string {
  const value = req.params.id;
  return Array.isArray(value) ? value[0] : value;
}

function handle(fn: (req: Request) => Promise<unknown>) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.status(200).json({ success: true, data: await fn(req) });
    } catch (err) {
      next(err);
    }
  };
}

notificationRouter.get(
  '/',
  authenticate,
  validateQuery(listNotificationsQuerySchema),
  handle((req) => {
    const q = req.query as z.infer<typeof listNotificationsQuerySchema>;
    return listNotifications(userId(req), { page: q.page, limit: q.limit, unreadOnly: q.unread === 'true' });
  })
);

// Registered before /:id so these paths are never parsed as notification ids.
notificationRouter.get(
  '/unread-count',
  authenticate,
  handle(async (req) => ({ count: await unreadCount(userId(req)) }))
);

notificationRouter.post('/read-all', authenticate, handle((req) => markAllAsRead(userId(req))));

notificationRouter.get(
  '/:id',
  authenticate,
  handle(async (req) => ({ notification: await getNotification(param(req), userId(req)) }))
);

notificationRouter.post(
  '/:id/read',
  authenticate,
  handle(async (req) => ({ notification: await markAsRead(param(req), userId(req)) }))
);
