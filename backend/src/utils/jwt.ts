import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import type { AuthUser } from '../types/express';

export type JwtPayload = AuthUser;

export function signAccessToken(payload: Omit<AuthUser, 'iat' | 'exp'>, expiresIn?: string): string {
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, {
    algorithm: 'HS256',
    expiresIn: expiresIn ?? env.JWT_ACCESS_EXPIRES_IN,
  } as jwt.SignOptions);
}

export function signRefreshToken(payload: Omit<AuthUser, 'iat' | 'exp'>, expiresIn?: string): string {
  return jwt.sign(payload, env.JWT_REFRESH_SECRET, {
    algorithm: 'HS256',
    expiresIn: expiresIn ?? env.JWT_REFRESH_EXPIRES_IN,
  } as jwt.SignOptions);
}

export function verifyAccessToken(token: string): JwtPayload {
  return jwt.verify(token, env.JWT_ACCESS_SECRET, { algorithms: ['HS256'] }) as JwtPayload;
}

export function verifyRefreshToken(token: string): JwtPayload {
  return jwt.verify(token, env.JWT_REFRESH_SECRET, { algorithms: ['HS256'] }) as JwtPayload;
}
