/**
 * Tests for ConsoleLogger
 */

import { describe, expect, it, beforeEach, vi } from 'vitest';
import { ConsoleLogger } from './console.js';

describe('ConsoleLogger', () => {
  beforeEach(() => {
    // Spy on console methods
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('should log at info level by default', () => {
    const logger = new ConsoleLogger();

    logger.debug('debug message');
    logger.info('info message');
    logger.warn('warn message');
    logger.error('error message');

    expect(console.debug).not.toHaveBeenCalled();
    expect(console.info).toHaveBeenCalledWith('[INFO] info message');
    expect(console.warn).toHaveBeenCalledWith('[WARN] warn message');
    expect(console.error).toHaveBeenCalledWith('[ERROR] error message');
  });

  it('should log at debug level when configured', () => {
    const logger = new ConsoleLogger('debug');

    logger.debug('debug message');
    logger.info('info message');

    expect(console.debug).toHaveBeenCalledWith('[DEBUG] debug message');
    expect(console.info).toHaveBeenCalledWith('[INFO] info message');
  });

  it('should log at warn level when configured', () => {
    const logger = new ConsoleLogger('warn');

    logger.debug('debug message');
    logger.info('info message');
    logger.warn('warn message');
    logger.error('error message');

    expect(console.debug).not.toHaveBeenCalled();
    expect(console.info).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith('[WARN] warn message');
    expect(console.error).toHaveBeenCalledWith('[ERROR] error message');
  });

  it('should log at error level when configured', () => {
    const logger = new ConsoleLogger('error');

    logger.debug('debug message');
    logger.info('info message');
    logger.warn('warn message');
    logger.error('error message');

    expect(console.debug).not.toHaveBeenCalled();
    expect(console.info).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith('[ERROR] error message');
  });

  it('should include context in log output', () => {
    const logger = new ConsoleLogger('info');

    logger.info('message', { key: 'value', count: 42 });

    expect(console.info).toHaveBeenCalledWith(
      '[INFO] message {"key":"value","count":42}',
    );
  });

  it('should handle empty context', () => {
    const logger = new ConsoleLogger('info');

    logger.info('message', {});

    expect(console.info).toHaveBeenCalledWith('[INFO] message');
  });

  it('should handle undefined context', () => {
    const logger = new ConsoleLogger('info');

    logger.info('message');

    expect(console.info).toHaveBeenCalledWith('[INFO] message');
  });
});
