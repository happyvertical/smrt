/**
 * Tests for the Feedback model and feedback → reinforcement path (#1889).
 *
 * Covers the signal taxonomy (human vs autonomous), the correlation-id, the
 * mapping onto a LearningOutcome, and that a signal actually adjusts a persona's
 * confidence-scored memory. Uses real in-memory SQLite with the `_smrt_contexts`
 * system table; nothing external is touched.
 */

import { getTestDatabase, type LearningMemory } from '@happyvertical/smrt-core';
import { disableTenancy } from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Feedback, FeedbackCollection, feedbackSourceFor } from './feedback.js';
import {
  personaLearningMemory,
  reinforceFromFeedback,
} from './persona-memory.js';

function makeSignal(fields: Partial<Feedback>): Feedback {
  const feedback = new Feedback();
  Object.assign(feedback, fields);
  return feedback;
}

describe('Feedback', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    // Force a known, tenancy-off state for this file (single-fork process).
    disableTenancy();
    db = await getTestDatabase({ classes: ['Feedback'] });
  });

  afterEach(async () => {
    if (typeof (db as { close?: () => Promise<void> }).close === 'function') {
      await (db as { close: () => Promise<void> }).close();
    }
  });

  describe('signal taxonomy', () => {
    it('classifies human vs autonomous signal types', () => {
      expect(feedbackSourceFor('accept')).toBe('human');
      expect(feedbackSourceFor('reject')).toBe('human');
      expect(feedbackSourceFor('correction')).toBe('human');
      expect(feedbackSourceFor('rating')).toBe('human');
      expect(feedbackSourceFor('outcome')).toBe('autonomous');
      expect(feedbackSourceFor('metric')).toBe('autonomous');
    });

    it('maps signal types onto learning outcomes', () => {
      expect(makeSignal({ signalType: 'accept' }).toLearningOutcome()).toEqual({
        success: true,
      });
      expect(
        makeSignal({ signalType: 'reject' }).toLearningOutcome(),
      ).toMatchObject({ success: false });
      expect(
        makeSignal({
          signalType: 'outcome',
          success: true,
        }).toLearningOutcome(),
      ).toEqual({ success: true });
      expect(
        makeSignal({ signalType: 'metric', metric: 5 }).toLearningOutcome(),
      ).toEqual({ metric: 5 });
      // A 1–5 star rating with neutral 3: a 5 reinforces, a 2 decays.
      expect(
        makeSignal({ signalType: 'rating', rating: 5 }).toLearningOutcome({
          ratingNeutral: 3,
        }),
      ).toEqual({ metric: 2 });
      expect(
        makeSignal({ signalType: 'rating', rating: 2 }).toLearningOutcome({
          ratingNeutral: 3,
        }),
      ).toEqual({ metric: -1 });
      // Signals with no value carry no reinforcement.
      expect(
        makeSignal({ signalType: 'outcome' }).toLearningOutcome(),
      ).toBeNull();
    });
  });

  describe('persistence', () => {
    it('round-trips a signal with its correlation-id', async () => {
      const feedback = await FeedbackCollection.create({ db });
      const created = await feedback.create({
        tenantId: 'tenant-a',
        personaId: 'persona-1',
        agentClass: '@happyvertical/smrt-agents:Praeco',
        memoryScope: 'praeco:support',
        scope: 'parser/acme',
        key: 'invoice',
        signalType: 'outcome',
        source: 'autonomous',
        correlationId: 'ai-call-42',
        correlationType: 'ai_call',
        success: true,
      });

      const loaded = await feedback.get({ id: created.id as string });
      expect(loaded?.correlationId).toBe('ai-call-42');
      expect(loaded?.correlationType).toBe('ai_call');
      expect(loaded?.signalType).toBe('outcome');
      expect(loaded?.success).toBe(true);

      const byCorrelation = await feedback.byCorrelation('ai-call-42');
      expect(byCorrelation).toHaveLength(1);
      expect(byCorrelation[0].key).toBe('invoice');
    });
  });

  describe('reinforcement', () => {
    let memory: LearningMemory;

    beforeEach(() => {
      memory = personaLearningMemory({
        db,
        persona: {
          id: 'persona-1',
          memoryScope: 'praeco:support',
          agentClass: 'Praeco',
          tenantId: 'tenant-a',
        },
      });
    });

    it('decays a confident memory when an outcome signal reports failure', async () => {
      const episode = { scope: 'parser/acme', key: 'invoice', value: 'v1' };
      await memory.capture(episode, { success: true }); // seeds at 0.9

      const signal = makeSignal({
        signalType: 'outcome',
        source: 'autonomous',
        scope: 'parser/acme',
        key: 'invoice',
        correlationId: 'job-7',
        success: false,
      });
      const record = await reinforceFromFeedback(memory, signal);

      // 0.9 -> 0.9 + 0.5*(0.3 - 0.9) = 0.6 (below the 0.7 reuse floor).
      expect(record?.confidence).toBeCloseTo(0.6, 5);
      expect(record?.failureCount).toBe(1);
    });

    it('strengthens a memory when a human accept signal is applied', async () => {
      const episode = { scope: 'parser/acme', key: 'invoice', value: 'v1' };
      await memory.capture(episode, { success: true }); // 0.9

      const signal = makeSignal({
        signalType: 'accept',
        source: 'human',
        scope: 'parser/acme',
        key: 'invoice',
        correlationId: 'dispatch-3',
        actorId: 'user-1',
      });
      const record = await reinforceFromFeedback(memory, signal);

      // 0.9 -> 0.9 + 0.5*(1 - 0.9) = 0.95.
      expect(record?.confidence).toBeCloseTo(0.95, 5);
      expect(record?.successCount).toBe(2);
    });

    it('supersedes the stored strategy from a correction signal', async () => {
      const episode = { scope: 'parser/acme', key: 'invoice', value: 'old' };
      await memory.capture(episode, { success: true });

      const signal = makeSignal({
        signalType: 'correction',
        source: 'human',
        scope: 'parser/acme',
        key: 'invoice',
        correlationId: 'ai-call-9',
        correction: 'new-strategy',
      });
      const record = await reinforceFromFeedback(memory, signal);

      // Correction decays confidence but replaces the stored value.
      expect(record?.value).toBe('new-strategy');
      expect(record?.failureCount).toBe(1);
    });
  });
});
