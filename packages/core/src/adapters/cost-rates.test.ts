/**
 * Tests for AI usage cost estimation
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

// cost-rates.ts logs missing-rate warnings via @happyvertical/logger; mock it so
// the tests can assert on the logger (S14 console→logger migration).
const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));
vi.mock('@happyvertical/logger', () => ({
  createLogger: () => mockLogger,
}));

import { estimateAiUsageCost } from './cost-rates.js';

describe('estimateAiUsageCost', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it('should estimate cost from default rates', () => {
    const cost = estimateAiUsageCost('openai', 'gpt-4o-mini', {
      promptTokens: 1000,
      completionTokens: 500,
      totalTokens: 1500,
    });

    expect(cost).toBeCloseTo(0.00045, 8);
  });

  it('should prefer custom overrides', () => {
    const cost = estimateAiUsageCost(
      'openai',
      'gpt-4o-mini',
      {
        promptTokens: 1000,
        completionTokens: 1000,
        totalTokens: 2000,
      },
      {
        'openai:gpt-4o-mini': {
          input: 0.001,
          output: 0.002,
        },
      },
    );

    expect(cost).toBeCloseTo(0.003, 8);
  });

  it('should return undefined for unknown models', () => {
    const cost = estimateAiUsageCost('openai', 'unknown-model', {
      promptTokens: 100,
      completionTokens: 100,
      totalTokens: 200,
    });

    expect(cost).toBeUndefined();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      '[smrt] No AI usage cost rate configured for openai:unknown-model. ' +
        'Cost estimation will be skipped for this model.',
    );
  });

  it('should warn only once per unknown model', () => {
    estimateAiUsageCost('openai', 'warn-once-model', {
      promptTokens: 100,
      completionTokens: 100,
      totalTokens: 200,
    });
    estimateAiUsageCost('openai', 'warn-once-model', {
      promptTokens: 150,
      completionTokens: 50,
      totalTokens: 200,
    });

    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
  });
});
