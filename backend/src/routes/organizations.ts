import { Router } from 'express';
import { getMyOrganizationHandler, updateMyOrganizationHandler } from '../controllers/organizations.controller';
import { authenticate } from '../middleware/auth';
import { validateBody } from '../middleware/validate';
import { updateOrganizationSchema } from '../services/organizations.service';

// AUTH-09: self-organization read/update. No :id parameter exists on these
// routes by design — the target org always comes from the session, so callers
// cannot address another organization's record.
export const organizationsRouter = Router();

organizationsRouter.get('/me', authenticate, getMyOrganizationHandler);
organizationsRouter.put('/me', authenticate, validateBody(updateOrganizationSchema), updateMyOrganizationHandler);
