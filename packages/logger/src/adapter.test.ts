/**
 * Tests for LoggerAdapter
 */

import { describe, expect, it, beforeEach, vi } from 'vitest';
import { LoggerAdapter } from './adapter.js';
import type { Signal } from '@have/types';
import type { Logger } from './logger.js';

describe('LoggerAdapter', () => {
  let mockLogger: Logger;
  let adapter: LoggerAdapter;

  beforeEach(() => {
    mockLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    adapter = new LoggerAdapter(mockLogger);
  });

  it('should log start signals at debug level', async () => {
    const signal: Signal = {
      id: 'exec-1',
      objectId: 'obj-1',
      className: 'Product',
      method: 'analyze',
      type: 'start',
      timestamp: Date.now(),
    };

    await adapter.handle(signal);

    expect(mockLogger.debug).toHaveBeenCalledWith(
      'Product.analyze() started',
      expect.objectContaining({
        id: 'exec-1',
        objectId: 'obj-1',
        className: 'Product',
        method: 'analyze',
      }),
    );
  });

  it('should log step signals at debug level', async () => {
    const signal: Signal = {
      id: 'exec-1',
      objectId: 'obj-1',
      className: 'Product',
      method: 'analyze',
      type: 'step',
      step: 'validation',
      timestamp: Date.now(),
    };

    await adapter.handle(signal);

    expect(mockLogger.debug).toHaveBeenCalledWith(
      'Product.analyze() step: validation',
      expect.objectContaining({
        id: 'exec-1',
        className: 'Product',
        method: 'analyze',
      }),
    );
  });

  it('should log end signals at info level', async () => {
    const signal: Signal = {
      id: 'exec-1',
      objectId: 'obj-1',
      className: 'Product',
      method: 'analyze',
      type: 'end',
      duration: 150,
      result: { success: true },
      timestamp: Date.now(),
    };

    await adapter.handle(signal);

    expect(mockLogger.info).toHaveBeenCalledWith(
      'Product.analyze() completed in 150ms',
      expect.objectContaining({
        id: 'exec-1',
        className: 'Product',
        method: 'analyze',
        duration: 150,
        result: 'present',
      }),
    );
  });

  it('should log error signals at error level', async () => {
    const testError = new Error('Test error');
    const signal: Signal = {
      id: 'exec-1',
      objectId: 'obj-1',
      className: 'Product',
      method: 'analyze',
      type: 'error',
      error: testError,
      duration: 50,
      timestamp: Date.now(),
    };

    await adapter.handle(signal);

    expect(mockLogger.error).toHaveBeenCalledWith(
      'Product.analyze() failed: Test error',
      expect.objectContaining({
        id: 'exec-1',
        className: 'Product',
        method: 'analyze',
        error: expect.objectContaining({
          message: 'Test error',
          name: 'Error',
        }),
      }),
    );
  });

  it('should handle signals without duration', async () => {
    const signal: Signal = {
      id: 'exec-1',
      objectId: 'obj-1',
      className: 'Product',
      method: 'analyze',
      type: 'start',
      timestamp: Date.now(),
    };

    await adapter.handle(signal);

    expect(mockLogger.debug).toHaveBeenCalledWith(
      'Product.analyze() started',
      expect.not.objectContaining({
        duration: expect.anything(),
      }),
    );
  });

  it('should include metadata when present', async () => {
    const signal: Signal = {
      id: 'exec-1',
      objectId: 'obj-1',
      className: 'Product',
      method: 'analyze',
      type: 'start',
      timestamp: Date.now(),
      metadata: { requestId: 'req-123', userId: 'user-456' },
    };

    await adapter.handle(signal);

    expect(mockLogger.debug).toHaveBeenCalledWith(
      'Product.analyze() started',
      expect.objectContaining({
        metadata: { requestId: 'req-123', userId: 'user-456' },
      }),
    );
  });

  it('should handle end signals without result', async () => {
    const signal: Signal = {
      id: 'exec-1',
      objectId: 'obj-1',
      className: 'Product',
      method: 'analyze',
      type: 'end',
      duration: 100,
      timestamp: Date.now(),
    };

    await adapter.handle(signal);

    expect(mockLogger.info).toHaveBeenCalledWith(
      'Product.analyze() completed in 100ms',
      expect.objectContaining({
        result: 'none',
      }),
    );
  });
});
