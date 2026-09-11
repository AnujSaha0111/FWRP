import { describe, it, expect, vi, afterEach } from 'vitest';
import { envSchema, parseEnv, validateEnvForProduction, isDatabaseConfigured, getExpiryThresholdMs, env } from '../config/env';

describe('BE-11 Config Loader — envSchema & helpers', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('valid required configuration loads successfully (defaults)', () => {
    const parsed = parseEnv({});
    expect(parsed.NODE_ENV).toBe('development');
    expect(parsed.PORT).toBe(3001);
    expect(parsed.DATABASE_URL).toBe('');
    expect(parsed.JWT_ACCESS_SECRET).toBe('dev-access-secret-change-me');
    expect(parsed.CORS_ORIGIN).toBe('http://localhost:5173');
  });

  it('valid custom configuration loads with overrides', () => {
    const parsed = parseEnv({
      NODE_ENV: 'test',
      PORT: '4000',
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/db?schema=public',
      JWT_ACCESS_SECRET: 'custom-secret-123',
      JWT_REFRESH_SECRET: 'refresh-secret-456',
      CORS_ORIGIN: 'http://example.com',
      LOG_LEVEL: 'debug',
    });
    expect(parsed.PORT).toBe(4000);
    expect(parsed.DATABASE_URL).toContain('postgresql://');
    expect(parsed.JWT_ACCESS_SECRET).toBe('custom-secret-123');
    expect(parsed.LOG_LEVEL).toBe('debug');
  });

  it('missing required configuration uses defaults (not rejected) for non-production required fields', () => {
    // envSchema has defaults for all required fields, so empty env should not throw
    expect(() => parseEnv({})).not.toThrow();
  });

  it('invalid PORT (out of range) is rejected', () => {
    expect(() => parseEnv({ PORT: '99999' })).toThrow(/Invalid environment variables/);
    expect(() => parseEnv({ PORT: '0' })).toThrow(/Invalid environment variables/);
    expect(() => parseEnv({ PORT: 'not-a-number' })).toThrow(/Invalid environment variables/);
  });

  it('invalid LOG_LEVEL is rejected', () => {
    expect(() => parseEnv({ LOG_LEVEL: 'verbose' })).toThrow(/Invalid environment variables/);
    expect(() => parseEnv({ LOG_LEVEL: '' })).toThrow(/Invalid environment variables/);
  });

  it('invalid NODE_ENV is rejected', () => {
    expect(() => parseEnv({ NODE_ENV: 'staging' })).toThrow(/Invalid environment variables/);
  });

  it('invalid SMTP_PORT is rejected', () => {
    expect(() => parseEnv({ SMTP_PORT: '99999' })).toThrow(/Invalid environment variables/);
  });

  it('production-specific validation: throws when DATABASE_URL missing in production', () => {
    const originalEnv = env.NODE_ENV;
    const originalUrl = env.DATABASE_URL;
    // Temporarily mutate env singleton for validateEnvForProduction
    (env as any).NODE_ENV = 'production';
    (env as any).DATABASE_URL = '';
    (env as any).JWT_ACCESS_SECRET = 'prod-secret';
    (env as any).JWT_REFRESH_SECRET = 'prod-refresh';
    try {
      expect(() => validateEnvForProduction()).toThrow(/Missing required env var: DATABASE_URL/);
    } finally {
      (env as any).NODE_ENV = originalEnv;
      (env as any).DATABASE_URL = originalUrl;
    }
  });

  it('production validation throws when DATABASE_URL is placeholder', () => {
    const originalEnv = env.NODE_ENV;
    const originalUrl = env.DATABASE_URL;
    (env as any).NODE_ENV = 'production';
    (env as any).DATABASE_URL = 'postgresql://USER:PASSWORD@HOST:5432/DATABASE?schema=public';
    (env as any).JWT_ACCESS_SECRET = 'prod-secret';
    (env as any).JWT_REFRESH_SECRET = 'prod-refresh';
    try {
      expect(() => validateEnvForProduction()).toThrow(/placeholder/);
    } finally {
      (env as any).NODE_ENV = originalEnv;
      (env as any).DATABASE_URL = originalUrl;
    }
  });

  it('production validation passes when all required are configured', () => {
    const originalEnv = env.NODE_ENV;
    const originalUrl = env.DATABASE_URL;
    (env as any).NODE_ENV = 'production';
    (env as any).DATABASE_URL = 'postgresql://user:pass@host:5432/db?schema=public';
    (env as any).JWT_ACCESS_SECRET = 'prod-secret';
    (env as any).JWT_REFRESH_SECRET = 'prod-refresh';
    try {
      expect(() => validateEnvForProduction()).not.toThrow();
    } finally {
      (env as any).NODE_ENV = originalEnv;
      (env as any).DATABASE_URL = originalUrl;
    }
  });

  it('production validation does not throw in non-production even if DATABASE_URL missing', () => {
    const originalEnv = env.NODE_ENV;
    (env as any).NODE_ENV = 'development';
    (env as any).DATABASE_URL = '';
    try {
      expect(() => validateEnvForProduction()).not.toThrow();
    } finally {
      (env as any).NODE_ENV = originalEnv;
    }
  });

  it('DATABASE_URL configured vs unconfigured', () => {
    const originalUrl = env.DATABASE_URL;
    (env as any).DATABASE_URL = '';
    expect(isDatabaseConfigured()).toBe(false);
    (env as any).DATABASE_URL = 'postgresql://USER:PASSWORD@HOST:5432/DATABASE?schema=public';
    expect(isDatabaseConfigured()).toBe(false);
    (env as any).DATABASE_URL = 'postgresql://user:pass@localhost:5432/db?schema=public';
    expect(isDatabaseConfigured()).toBe(true);
    (env as any).DATABASE_URL = originalUrl;
  });

  it('JWT config: empty JWT_ACCESS_SECRET is rejected', () => {
    expect(() => parseEnv({ JWT_ACCESS_SECRET: '' })).toThrow(/Invalid environment variables/);
  });

  it('JWT config: valid custom expiry strings parse correctly', () => {
    expect(parseEnv({ JWT_ACCESS_EXPIRES_IN: '30m' }).JWT_ACCESS_EXPIRES_IN).toBe('30m');
    expect(parseEnv({ JWT_REFRESH_EXPIRES_IN: '7d' }).JWT_REFRESH_EXPIRES_IN).toBe('7d');
  });

  it('getExpiryThresholdMs validates formats', () => {
    expect(getExpiryThresholdMs('15m')).toBe(15 * 60000);
    expect(getExpiryThresholdMs('7d')).toBe(7 * 86400000);
    expect(getExpiryThresholdMs('1000ms')).toBe(1000);
    expect(getExpiryThresholdMs('1h')).toBe(3600000);
    expect(() => getExpiryThresholdMs('invalid')).toThrow(/Invalid expiry format/);
    expect(() => getExpiryThresholdMs('15x')).toThrow(/Invalid expiry format/);
  });

  it('errors must not expose secrets/passwords', () => {
    const secret = 'super-secret-value-xyz';
    try {
      parseEnv({ PORT: '99999', JWT_ACCESS_SECRET: secret });
    } catch (e) {
      const msg = (e as Error).message;
      // Error should mention field but not echo secret in some cases; at least ensure PORT error doesn't leak secret
      // For this schema, PORT invalid will not include JWT secret; check that secret not in details when PORT fails
      expect(msg).not.toContain(secret);
    }
    // Production validation error should not leak secret value
    const originalEnv = env.NODE_ENV;
    const originalUrl = env.DATABASE_URL;
    (env as any).NODE_ENV = 'production';
    (env as any).DATABASE_URL = '';
    (env as any).JWT_ACCESS_SECRET = secret;
    try {
      validateEnvForProduction();
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).not.toContain(secret);
    } finally {
      (env as any).NODE_ENV = originalEnv;
      (env as any).DATABASE_URL = originalUrl;
    }
  });

  it('production validation error does not expose DATABASE_URL placeholder secret', () => {
    const originalEnv = env.NODE_ENV;
    const originalUrl = env.DATABASE_URL;
    (env as any).NODE_ENV = 'production';
    (env as any).DATABASE_URL = 'postgresql://USER:PASSWORD@HOST:5432/DATABASE?schema=public';
    try {
      expect(() => validateEnvForProduction()).toThrow();
      try {
        validateEnvForProduction();
      } catch (e) {
        const msg = (e as Error).message;
        // Should not contain password part literally? It will contain the placeholder check but not leak actual host password beyond what is already placeholder
        expect(msg).not.toContain('USER:PASSWORD');
      }
    } finally {
      (env as any).NODE_ENV = originalEnv;
      (env as any).DATABASE_URL = originalUrl;
    }
  });
});
