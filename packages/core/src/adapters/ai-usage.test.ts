/**
 * Tests for AI usage adapters
 */

import type { SmrtAiUsageEvent } from '@happyvertical/smrt-types';
import { beforeEach, describe, expect, it } from 'vitest';
import { AiUsageCollector } from './ai-usage.js';

describe('AiUsageCollector', () => {
  let collector: AiUsageCollector;

  beforeEach(() => {
    collector = new AiUsageCollector();
  });

  function event(overrides: Partial<SmrtAiUsageEvent> = {}): SmrtAiUsageEvent {
    return {
      provider: 'openai',
      model: 'gpt-4o-mini',
      operation: 'chat',
      usage: {
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
      },
      duration: 120,
      timestamp: new Date('2026-03-12T00:00:00.000Z'),
      className: 'DemoAgent',
      estimatedCost: 0.001,
      ...overrides,
    };
  }

  it('should aggregate usage by model and class', async () => {
    await collector.handle(event());
    await collector.handle(
      event({
        operation: 'embed',
        usage: {
          promptTokens: 20,
          completionTokens: 0,
          totalTokens: 20,
        },
      }),
    );

    const snapshot = collector.getSnapshot();

    expect(snapshot.totalCalls).toBe(2);
    expect(snapshot.byModel['openai:gpt-4o-mini']?.totalTokens).toBe(35);
    expect(snapshot.byClass['DemoAgent:chat']?.callCount).toBe(1);
    expect(snapshot.byClass['DemoAgent:embed']?.promptTokens).toBe(20);
  });

  it('should reset collected usage', async () => {
    await collector.handle(event());
    expect(collector.getSnapshot().totalCalls).toBe(1);

    collector.reset();

    const snapshot = collector.getSnapshot();
    expect(snapshot.totalCalls).toBe(0);
    expect(Object.keys(snapshot.byModel)).toHaveLength(0);
    expect(Object.keys(snapshot.byClass)).toHaveLength(0);
  });
});
