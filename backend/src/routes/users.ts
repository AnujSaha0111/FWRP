import { Router } from 'express';
import { getMeHandler, updateMeHandler } from '../controllers/users.controller';
import { authenticate } from '../middleware/auth';
import { validateBody } from '../middleware/validate';
import { updateProfileSchema } from '../services/users.service';

// AUTH-08: self profile only. Email/role/status changes are rejected by the
// strict update schema (no privilege escalation, no unverified email change).
export const usersRouter = Router();

usersRouter.get('/me', authenticate, getMeHandler);
usersRouter.put('/me', authenticate, validateBody(updateProfileSchema), updateMeHandler);
