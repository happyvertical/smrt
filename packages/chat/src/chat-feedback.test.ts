/**
 * Chat feedback capture (#1891) — real in-memory SQLite; nothing mocked.
 *
 * Proves in-chat accept/reject/correction is captured as a `Feedback` row (with
 * the conversation's correlation-id) AND influences subsequent behaviour: a
 * rejected strategy decays below the reuse floor and stops being recalled; a
 * correction supersedes the stored value.
 */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AgentPersonaCollection,
  FeedbackCollection,
  personaLearningMemory,
} from '@happyvertical/smrt-personas';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  acceptAppliedChange,
  type ChatFeedbackPersona,
  captureChatFeedback,
  correctResponse,
  rejectAppliedChange,
  thumbsDown,
  thumbsUp,
} from './chat-feedback.js';

const TENANT = 'tenant-fb';
const AGENT_CLASS = '@happyvertical/smrt-agents:Praeco';

describe('chat feedback capture', () => {
  let dbPath: string;
  let db: { type: 'sqlite'; url: string };
  let personas: AgentPersonaCollection;
  let feedbacks: FeedbackCollection;
  let personaId: string;
  let persona: ChatFeedbackPersona;

  beforeEach(async () => {
    dbPath = join(tmpdir(), `smrt-chat-fb-${Date.now()}-${Math.random()}.db`);
    db = { type: 'sqlite', url: dbPath };
    personas = await AgentPersonaCollection.create({ db });
    feedbacks = await FeedbackCollection.create({ db });
    enableTenancy();

    await withTenant({ tenantId: TENANT }, async () => {
      const row = await personas.create({
        tenantId: TENANT,
        agentClass: AGENT_CLASS,
        name: 'Support',
        runAsUserId: 'user-1',
        memoryScope: 'praeco:support',
      });
      await row.save();
      personaId = row.id as string;
    });

    persona = {
      id: personaId,
      tenantId: TENANT,
      agentClass: AGENT_CLASS,
      memoryScope: 'praeco:support',
    };
  });

  afterEach(() => {
    disableTenancy();
    if (existsSync(dbPath)) {
      try {
        rmSync(dbPath, { force: true });
      } catch {
        // best-effort
      }
    }
  });

  it('captures an accept as a human Feedback row carrying the correlation-id', async () => {
    await withTenant({ tenantId: TENANT }, async () => {
      const { feedback } = await acceptAppliedChange({
        db,
        persona,
        correlationId: 'msg-42',
        scope: 'chat',
        key: 'greeting',
        actorId: 'user-9',
      });

      expect(feedback.signalType).toBe('accept');
      expect(feedback.source).toBe('human');
      expect(feedback.correlationId).toBe('msg-42');
      expect(feedback.correlationType).toBe('chat_message');
      expect(feedback.personaId).toBe(personaId);
      expect(feedback.memoryScope).toBe('praeco:support');

      // Persisted and correlatable.
      const byCorrelation = await feedbacks.byCorrelation('msg-42');
      expect(byCorrelation).toHaveLength(1);
    });
  });

  it('rejecting an applied change decays a confident strategy below the reuse floor', async () => {
    await withTenant({ tenantId: TENANT }, async () => {
      // LearningMemory needs a resolved handle; borrow the collection's.
      const memory = personaLearningMemory({ db: feedbacks.db, persona });
      // Seed a confident strategy (0.9) the agent had been reusing.
      await memory.capture(
        { scope: 'chat', key: 'greeting', value: 'cite the source first' },
        { success: true },
      );
      const before = await memory.recall('chat', { key: 'greeting' });
      expect(before).toHaveLength(1);

      const { reinforced } = await rejectAppliedChange({
        db,
        persona,
        correlationId: 'msg-1',
        scope: 'chat',
        key: 'greeting',
        actorId: 'user-9',
      });
      expect(reinforced).not.toBeNull();
      expect(reinforced?.confidence).toBeLessThan(0.7);

      // Subsequent behaviour: the decayed strategy is no longer recalled.
      const after = await memory.recall('chat', { key: 'greeting' });
      expect(after).toHaveLength(0);
    });
  });

  it('an inline correction supersedes the stored strategy value', async () => {
    await withTenant({ tenantId: TENANT }, async () => {
      // LearningMemory needs a resolved handle; borrow the collection's.
      const memory = personaLearningMemory({ db: feedbacks.db, persona });
      await memory.capture(
        { scope: 'chat', key: 'signoff', value: 'Best,' },
        { success: true },
      );

      const { feedback } = await correctResponse({
        db,
        persona,
        correlationId: 'msg-2',
        scope: 'chat',
        key: 'signoff',
        correction: 'Kind regards,',
        actorId: 'user-9',
      });
      expect(feedback.signalType).toBe('correction');
      expect(feedback.correction).toBe('Kind regards,');

      // The stored value was superseded (visible below the reuse floor).
      const [record] = await memory.recall('chat', {
        key: 'signoff',
        minConfidence: 0,
      });
      expect(record?.value).toBe('Kind regards,');
    });
  });

  it('thumbs up/down map to +1/-1 rating signals', async () => {
    await withTenant({ tenantId: TENANT }, async () => {
      const up = await thumbsUp({
        db,
        persona,
        correlationId: 'msg-3',
        scope: 'chat',
        key: 'tone',
      });
      const down = await thumbsDown({
        db,
        persona,
        correlationId: 'msg-4',
        scope: 'chat',
        key: 'tone',
      });
      expect(up.feedback.signalType).toBe('rating');
      expect(up.feedback.rating).toBe(1);
      expect(down.feedback.rating).toBe(-1);
    });
  });

  it('reinforcement is idempotently gated (reinforcedAt is stamped)', async () => {
    await withTenant({ tenantId: TENANT }, async () => {
      const { feedback } = await captureChatFeedback({
        db,
        persona,
        signalType: 'accept',
        correlationId: 'msg-5',
        scope: 'chat',
        key: 'greeting',
      });
      expect(feedback.reinforcedAt).not.toBeNull();
    });
  });

  it('can capture without reinforcing when reinforce=false', async () => {
    await withTenant({ tenantId: TENANT }, async () => {
      const { feedback, reinforced } = await captureChatFeedback({
        db,
        persona,
        signalType: 'reject',
        correlationId: 'msg-6',
        scope: 'chat',
        key: 'greeting',
        reinforce: false,
      });
      expect(reinforced).toBeNull();
      expect(feedback.reinforcedAt).toBeNull();
    });
  });

  it('throws when the persona has no id', async () => {
    await expect(
      captureChatFeedback({
        db,
        persona: { tenantId: TENANT, memoryScope: 'praeco:support' },
        signalType: 'accept',
        correlationId: 'msg-7',
        scope: 'chat',
        key: 'greeting',
      }),
    ).rejects.toThrow(/persisted persona/);
  });
});
