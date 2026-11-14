import { ObjectRegistry } from '@happyvertical/smrt-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { snapshotObjectRegistryState } from '../../../core/src/test-utils.js';
import { Comment } from '../models/Comment.js';
import { CommentService } from '../services/CommentService.js';
import { ParticipationService } from '../services/ParticipationService.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const userId = '22222222-2222-4222-8222-222222222222';
const mention = '33333333-3333-4333-8333-333333333333';

describe.each([
  false,
  true,
])('#4931 comment preparation app replacement=%s', (replace) => {
  let restore: () => void;
  let expected: typeof Comment;
  beforeEach(async () => {
    restore = snapshotObjectRegistryState();
    expect(ObjectRegistry.getClassByConstructor(Comment)?.constructor).toBe(
      Comment,
    );
    expected = replace
      ? (await import('./issue-4931-app.fixture.js')).registerAppModels()
          .Comment
      : Comment;
    expect(ObjectRegistry.resolveEffectiveConstructor(Comment)).toBe(expected);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    restore();
  });

  it('validates mentions on the effective Comment before initialization or persistence', async () => {
    const setter = vi.spyOn(Comment.prototype, 'mentionUserIds', 'set');
    const initialize = vi.spyOn(Comment.prototype, 'initialize');
    const save = vi.spyOn(Comment.prototype, 'save');
    vi.spyOn(ParticipationService.prototype, 'authorize').mockResolvedValue({
      allowed: true,
    } as never);
    const service = new CommentService({
      db: {} as never,
      actor: { tenantId, userId },
      authorizeRecord: async () => true,
    });
    // Invalid key stops after model normalization and before any DB operation.
    await expect(
      service.create({
        tenantId,
        authorUserId: userId,
        metaType: '@local/app:Record',
        metaId: 'record',
        body: 'body',
        mentions: [mention, mention],
        idempotencyKey: '',
      }),
    ).rejects.toThrow('Comment idempotencyKey');
    expect(setter).toHaveBeenCalledOnce();
    const prepared = setter.mock.contexts[0] as Comment;
    expect(prepared.constructor).toBe(expected);
    expect(prepared.mentionUserIds).toEqual([mention]);
    expect(initialize).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });
});
