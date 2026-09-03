import type { NextFunction, Request, Response } from 'express';
import { loginUser, registerUser } from '../services/auth.service';
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
