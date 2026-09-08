import { Router } from 'express';
import { changePasswordHandler, loginHandler, logoutHandler, refreshHandler, registerHandler } from '../controllers/auth.controller';
import { authenticate } from '../middleware/auth';
import { validateBody } from '../middleware/validate';
import { changePasswordSchema, loginSchema, registerSchema } from '../services/auth.service';

// AUTH-01: registration. AUTH-02: login. AUTH-03: logout. AUTH-05: refresh.
// AUTH-06: self password change (D-13 fallback). Later tasks own reset-by-email/profile.
export const authRouter = Router();

authRouter.post('/register', validateBody(registerSchema), registerHandler);

// NOTE (rate-limit consideration, part of AUTH-02): production deployments
// should rate-limit POST /login (e.g., express-rate-limit at a few attempts
// per minute per IP) to slow credential stuffing. Not bundled here, to keep
// the auth surface minimal and dependency-free until Phase 4 review.
authRouter.post('/login', validateBody(loginSchema), loginHandler);

// AUTH-03 logout: cookie clear (stateless JWT per ADR 002 — no server
// session/blocklist table to invalidate). Idempotent by design: no auth
// middleware, no body validation, no database.
authRouter.post('/logout', logoutHandler);

// AUTH-05 refresh rotation: no body schema (cookie-or-optional-body token,
// validated inside the service); no auth middleware so expired access tokens
// do not block rotation.
authRouter.post('/refresh', refreshHandler);

// AUTH-06 self change (D-13 fallback): owner comes from the session.
authRouter.post('/change-password', authenticate, validateBody(changePasswordSchema), changePasswordHandler);
