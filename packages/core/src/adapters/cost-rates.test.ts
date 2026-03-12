/**
 * Tests for AI usage cost estimation
 */

import { describe, expect, it } from 'vitest';
import { estimateAiUsageCost } from './cost-rates.js';

describe('estimateAiUsageCost', () => {
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
  });
});
