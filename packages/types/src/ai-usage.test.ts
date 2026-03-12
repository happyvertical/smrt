/**
 * Tests for AI usage tracking types
 */

import { describe, expect, it } from 'vitest';
import type {
  AiUsageHandler,
  SmrtAiUsageEvent,
  SmrtAiUsageRecord,
} from './ai-usage.js';

describe('AI Usage Types', () => {
  it('should allow creating valid AI usage events', () => {
    const event: SmrtAiUsageEvent = {
      provider: 'openai',
      model: 'gpt-4o-mini',
      operation: 'chat',
      usage: {
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
      },
      duration: 250,
      timestamp: new Date('2026-03-12T00:00:00.000Z'),
      tags: { feature: 'tests' },
      className: 'DemoAgent',
      tenantId: 'tenant-1',
      estimatedCost: 0.001,
    };

    expect(event.provider).toBe('openai');
    expect(event.usage?.totalTokens).toBe(15);
    expect(event.className).toBe('DemoAgent');
  });

  it('should allow creating persisted AI usage records', () => {
    const record: SmrtAiUsageRecord = {
      id: 'usage-1',
      provider: 'anthropic',
      model: 'claude-sonnet',
      operation: 'message',
      duration: 180,
      timestamp: new Date('2026-03-12T01:00:00.000Z'),
    };

    expect(record.id).toBe('usage-1');
    expect(record.operation).toBe('message');
  });

  it('should allow implementing AI usage handlers', async () => {
    const received: SmrtAiUsageEvent[] = [];

    const handler: AiUsageHandler = {
      async handle(event: SmrtAiUsageEvent): Promise<void> {
        received.push(event);
      },
    };

    const event: SmrtAiUsageEvent = {
      provider: 'google',
      model: 'gemini-2.5-flash',
      operation: 'embed',
      duration: 90,
      timestamp: new Date(),
    };

    await handler.handle(event);

    expect(received).toHaveLength(1);
    expect(received[0]).toBe(event);
  });
});
