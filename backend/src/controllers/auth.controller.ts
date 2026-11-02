import type { NextFunction, Request, Response } from 'express';
import {
  adminResetPassword,
  changePassword,
  issueSession,
  loginUser,
  refreshUser,
  registerUser,
} from '../services/auth.service';
import { requestPasswordReset, resetPassword } from '../services/passwordReset.service';
import { AppError } from '../middleware/error';
import { env, getExpiryThresholdMs } from '../config/env';

// AUTH-01: registration handler. The body was already validated/coerced by
// validateBody(registerSchema); the service re-validates for direct-call safety.
export async function registerHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await registerUser(req.body);
    res.status(201).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

// Canonical cookie strategy per ADR 002 / BE-07: httpOnly access_token
// (+ refresh_token for AUTH-03+ rotation). Secure only in production so local
// development over HTTP keeps working; Lax by default.
function setAuthCookies(res: Response, accessToken: string, refreshToken: string): void {
  const secure = env.NODE_ENV === 'production';
  res.cookie('access_token', accessToken, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    maxAge: getExpiryThresholdMs(env.JWT_ACCESS_EXPIRES_IN),
    path: '/',
  });
  res.cookie('refresh_token', refreshToken, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    maxAge: getExpiryThresholdMs(env.JWT_REFRESH_EXPIRES_IN),
    path: '/',
  });
}

// AUTH-02: login handler. Returns user + tokens in the body (for Bearer
// API clients) and sets the httpOnly cookies (for browser clients).
export async function loginHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await loginUser(req.body);
    setAuthCookies(res, result.accessToken, result.refreshToken);
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

const AUTH_COOKIE_NAMES = ['access_token', 'refresh_token'] as const;

// Clearing attributes must match the attributes used when setting, otherwise
// browsers keep the original cookies.
function clearAuthCookies(res: Response): void {
  const secure = env.NODE_ENV === 'production';
  for (const name of AUTH_COOKIE_NAMES) {
    res.clearCookie(name, { httpOnly: true, secure, sameSite: 'lax', path: '/' });
  }
}

// AUTH-03: logout handler. Stateless JWT has no server-side session to
// destroy, so logout = clearing both auth cookies (the "cookie clear"
// option). Deliberately unauthenticated: succeeds with missing, expired, or
// malformed tokens alike (idempotent). No database, no tokens issued.
export async function logoutHandler(_req: Request, res: Response, next: NextFunction) {
  try {
    clearAuthCookies(res);
    res.status(200).json({ success: true, data: { loggedOut: true } });
  } catch (err) {
    next(err);
  }
}

// AUTH-05: refresh handler. Refresh token from the httpOnly cookie (primary)
// or the JSON body (non-browser API clients); the service validates it.
// Rotation: both cookies are overwritten with the fresh pair.
export async function refreshHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const cookies = (req as unknown as { cookies?: Record<string, string> }).cookies;
    const token: unknown = cookies?.refresh_token ?? (req.body as Record<string, unknown> | undefined)?.refreshToken;
    const result = await refreshUser(token);
    setAuthCookies(res, result.accessToken, result.refreshToken);
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

// AUTH-06: self password change (D-13 fallback). Owner comes from the
// session, never from input, so users cannot change each other's passwords.
export async function changePasswordHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return next(new AppError(401, 'UNAUTHORIZED', 'Authentication required'));
    }
    const result = await changePassword(userId, req.body);
    // SEC-03: the change revoked all sessions; keep this device signed in.
    const session = await issueSession(userId);
    if (session) setAuthCookies(res, session.accessToken, session.refreshToken);
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

// AUTH-06: admin password reset fallback (D-13 fallback). requireRole('ADMIN')
// runs on the route; the target id comes from the path.
export async function adminResetHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const adminId = req.user?.id;
    if (!adminId) {
      return next(new AppError(401, 'UNAUTHORIZED', 'Authentication required'));
    }
    const result = await adminResetPassword(adminId, req.params.id, req.body);
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

// SEC-02: self-service password reset. The forgot answer is identical for
// known and unknown emails (202) so accounts cannot be enumerated.
export async function forgotPasswordHandler(req: Request, res: Response, next: NextFunction) {
  try {
    res.status(202).json({ success: true, data: await requestPasswordReset(req.body) });
  } catch (err) {
    next(err);
  }
}

export async function resetPasswordHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await resetPassword(req.body);
    // Any cookies on this browser belong to a revoked session.
    clearAuthCookies(res);
    res.status(200).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}
