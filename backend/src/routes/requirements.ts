import { Router } from 'express';
import { createRequirementHandler } from '../controllers/requirements.controller';
import { authenticate } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { validateBody } from '../middleware/validate';
import { createRequirementSchema } from '../services/requirements.service';

export const requirementRouter = Router();

requirementRouter.post(
  '/',
  authenticate,
  requireRole('RECIPIENT'),
  validateBody(createRequirementSchema),
  createRequirementHandler
);
