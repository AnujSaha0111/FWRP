import type { Request, Response, NextFunction } from 'express';
import { AppError } from './error';
import { env } from '../config/env';
import jwt from 'jsonwebtoken';
import type { AuthUser } from '../types/express';

const ALLOWED_ROLES = new Set<string>(['PROVIDER', 'RECIPIENT', 'VOLUNTEER', 'ADMIN']);

// Exported for AUTH-05 refresh rotation so claim rules live in exactly one place.
export function validateAuthClaims(decoded: unknown): decoded is AuthUser {
  if (typeof decoded !== 'object' || decoded === null) return false;
  const d = decoded as Record<string, unknown>;
  if (typeof d.id !== 'string' || d.id.trim() === '') return false;
  if (typeof d.email !== 'string' || d.email.trim() === '') return false;
  if (typeof d.role !== 'string' || !ALLOWED_ROLES.has(d.role)) return false;
  if (d.organizationId !== undefined && d.organizationId !== null && typeof d.organizationId !== 'string') return false;
  if (d.iat !== undefined && typeof d.iat !== 'number') return false;
  if (d.exp !== undefined && typeof d.exp !== 'number') return false;
  return true;
}

function extractToken(req: Request): string | null {
  // 1. httpOnly cookie (canonical per ADR 002)
  const cookies = (req as unknown as { cookies?: Record<string, string> }).cookies;
  if (cookies) {
    if (cookies.access_token) return cookies.access_token;
    if (cookies.accessToken) return cookies.accessToken;
  }
  // Raw Cookie header fallback (if cookie-parser not applied)
  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    const match = cookieHeader.match(/(?:access_token|accessToken)=([^;]+)/);
    if (match) return decodeURIComponent(match[1]);
  }
  // 2. Authorization: Bearer fallback (for API testing per ADR 002)
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }
  return null;
}

export function authenticate(req: Request, _res: Response, next: NextFunction): void {
  const token = extractToken(req);
  if (!token) {
    return next(new AppError(401, 'UNAUTHORIZED', 'Authentication required'));
  }

  // Basic malformed check: JWT must have 3 parts
  if (token.split('.').length !== 3) {
    return next(new AppError(401, 'UNAUTHORIZED', 'Invalid token'));
  }

  try {
    const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET, { algorithms: ['HS256'] }) as AuthUser;
    if (!validateAuthClaims(decoded)) {
      return next(new AppError(401, 'UNAUTHORIZED', 'Invalid token payload'));
    }
    req.user = decoded;
    next();
  } catch (err) {
    const jwtErr = err as jwt.JsonWebTokenError | jwt.TokenExpiredError;
    if (jwtErr.name === 'TokenExpiredError') {
      return next(new AppError(401, 'UNAUTHORIZED', 'Token expired'));
    }
    if (jwtErr.name === 'JsonWebTokenError') {
      return next(new AppError(401, 'UNAUTHORIZED', 'Invalid token'));
    }
    // Do not leak token or secret in error
    return next(new AppError(401, 'UNAUTHORIZED', 'Authentication failed'));
  }
}

// Optional variant that does not throw 401 — attaches user if present
export function optionalAuthenticate(req: Request, _res: Response, next: NextFunction): void {
  const token = extractToken(req);
  if (!token) {
    next();
    return;
  }
  try {
    const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET, { algorithms: ['HS256'] }) as AuthUser;
    if (validateAuthClaims(decoded)) {
      req.user = decoded;
    }
    next();
  } catch {
    next();
  }
}
