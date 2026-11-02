import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  DATABASE_URL: z.string().optional().default(''),
  JWT_ACCESS_SECRET: z.string().min(1).default('dev-access-secret-change-me'),
  JWT_REFRESH_SECRET: z.string().min(1).default('dev-refresh-secret-change-me'),
  JWT_ACCESS_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  SMTP_HOST: z.string().optional().default(''),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  SMTP_USER: z.string().optional().default(''),
  SMTP_PASS: z.string().optional().default(''),
  EMAIL_FROM: z.string().default('noreply@fwrp.local'),
  // MATCH-06: matching radius (km). Pairs farther apart are not recommended.
  MATCHING_MAX_DISTANCE_KM: z.coerce.number().positive().max(20000).default(50),
  // MATCH-11: scheduled re-scoring interval in minutes; 0 disables the job.
  MATCHING_REFRESH_INTERVAL_MINUTES: z.coerce.number().int().min(0).max(1440).default(15),
  // NOTIF-04/06: time-based alerts + email outbox interval in minutes; 0 disables.
  NOTIFICATION_JOB_INTERVAL_MINUTES: z.coerce.number().int().min(0).max(1440).default(1),
  // EXP-01: automatic expiry interval in minutes; 0 disables.
  EXPIRY_JOB_INTERVAL_MINUTES: z.coerce.number().int().min(0).max(1440).default(1),
  // SEC-01: auth rate limiting. Defaults to on, except under NODE_ENV=test.
  RATE_LIMIT_ENABLED: z.enum(['true', 'false']).optional(),
  // SEC-01: Express "trust proxy" hops, so req.ip is the client behind a load balancer (0 = direct).
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),
  // SEC-02: frontend origin used in password-reset links.
  APP_BASE_URL: z.string().url().default('http://localhost:5173'),
  // SEC-02: password-reset link lifetime in minutes.
  PASSWORD_RESET_TTL_MINUTES: z.coerce.number().int().min(5).max(1440).default(30),
});

type Env = Omit<z.infer<typeof envSchema>, 'RATE_LIMIT_ENABLED'> & { RATE_LIMIT_ENABLED: boolean };

export function parseEnv(overrides: Record<string, unknown> = process.env): Env {
  const parsed = envSchema.safeParse(overrides);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment variables: ${details}`);
  }
  return {
    ...parsed.data,
    RATE_LIMIT_ENABLED:
      parsed.data.RATE_LIMIT_ENABLED === undefined
        ? parsed.data.NODE_ENV !== 'test'
        : parsed.data.RATE_LIMIT_ENABLED === 'true',
  };
}

export const env: Env = parseEnv();

// Strict helpers for callers that need to enforce presence
function requireEnv(name: string, fallback?: string): string {
  const value = (env as Record<string, unknown>)[name] as string | undefined ?? fallback;
  if (value === undefined || value === '') {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

export function validateEnvForProduction(): void {
  if (env.NODE_ENV === 'production') {
    requireEnv('DATABASE_URL');
    requireEnv('JWT_ACCESS_SECRET');
    requireEnv('JWT_REFRESH_SECRET');
    if (env.DATABASE_URL.includes('USER:PASSWORD@HOST')) {
      throw new Error('DATABASE_URL is still placeholder in production');
    }
  }
}

export function isDatabaseConfigured(): boolean {
  return Boolean(env.DATABASE_URL) && !env.DATABASE_URL.includes('USER:PASSWORD@HOST');
}

export function getExpiryThresholdMs(value: string): number {
  const match = value.match(/^(\d+)(ms|s|m|h|d)$/);
  if (!match) throw new Error(`Invalid expiry format: ${value}`);
  const num = parseInt(match[1], 10);
  const unit = match[2];
  const mult: Record<string, number> = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 };
  return num * mult[unit];
}
