import { Router, type NextFunction, type Request, type Response } from 'express';
import { AppError } from '../middleware/error';
import { authenticate } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { validateQuery } from '../middleware/validate';
import {
  dashboardQuerySchema,
  getDashboard,
  getImpact,
  getReport,
  impactQuerySchema,
  reportQuerySchema,
} from '../services/analytics.service';

// ANALYTICS-02: role dashboard (every role sees its own scope). ANALYTICS-03:
// platform impact metrics (ADMIN). ANALYTICS-04/05: admin reports, JSON or CSV
// download. Read-only. The BE-04 placeholder is retired.
export const analyticsRouter = Router();

function userId(req: Request): string {
  const id = req.user?.id;
  if (!id) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  return id;
}

analyticsRouter.get(
  '/dashboard',
  authenticate,
  validateQuery(dashboardQuerySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.status(200).json({ success: true, data: await getDashboard(userId(req), req.query) });
    } catch (err) {
      next(err);
    }
  }
);

analyticsRouter.get(
  '/impact',
  authenticate,
  requireRole('ADMIN'),
  validateQuery(impactQuerySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.status(200).json({ success: true, data: await getImpact(userId(req), req.query) });
    } catch (err) {
      next(err);
    }
  }
);

analyticsRouter.get(
  '/reports',
  authenticate,
  requireRole('ADMIN'),
  validateQuery(reportQuerySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await getReport(userId(req), req.query);
      if (result.format === 'csv') {
        res
          .status(200)
          .type('text/csv; charset=utf-8')
          .attachment(result.filename)
          .send(result.csv);
        return;
      }
      res.status(200).json({ success: true, data: result.report });
    } catch (err) {
      next(err);
    }
  }
);
