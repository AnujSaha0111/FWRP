import { Router, type NextFunction, type Request, type Response } from 'express';
import { AppError } from '../middleware/error';
import { authenticate } from '../middleware/auth';
import { validateBody, validateQuery } from '../middleware/validate';
import {
  createIncident,
  createIncidentSchema,
  getIncident,
  listIncidentsQuerySchema,
  listMyIncidents,
} from '../services/incidents.service';

// ADMIN-03: any signed-in user files account reports and disputes and follows
// their own; administrators work them through /api/admin/incidents.
export const incidentsRouter = Router();

function userId(req: Request): string {
  const id = req.user?.id;
  if (!id) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  return id;
}

function handle(fn: (req: Request) => Promise<unknown>, status = 200) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.status(status).json({ success: true, data: await fn(req) });
    } catch (err) {
      next(err);
    }
  };
}

incidentsRouter.post('/', authenticate, validateBody(createIncidentSchema), handle((req) => createIncident(userId(req), req.body), 201));

incidentsRouter.get(
  '/',
  authenticate,
  validateQuery(listIncidentsQuerySchema),
  handle((req) => listMyIncidents(userId(req), req.query))
);

incidentsRouter.get(
  '/:id',
  authenticate,
  handle((req) => {
    const value = req.params.id;
    return getIncident(userId(req), Array.isArray(value) ? value[0] : value);
  })
);
