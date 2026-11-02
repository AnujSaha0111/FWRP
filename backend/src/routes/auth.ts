import { Router } from 'express';
import {
  changePasswordHandler,
  forgotPasswordHandler,
  loginHandler,
  logoutHandler,
  refreshHandler,
  registerHandler,
  resetPasswordHandler,
} from '../controllers/auth.controller';
import { authenticate } from '../middleware/auth';
import { authRateLimits as limits } from '../middleware/rateLimit';
import { validateBody } from '../middleware/validate';
import { changePasswordSchema, loginSchema, registerSchema } from '../services/auth.service';
import { forgotPasswordSchema, resetPasswordSchema } from '../services/passwordReset.service';

// AUTH-01: registration. AUTH-02: login. AUTH-03: logout. AUTH-05: refresh.
// AUTH-06: self password change (D-13 fallback). Later tasks own reset-by-email/profile.
export const authRouter = Router();

authRouter.post('/register', limits.register, validateBody(registerSchema), registerHandler);

// SEC-01: login is rate limited per IP + email and per IP (middleware/rateLimit.ts).
authRouter.post('/login', limits.loginPerIp, limits.loginPerAccount, validateBody(loginSchema), loginHandler);

// AUTH-03 logout: cookie clear (stateless JWT per ADR 002 — no server
// session/blocklist table to invalidate). Idempotent by design: no auth
// middleware, no body validation, no database.
authRouter.post('/logout', logoutHandler);

// AUTH-05 refresh rotation: no body schema (cookie-or-optional-body token,
// validated inside the service); no auth middleware so expired access tokens
// do not block rotation.
authRouter.post('/refresh', limits.refresh, refreshHandler);

// AUTH-06 self change (D-13 fallback): owner comes from the session.
authRouter.post('/change-password', authenticate, validateBody(changePasswordSchema), changePasswordHandler);

// SEC-02: self-service password reset by email. Unauthenticated by design;
// rate limited per IP and per email address.
authRouter.post(
  '/forgot-password',
  limits.forgotPerIp,
  limits.forgotPerAccount,
  validateBody(forgotPasswordSchema),
  forgotPasswordHandler
);
authRouter.post('/reset-password', limits.resetPerIp, validateBody(resetPasswordSchema), resetPasswordHandler);
