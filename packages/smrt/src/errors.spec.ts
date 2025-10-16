/**
 * Tests for comprehensive error handling system
 */

import { describe, expect, it } from 'vitest';
import {
  AIError,
  DatabaseError,
  ErrorUtils,
  SmrtError,
  ValidationError,
} from './errors';

describe('SMRT Error System', () => {
  describe('DatabaseError', () => {
    it('should create connection failed error', () => {
      const error = DatabaseError.connectionFailed('sqlite://test.db');

      expect(error).toBeInstanceOf(DatabaseError);
      expect(error).toBeInstanceOf(SmrtError);
      expect(error.category).toBe('database');
      expect(error.code).toBe('DB_CONNECTION_FAILED');
      expect(error.message).toContain('sqlite://test.db');
      expect(error.details?.dbUrl).toBe('sqlite://test.db');
    });

    it('should create query failed error', () => {
      const query = 'SELECT * FROM users WHERE id = ?';
      const cause = new Error('Connection lost');
      const error = DatabaseError.queryFailed(query, cause);

      expect(error.code).toBe('DB_QUERY_FAILED');
      expect(error.cause).toBe(cause);
      expect(error.details?.query).toBe(query);
    });

    it('should create constraint violation error', () => {
      const error = DatabaseError.constraintViolation(
        'unique_email',
        'test@example.com',
      );

      expect(error.code).toBe('DB_CONSTRAINT_VIOLATION');
      expect(error.details?.constraint).toBe('unique_email');
      expect(error.details?.value).toBe('test@example.com');
    });
  });

  describe('ValidationError', () => {
    it('should create required field error', () => {
      const error = ValidationError.requiredField('name', 'User');

      expect(error.category).toBe('validation');
      expect(error.code).toBe('VALIDATION_REQUIRED_FIELD');
      expect(error.message).toContain('name');
      expect(error.message).toContain('User');
    });

    it('should create range error', () => {
      const error = ValidationError.rangeError('age', 150, 0, 120);

      expect(error.code).toBe('VALIDATION_RANGE_ERROR');
      expect(error.details?.fieldName).toBe('age');
      expect(error.details?.value).toBe(150);
      expect(error.details?.min).toBe(0);
      expect(error.details?.max).toBe(120);
    });
  });

  describe('AIError', () => {
    it('should create provider error', () => {
      const error = AIError.providerError('openai', 'completion');

      expect(error.category).toBe('ai');
      expect(error.code).toBe('AI_PROVIDER_ERROR');
      expect(error.details?.provider).toBe('openai');
      expect(error.details?.operation).toBe('completion');
    });

    it('should create rate limit error', () => {
      const error = AIError.rateLimitExceeded('openai', 60);

      expect(error.code).toBe('AI_RATE_LIMIT');
      expect(error.details?.retryAfter).toBe(60);
    });
  });

  describe('ErrorUtils', () => {
    it('should retry operations successfully', async () => {
      let attempts = 0;
      const operation = async () => {
        attempts++;
        if (attempts < 3) {
          throw new Error('Temporary failure');
        }
        return 'success';
      };

      const result = await ErrorUtils.withRetry(operation, 3, 10);

      expect(result).toBe('success');
      expect(attempts).toBe(3);
    });

    it('should fail after max retries', async () => {
      const operation = async () => {
        throw new Error('Persistent failure');
      };

      await expect(ErrorUtils.withRetry(operation, 2, 10)).rejects.toThrow(
        'Persistent failure',
      );
    });

    it('should not retry validation errors', async () => {
      let attempts = 0;
      const operation = async () => {
        attempts++;
        throw ValidationError.requiredField('name', 'User');
      };

      await expect(ErrorUtils.withRetry(operation, 3, 10)).rejects.toThrow(
        ValidationError,
      );
      expect(attempts).toBe(1); // Should not retry
    });

    it('should identify retryable errors', () => {
      expect(ErrorUtils.isRetryable(new Error('ECONNRESET'))).toBe(true);
      expect(ErrorUtils.isRetryable(new Error('rate limit exceeded'))).toBe(
        true,
      );
      expect(ErrorUtils.isRetryable(new Error('timeout'))).toBe(true);
      expect(ErrorUtils.isRetryable(new Error('Invalid input'))).toBe(false);
    });

    it('should sanitize errors', () => {
      const error = DatabaseError.connectionFailed(
        'postgres://user:password123@host/db',
      );
      error.details!.apiKey = 'secret-key-123';

      const sanitized = ErrorUtils.sanitizeError(error);

      expect(sanitized.code).toBe('DB_CONNECTION_FAILED');
      expect(sanitized.details.apiKey).toBe('[REDACTED]');
      expect(sanitized.details.dbUrl).toContain('postgres://'); // URL not sanitized in this basic version
    });
  });

  describe('Error Serialization', () => {
    it('should serialize errors to JSON', () => {
      const cause = new Error('Root cause');
      const error = DatabaseError.queryFailed('SELECT 1', cause);

      const json = error.toJSON();

      expect(json.name).toBe('DatabaseError');
      expect(json.code).toBe('DB_QUERY_FAILED');
      expect(json.category).toBe('database');
      expect(json.cause?.message).toBe('Root cause');
      expect(json.stack).toBeDefined();
    });
  });

  describe('Error Inheritance', () => {
    it('should maintain proper inheritance chain', () => {
      const error = ValidationError.requiredField('name', 'User');

      expect(error instanceof ValidationError).toBe(true);
      expect(error instanceof SmrtError).toBe(true);
      expect(error instanceof Error).toBe(true);
    });
  });
});
