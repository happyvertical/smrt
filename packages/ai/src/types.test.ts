/**
 * Tests for AI types and error classes
 */

import { describe, expect, it } from 'vitest';
import {
  AIError,
  AuthenticationError,
  ContentFilterError,
  ContextLengthError,
  ModelNotFoundError,
  RateLimitError,
} from './shared/types';

describe('AI Error Classes', () => {
  describe('AIError', () => {
    it('should create basic AI error', () => {
      const error = new AIError(
        'Test error',
        'TEST_CODE',
        'test-provider',
        'test-model',
      );

      expect(error.name).toBe('AIError');
      expect(error.message).toBe('Test error');
      expect(error.code).toBe('TEST_CODE');
      expect(error.provider).toBe('test-provider');
      expect(error.model).toBe('test-model');
      expect(error instanceof Error).toBe(true);
      expect(error instanceof AIError).toBe(true);
    });

    it('should create AI error with minimal parameters', () => {
      const error = new AIError('Minimal error', 'MIN_CODE');

      expect(error.name).toBe('AIError');
      expect(error.message).toBe('Minimal error');
      expect(error.code).toBe('MIN_CODE');
      expect(error.provider).toBeUndefined();
      expect(error.model).toBeUndefined();
    });
  });

  describe('AuthenticationError', () => {
    it('should create authentication error', () => {
      const error = new AuthenticationError('openai');

      expect(error.name).toBe('AuthenticationError');
      expect(error.message).toBe('Authentication failed');
      expect(error.code).toBe('AUTH_ERROR');
      expect(error.provider).toBe('openai');
      expect(error instanceof AIError).toBe(true);
      expect(error instanceof AuthenticationError).toBe(true);
    });

    it('should create authentication error without provider', () => {
      const error = new AuthenticationError();

      expect(error.name).toBe('AuthenticationError');
      expect(error.message).toBe('Authentication failed');
      expect(error.code).toBe('AUTH_ERROR');
      expect(error.provider).toBeUndefined();
    });
  });

  describe('RateLimitError', () => {
    it('should create rate limit error with retry after', () => {
      const error = new RateLimitError('anthropic', 60);

      expect(error.name).toBe('RateLimitError');
      expect(error.message).toBe('Rate limit exceeded, retry after 60s');
      expect(error.code).toBe('RATE_LIMIT');
      expect(error.provider).toBe('anthropic');
      expect(error instanceof AIError).toBe(true);
      expect(error instanceof RateLimitError).toBe(true);
    });

    it('should create rate limit error without retry after', () => {
      const error = new RateLimitError('gemini');

      expect(error.name).toBe('RateLimitError');
      expect(error.message).toBe('Rate limit exceeded');
      expect(error.code).toBe('RATE_LIMIT');
      expect(error.provider).toBe('gemini');
    });
  });

  describe('ModelNotFoundError', () => {
    it('should create model not found error', () => {
      const error = new ModelNotFoundError('gpt-5', 'openai');

      expect(error.name).toBe('ModelNotFoundError');
      expect(error.message).toBe('Model not found: gpt-5');
      expect(error.code).toBe('MODEL_NOT_FOUND');
      expect(error.provider).toBe('openai');
      expect(error.model).toBe('gpt-5');
      expect(error instanceof AIError).toBe(true);
      expect(error instanceof ModelNotFoundError).toBe(true);
    });
  });

  describe('ContextLengthError', () => {
    it('should create context length error', () => {
      const error = new ContextLengthError('huggingface', 'gpt2');

      expect(error.name).toBe('ContextLengthError');
      expect(error.message).toBe('Input exceeds maximum context length');
      expect(error.code).toBe('CONTEXT_LENGTH_EXCEEDED');
      expect(error.provider).toBe('huggingface');
      expect(error.model).toBe('gpt2');
      expect(error instanceof AIError).toBe(true);
      expect(error instanceof ContextLengthError).toBe(true);
    });
  });

  describe('ContentFilterError', () => {
    it('should create content filter error', () => {
      const error = new ContentFilterError('bedrock', 'claude-3');

      expect(error.name).toBe('ContentFilterError');
      expect(error.message).toBe('Content filtered by safety systems');
      expect(error.code).toBe('CONTENT_FILTERED');
      expect(error.provider).toBe('bedrock');
      expect(error.model).toBe('claude-3');
      expect(error instanceof AIError).toBe(true);
      expect(error instanceof ContentFilterError).toBe(true);
    });
  });
});
