import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env';
import { AppError } from './error';

// SEC-01: fixed-window rate limiter for the auth surface (credential stuffing,
// reset-email abuse). In-memory, so limits apply per server instance; a shared
// store (e.g. Redis) is needed when running several instances.
//
// Disabled when RATE_LIMIT_ENABLED=false (default in NODE_ENV=test so route
// tests can log in repeatedly); the limiter itself is unit-tested directly.

export interface RateLimitOptions {
  /** Shown in logs and part of the bucket key, so limiters never share counters. */
  name: string;
  windowMs: number;
  max: number;
  /** Bucket key; return null to skip limiting this request. Defaults to the client IP. */
  key?: (req: Request) => string | null;
  enabled?: boolean;
  now?: () => number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

const MAX_BUCKETS = 50_000;

export function rateLimit(options: RateLimitOptions) {
  const buckets = new Map<string, Bucket>();
  const now = options.now ?? Date.now;
  const keyOf = options.key ?? ((req: Request) => req.ip ?? 'unknown');
  const enabled = options.enabled ?? env.RATE_LIMIT_ENABLED;

  function prune(t: number): void {
    for (const [k, b] of buckets) if (b.resetAt <= t) buckets.delete(k);
    // Under a flood of distinct keys, drop the oldest half rather than grow unbounded.
    if (buckets.size > MAX_BUCKETS) {
      let drop = Math.floor(buckets.size / 2);
      for (const k of buckets.keys()) {
        if (drop-- <= 0) break;
        buckets.delete(k);
      }
    }
  }

  const middleware = (req: Request, res: Response, next: NextFunction): void => {
    if (!enabled) return next();
    const raw = keyOf(req);
    if (raw === null) return next();
    const key = `${options.name}:${raw}`;
    const t = now();
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= t) {
      if (buckets.size >= MAX_BUCKETS) prune(t);
      bucket = { count: 0, resetAt: t + options.windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    res.setHeader('RateLimit-Limit', String(options.max));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, options.max - bucket.count)));
    if (bucket.count > options.max) {
      const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - t) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      return next(new AppError(429, 'RATE_LIMITED', 'Too many requests, please try again later'));
    }
    next();
  };
  return Object.assign(middleware, { reset: () => buckets.clear() });
}

/** Key by client IP + the (normalized) email in the body, for per-account limits. */
export function ipAndEmailKey(req: Request): string | null {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  return email ? `${req.ip ?? 'unknown'}|${email}` : null;
}

/** Key by the (normalized) email alone: caps reset emails per account across IPs. */
export function emailKey(req: Request): string | null {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  return email || null;
}

const MIN = 60 * 1000;

// SEC-01 limits (per instance).
export const authRateLimits = {
  loginPerAccount: rateLimit({ name: 'login-account', windowMs: 15 * MIN, max: 10, key: ipAndEmailKey }),
  loginPerIp: rateLimit({ name: 'login-ip', windowMs: 15 * MIN, max: 50 }),
  register: rateLimit({ name: 'register', windowMs: 60 * MIN, max: 20 }),
  refresh: rateLimit({ name: 'refresh', windowMs: 15 * MIN, max: 120 }),
  forgotPerIp: rateLimit({ name: 'forgot-ip', windowMs: 15 * MIN, max: 10 }),
  forgotPerAccount: rateLimit({ name: 'forgot-account', windowMs: 60 * MIN, max: 3, key: emailKey }),
  resetPerIp: rateLimit({ name: 'reset-ip', windowMs: 15 * MIN, max: 20 }),
};
