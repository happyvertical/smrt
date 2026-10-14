/**
 * Regression for #2938: `ChatRoom`'s natural key includes the name-derived
 * slug, so two rooms created with the same name in one tenant upserted onto
 * each other and the first room's threads were re-parented to the second
 * person's room. Since #3313 a taken derived slug moves to a free one and the
 * new room inserts.
 */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ChatService } from '../services/ChatService.js';

describe('same-named rooms in one tenant (#2938)', () => {
  const dbPath = join(tmpdir(), `smrt-chat-same-name-${Date.now()}.db`);

  afterEach(() => {
    if (existsSync(dbPath)) rmSync(dbPath, { force: true });
  });

  it('creates distinct rooms and keeps each thread in its own room', async () => {
    const service = await ChatService.create({
      db: { type: 'sqlite', url: dbPath },
    });
    const a = await service.createRoom({
      tenantId: 't1',
      name: 'Assistant',
      roomType: 'agent',
      actorProfileId: 'profile-a',
    });
    const thread = await service.startThread({
      tenantId: 't1',
      roomId: String(a.id),
      actorProfileId: 'profile-a',
      title: 'Mine',
    });

    const b = await service.createRoom({
      tenantId: 't1',
      name: 'Assistant',
      roomType: 'agent',
      actorProfileId: 'profile-b',
    });

    expect(b.id).not.toBe(a.id);
    expect(b.slug).not.toBe(a.slug);
    const reread = await service.getThread({
      threadId: String(thread.id),
      tenantId: 't1',
    });
    expect(reread?.roomId).toBe(a.id);
  });
});
