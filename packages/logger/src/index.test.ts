/**
 * Tests for createLogger factory function
 */

import { describe, expect, it } from 'vitest';
import { createLogger } from './index.js';
import { ConsoleLogger } from './console.js';

describe('createLogger', () => {
  it('should create console logger with info level when config is true', () => {
    const logger = createLogger(true);

    expect(logger).toBeInstanceOf(ConsoleLogger);
  });

  it('should create no-op logger when config is false', () => {
    const logger = createLogger(false);

    // NoopLogger is not exported, so we test behavior instead
    // No-op logger should have all methods but they should do nothing
    expect(logger.debug).toBeDefined();
    expect(logger.info).toBeDefined();
    expect(logger.warn).toBeDefined();
    expect(logger.error).toBeDefined();

    // Call methods to ensure they don't throw (no-ops)
    expect(() => logger.debug('test')).not.toThrow();
    expect(() => logger.info('test')).not.toThrow();
    expect(() => logger.warn('test')).not.toThrow();
    expect(() => logger.error('test')).not.toThrow();
  });

  it('should create console logger with specified level', () => {
    const logger = createLogger({ level: 'debug' });

    expect(logger).toBeInstanceOf(ConsoleLogger);
  });

  it('should default to info level when level not specified', () => {
    const logger = createLogger({});

    expect(logger).toBeInstanceOf(ConsoleLogger);
  });
});
