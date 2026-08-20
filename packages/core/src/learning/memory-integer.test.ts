import type { DatabaseInterface } from '@happyvertical/sql';
import { describe, expect, it } from 'vitest';
import { LearningMemory } from './memory.js';

describe('LearningMemory integer counters', () => {
  it('rejects a counter that would overflow JavaScript safe integer precision', async () => {
    const db = {
      get: async () => ({
        id: 'memory-1',
        confidence: 1,
        success_count: Number.MAX_SAFE_INTEGER,
        failure_count: 0,
        value: '"strategy"',
        metadata: null,
      }),
      update: async () => undefined,
    } as unknown as DatabaseInterface;
    const memory = new LearningMemory({
      db,
      ownerClass: 'Agent',
      ownerId: 'agent-1',
    });

    await expect(
      memory.capture(
        { scope: 'scope', key: 'key', value: 'strategy' },
        { success: true },
      ),
    ).rejects.toThrow('Learning memory success count');
  });
});
