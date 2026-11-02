import { Router, type NextFunction, type Request, type Response } from 'express';
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
import { AppError } from '../middleware/error';
import {
  auditLogQuerySchema,
  getMonitoring,
  getUser,
  listUsers,
  listUsersQuerySchema,
  searchAuditLogs,
  updateUserStatus,
  updateUserStatusSchema,
} from '../services/admin.service';
import {
  adminListIncidents,
  adminUpdateIncident,
  getIncident,
  listIncidentsQuerySchema,
  updateIncidentSchema,
} from '../services/incidents.service';
import { listSettings, updateSettings, updateSettingsSchema } from '../services/settings.service';

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

// ---------------------------------------------------------------------------
// ADMIN-01..05: user management, monitoring, incidents, settings, audit search.
// Every service re-checks that the caller is an active ADMIN.

function adminId(req: Request): string {
  const id = req.user?.id;
  if (!id) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
  return id;
}

function idParam(req: Request): string {
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

const admin = [authenticate, requireRole('ADMIN')] as const;

adminRouter.get('/users', ...admin, validateQuery(listUsersQuerySchema), handle((req) => listUsers(adminId(req), req.query)));
adminRouter.get('/users/:id', ...admin, handle((req) => getUser(adminId(req), idParam(req))));
adminRouter.put(
  '/users/:id/status',
  ...admin,
  validateBody(updateUserStatusSchema),
  handle((req) => updateUserStatus(adminId(req), idParam(req), req.body))
);

adminRouter.get('/monitoring', ...admin, handle((req) => getMonitoring(adminId(req))));

adminRouter.get(
  '/audit-logs',
  ...admin,
  validateQuery(auditLogQuerySchema),
  handle((req) => searchAuditLogs(adminId(req), req.query))
);

adminRouter.get(
  '/incidents',
  ...admin,
  validateQuery(listIncidentsQuerySchema),
  handle((req) => adminListIncidents(adminId(req), req.query))
);
adminRouter.get('/incidents/:id', ...admin, handle((req) => getIncident(adminId(req), idParam(req))));
adminRouter.put(
  '/incidents/:id',
  ...admin,
  validateBody(updateIncidentSchema),
  handle((req) => adminUpdateIncident(adminId(req), idParam(req), req.body))
);

adminRouter.get('/settings', ...admin, handle((req) => listSettings(adminId(req))));
adminRouter.put(
  '/settings',
  ...admin,
  validateBody(updateSettingsSchema),
  handle((req) => updateSettings(adminId(req), req.body))
);
