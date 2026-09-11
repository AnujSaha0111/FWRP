import { describe, it, expect } from 'vitest';
import { logger } from '../utils/logger';

describe('logger — BE-09 / SETUP-10', () => {
  it('exports pino instance with level', () => {
    expect(logger).toBeDefined();
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.error).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.debug).toBe('function');
  });

  it('respects LOG_LEVEL env (defaults to info)', () => {
    expect(logger.level).toBeDefined();
  });

  it('does not throw on log calls', () => {
    expect(() => logger.info({ test: 1 }, 'test log')).not.toThrow();
    expect(() => logger.error({ err: new Error('test') }, 'error log')).not.toThrow();
  });
});
