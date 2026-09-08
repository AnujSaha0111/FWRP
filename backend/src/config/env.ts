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
});

type Env = z.infer<typeof envSchema>;

export function parseEnv(overrides: Record<string, unknown> = process.env): Env {
  const parsed = envSchema.safeParse(overrides);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment variables: ${details}`);
  }
  return parsed.data;
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
