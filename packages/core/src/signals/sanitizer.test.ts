/**
 * Tests for SignalSanitizer
 */

import type { Signal } from '@smrt/types';
import { describe, expect, it } from 'vitest';
import { SignalSanitizer } from './sanitizer.js';

describe('SignalSanitizer', () => {
  describe('Default Redaction', () => {
    it('should redact password fields', () => {
      const sanitizer = new SignalSanitizer();
      const signal: Signal = {
        id: 'test-1',
        objectId: 'obj-1',
        className: 'User',
        method: 'login',
        type: 'start',
        timestamp: Date.now(),
        args: {
          username: 'alice',
          password: 'secret123',
        },
      };

      const sanitized = sanitizer.sanitize(signal);

      expect(sanitized.args).toEqual({
        username: 'alice',
        password: '[REDACTED]',
      });
    });

    it('should redact API keys', () => {
      const sanitizer = new SignalSanitizer();
      const signal: Signal = {
        id: 'test-1',
        objectId: 'obj-1',
        className: 'APIClient',
        method: 'request',
        type: 'start',
        timestamp: Date.now(),
        metadata: {
          apiKey: 'sk-proj-abc123',
          api_key: 'another-key',
        },
      };

      const sanitized = sanitizer.sanitize(signal);

      expect(sanitized.metadata).toEqual({
        apiKey: '[REDACTED]',
        api_key: '[REDACTED]',
      });
    });

    it('should redact tokens', () => {
      const sanitizer = new SignalSanitizer();
      const signal: Signal = {
        id: 'test-1',
        objectId: 'obj-1',
        className: 'Auth',
        method: 'refresh',
        type: 'end',
        timestamp: Date.now(),
        result: {
          accessToken: 'eyJ0eXAiOiJKV1QiLCJh...',
          refreshToken: 'refresh_xyz',
          bearerToken: 'Bearer abc123',
        },
      };

      const sanitized = sanitizer.sanitize(signal);

      expect(sanitized.result).toEqual({
        accessToken: '[REDACTED]',
        refreshToken: '[REDACTED]',
        bearerToken: '[REDACTED]',
      });
    });

    it('should redact sensitive PII fields', () => {
      const sanitizer = new SignalSanitizer();
      const signal: Signal = {
        id: 'test-1',
        objectId: 'obj-1',
        className: 'Payment',
        method: 'process',
        type: 'start',
        timestamp: Date.now(),
        args: {
          creditCard: '4111111111111111',
          cvv: '123',
          ssn: '123-45-6789',
        },
      };

      const sanitized = sanitizer.sanitize(signal);

      expect(sanitized.args).toEqual({
        creditCard: '[REDACTED]',
        cvv: '[REDACTED]',
        ssn: '[REDACTED]',
      });
    });

    it('should handle case-insensitive key matching', () => {
      const sanitizer = new SignalSanitizer();
      const signal: Signal = {
        id: 'test-1',
        objectId: 'obj-1',
        className: 'Test',
        method: 'test',
        type: 'start',
        timestamp: Date.now(),
        args: {
          PASSWORD: 'secret',
          ApiKey: 'key123',
          user_token: 'token456',
        },
      };

      const sanitized = sanitizer.sanitize(signal);

      expect(sanitized.args).toEqual({
        PASSWORD: '[REDACTED]',
        ApiKey: '[REDACTED]',
        user_token: '[REDACTED]',
      });
    });
  });

  describe('Custom Configuration', () => {
    it('should support custom redact keys', () => {
      const sanitizer = new SignalSanitizer({
        redactKeys: ['secret', 'private'],
      });

      const signal: Signal = {
        id: 'test-1',
        objectId: 'obj-1',
        className: 'Test',
        method: 'test',
        type: 'start',
        timestamp: Date.now(),
        args: {
          secretData: 'should-be-redacted',
          privateInfo: 'also-redacted',
          publicData: 'visible',
        },
      };

      const sanitized = sanitizer.sanitize(signal);

      expect(sanitized.args).toEqual({
        secretData: '[REDACTED]',
        privateInfo: '[REDACTED]',
        publicData: 'visible',
      });
    });

    it('should support custom redacted value', () => {
      const sanitizer = new SignalSanitizer({
        redactedValue: '***',
      });

      const signal: Signal = {
        id: 'test-1',
        objectId: 'obj-1',
        className: 'Test',
        method: 'test',
        type: 'start',
        timestamp: Date.now(),
        args: { password: 'secret' },
      };

      const sanitized = sanitizer.sanitize(signal);

      expect(sanitized.args).toEqual({ password: '***' });
    });

    it('should support custom replacer function', () => {
      const sanitizer = new SignalSanitizer({
        replacer: (key, value) => {
          if (key === 'email') {
            // Partially redact email
            return value.replace(/(.{2})(.*)(@.*)/, '$1***$3');
          }
          return value;
        },
      });

      const signal: Signal = {
        id: 'test-1',
        objectId: 'obj-1',
        className: 'Test',
        method: 'test',
        type: 'start',
        timestamp: Date.now(),
        args: {
          email: 'alice@example.com',
          name: 'Alice',
        },
      };

      const sanitized = sanitizer.sanitize(signal);

      expect(sanitized.args).toEqual({
        email: 'al***@example.com',
        name: 'Alice',
      });
    });
  });

  describe('Data Structure Handling', () => {
    it('should handle nested objects', () => {
      const sanitizer = new SignalSanitizer();
      const signal: Signal = {
        id: 'test-1',
        objectId: 'obj-1',
        className: 'Test',
        method: 'test',
        type: 'start',
        timestamp: Date.now(),
        args: {
          user: {
            name: 'Alice',
            credentials: {
              password: 'secret',
              apiKey: 'key123',
            },
          },
        },
      };

      const sanitized = sanitizer.sanitize(signal);

      expect(sanitized.args).toEqual({
        user: {
          name: 'Alice',
          credentials: {
            password: '[REDACTED]',
            apiKey: '[REDACTED]',
          },
        },
      });
    });

    it('should handle arrays', () => {
      const sanitizer = new SignalSanitizer();
      const signal: Signal = {
        id: 'test-1',
        objectId: 'obj-1',
        className: 'Test',
        method: 'test',
        type: 'start',
        timestamp: Date.now(),
        args: {
          users: [
            { name: 'Alice', password: 'secret1' },
            { name: 'Bob', password: 'secret2' },
          ],
        },
      };

      const sanitized = sanitizer.sanitize(signal);

      expect(sanitized.args).toEqual({
        users: [
          { name: 'Alice', password: '[REDACTED]' },
          { name: 'Bob', password: '[REDACTED]' },
        ],
      });
    });

    it('should handle circular references', () => {
      const sanitizer = new SignalSanitizer();

      // Create circular reference
      const obj: any = { name: 'Test' };
      obj.self = obj;

      const signal: Signal = {
        id: 'test-1',
        objectId: 'obj-1',
        className: 'Test',
        method: 'test',
        type: 'start',
        timestamp: Date.now(),
        args: obj,
      };

      const sanitized = sanitizer.sanitize(signal);

      expect(sanitized.args).toEqual({
        name: 'Test',
        self: '[CIRCULAR]',
      });
    });

    it('should truncate long strings', () => {
      const sanitizer = new SignalSanitizer();
      const longString = 'x'.repeat(2000);

      const signal: Signal = {
        id: 'test-1',
        objectId: 'obj-1',
        className: 'Test',
        method: 'test',
        type: 'start',
        timestamp: Date.now(),
        args: { data: longString },
      };

      const sanitized = sanitizer.sanitize(signal);

      expect(sanitized.args?.data).toContain('[TRUNCATED]');
      expect(sanitized.args?.data?.length).toBeLessThan(1100);
    });

    it('should handle Error objects specially', () => {
      const sanitizer = new SignalSanitizer();
      const error = new Error('Test error');

      const signal: Signal = {
        id: 'test-1',
        objectId: 'obj-1',
        className: 'Test',
        method: 'test',
        type: 'error',
        timestamp: Date.now(),
        error,
      };

      const sanitized = sanitizer.sanitize(signal);

      expect(sanitized.error).toMatchObject({
        message: 'Test error',
        name: 'Error',
      });
      expect(sanitized.error).toHaveProperty('stack');
      // Stack should be truncated to 10 lines (default maxStackLines)
      expect(
        (sanitized.error as any).stack.split('\n').length,
      ).toBeLessThanOrEqual(10);
    });
  });

  describe('Signal Field Handling', () => {
    it('should preserve signal metadata fields', () => {
      const sanitizer = new SignalSanitizer();
      const signal: Signal = {
        id: 'exec-123',
        objectId: 'obj-456',
        className: 'Test',
        method: 'testMethod',
        type: 'end',
        timestamp: 1234567890,
        duration: 150,
      };

      const sanitized = sanitizer.sanitize(signal);

      expect(sanitized).toEqual({
        id: 'exec-123',
        objectId: 'obj-456',
        className: 'Test',
        method: 'testMethod',
        type: 'end',
        timestamp: 1234567890,
        duration: 150,
      });
    });

    it('should sanitize args, result, error, and metadata', () => {
      const sanitizer = new SignalSanitizer();
      const signal: Signal = {
        id: 'test-1',
        objectId: 'obj-1',
        className: 'Test',
        method: 'test',
        type: 'end',
        timestamp: Date.now(),
        args: { password: 'secret' },
        result: { token: 'xyz' },
        metadata: { apiKey: 'key123' },
      };

      const sanitized = sanitizer.sanitize(signal);

      expect(sanitized.args).toEqual({ password: '[REDACTED]' });
      expect(sanitized.result).toEqual({ token: '[REDACTED]' });
      expect(sanitized.metadata).toEqual({ apiKey: '[REDACTED]' });
    });

    it('should not mutate original signal', () => {
      const sanitizer = new SignalSanitizer();
      const signal: Signal = {
        id: 'test-1',
        objectId: 'obj-1',
        className: 'Test',
        method: 'test',
        type: 'start',
        timestamp: Date.now(),
        args: { password: 'secret', username: 'alice' },
      };

      const original = JSON.parse(JSON.stringify(signal));
      sanitizer.sanitize(signal);

      // Original signal should be unchanged
      expect(signal).toEqual(original);
      expect(signal.args).toEqual({ password: 'secret', username: 'alice' });
    });
  });

  describe('Edge Cases', () => {
    it('should handle null and undefined values', () => {
      const sanitizer = new SignalSanitizer();
      const signal: Signal = {
        id: 'test-1',
        objectId: 'obj-1',
        className: 'Test',
        method: 'test',
        type: 'start',
        timestamp: Date.now(),
        args: {
          nullValue: null,
          undefinedValue: undefined,
          password: 'secret',
        },
      };

      const sanitized = sanitizer.sanitize(signal);

      expect(sanitized.args).toEqual({
        nullValue: null,
        undefinedValue: undefined,
        password: '[REDACTED]',
      });
    });

    it('should handle primitives', () => {
      const sanitizer = new SignalSanitizer();
      const signal: Signal = {
        id: 'test-1',
        objectId: 'obj-1',
        className: 'Test',
        method: 'test',
        type: 'start',
        timestamp: Date.now(),
        args: {
          string: 'hello',
          number: 42,
          boolean: true,
        },
      };

      const sanitized = sanitizer.sanitize(signal);

      expect(sanitized.args).toEqual({
        string: 'hello',
        number: 42,
        boolean: true,
      });
    });

    it('should handle empty objects and arrays', () => {
      const sanitizer = new SignalSanitizer();
      const signal: Signal = {
        id: 'test-1',
        objectId: 'obj-1',
        className: 'Test',
        method: 'test',
        type: 'start',
        timestamp: Date.now(),
        args: {
          emptyObject: {},
          emptyArray: [],
        },
      };

      const sanitized = sanitizer.sanitize(signal);

      expect(sanitized.args).toEqual({
        emptyObject: {},
        emptyArray: [],
      });
    });

    it('should handle signal without optional fields', () => {
      const sanitizer = new SignalSanitizer();
      const signal: Signal = {
        id: 'test-1',
        objectId: 'obj-1',
        className: 'Test',
        method: 'test',
        type: 'start',
        timestamp: Date.now(),
      };

      const sanitized = sanitizer.sanitize(signal);

      expect(sanitized).toEqual({
        id: 'test-1',
        objectId: 'obj-1',
        className: 'Test',
        method: 'test',
        type: 'start',
        timestamp: signal.timestamp,
      });
    });
  });
});
