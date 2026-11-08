/**
 * Classification table (#4752): SDK error classes, codes and HTTP statuses
 * through the cause chain; never message text.
 */
import {
  AIError,
  AuthenticationError,
  ContentFilterError,
  ContextLengthError,
  ModelNotFoundError,
  RateLimitError,
} from '@happyvertical/ai';
import { InferenceBindingError } from '@happyvertical/smrt-core';
import { describe, expect, it } from 'vitest';
import { classifyInferenceFailure, isInferenceAbort } from '../classify.js';

function httpError(status: number, extra: Record<string, unknown> = {}) {
  return Object.assign(new Error('provider said no'), { status, ...extra });
}

describe('classifyInferenceFailure', () => {
  const table: Array<[string, unknown, string | undefined]> = [
    ['AuthenticationError', new AuthenticationError('openai'), 'credential'],
    ['HTTP 401', httpError(401), 'credential'],
    [
      'core bind refusal (pair rule, HAVE_AI_*)',
      new InferenceBindingError('refused'),
      'credential',
    ],
    ['HTTP 403', httpError(403), 'credential'],
    [
      'ModelNotFoundError',
      new ModelNotFoundError('gpt-x', 'openai'),
      'missing-model',
    ],
    ['HTTP 404', httpError(404), 'missing-model'],
    ['ContentFilterError', new ContentFilterError('openai'), 'refusal'],
    ['HTTP 402', httpError(402), 'quota'],
    [
      'RateLimitError over insufficient_quota cause',
      new RateLimitError('openai', undefined, {
        cause: httpError(429, { code: 'insufficient_quota' }),
      }),
      'quota',
    ],
    [
      'RateLimitError resetting in an hour',
      new RateLimitError('openai', 3600),
      'quota',
    ],
    [
      'RateLimitError resetting soon',
      new RateLimitError('openai', 2),
      'transient',
    ],
    ['HTTP 429', httpError(429), 'transient'],
    ['HTTP 503', httpError(503), 'transient'],
    ['HTTP 529 overloaded', httpError(529), 'transient'],
    [
      'AI_TIMEOUT',
      new AIError('timed out', 'AI_TIMEOUT', 'openai'),
      'transient',
    ],
    [
      'SDK API_ERROR (status dropped)',
      new AIError('x', 'API_ERROR', 'openai'),
      'transient',
    ],
    [
      'network code in a nested cause',
      Object.assign(new Error('fetch failed'), {
        cause: Object.assign(new Error('socket'), { code: 'ECONNRESET' }),
      }),
      'transient',
    ],
    [
      'driver error in context.originalError',
      Object.assign(new Error('wrapped'), {
        context: { originalError: httpError(401) },
      }),
      'credential',
    ],
    ['caller abort', new AIError('aborted', 'AI_ABORTED', 'openai'), undefined],
    [
      'API_ERROR over a definitive 400 stops the walk',
      Object.assign(new AIError('x', 'API_ERROR', 'openai'), {
        cause: httpError(400),
      }),
      undefined,
    ],
    ['HTTP 422', httpError(422), undefined],
    [
      'invalid_request_error',
      Object.assign(new Error('x'), { type: 'invalid_request_error' }),
      undefined,
    ],
    ['ContextLengthError', new ContextLengthError('openai'), undefined],
    ['plain TypeError', new TypeError('x is not a function'), undefined],
    [
      'message text alone is never read',
      new Error('quota exceeded: insufficient_quota, invalid api key, 503'),
      undefined,
    ],
    ['non-error value', 'boom', undefined],
  ];

  it.each(table)('%s', (_name, error, expected) => {
    expect(classifyInferenceFailure(error)).toBe(expected);
  });

  it('survives a cyclic cause chain', () => {
    const a = new Error('a') as Error & { cause?: unknown };
    const b = Object.assign(new Error('b'), { cause: a, status: 503 });
    a.cause = b;
    expect(classifyInferenceFailure(a)).toBe('transient');
  });

  it('detects aborts through the chain', () => {
    const abort = Object.assign(new Error('x'), { name: 'AbortError' });
    expect(isInferenceAbort(new Error('outer', { cause: abort }))).toBe(true);
    expect(isInferenceAbort(httpError(503))).toBe(false);
  });
});
