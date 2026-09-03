import { Router } from 'express';
import { loginHandler, logoutHandler, registerHandler } from '../controllers/auth.controller';
import { validateBody } from '../middleware/validate';
import { loginSchema, registerSchema } from '../services/auth.service';

// AUTH-01: registration. AUTH-02: login. AUTH-03: logout.
// Later tasks own refresh rotation/reset/profile.
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
