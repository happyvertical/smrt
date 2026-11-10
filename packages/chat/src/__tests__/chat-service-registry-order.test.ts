/**
 * Regression for #3723: a host that asked the object registry for a chat
 * collection before `ChatService.create()` had registered the package's own
 * collection classes got a cached generic `SmrtCollection`, and ChatService
 * then failed with `isActiveMember is not a function`.
 *
 * Kept in its own file so no earlier `ChatService.create()` in the same module
 * graph has already registered the collections.
 */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ObjectRegistry } from '@happyvertical/smrt-core';
import { afterEach, describe, expect, it } from 'vitest';
import { ChatParticipantCollection } from '../collections/ChatParticipantCollection.js';
import { ChatRoomCollection } from '../collections/ChatRoomCollection.js';
import { ChatService } from '../services/ChatService.js';

describe('ChatService registry order (#3723)', () => {
  const dbPath = join(tmpdir(), `smrt-chat-registry-order-${Date.now()}.db`);

  afterEach(() => {
    if (existsSync(dbPath)) rmSync(dbPath, { force: true });
  });

  it('works when a chat collection was fetched from the registry first', async () => {
    const options = { db: { type: 'sqlite' as const, url: dbPath } };
    await ObjectRegistry.getCollection(
      '@happyvertical/smrt-chat:ChatParticipant',
      options,
    );
    await ObjectRegistry.getCollection(
      '@happyvertical/smrt-chat:ChatRoom',
      options,
    );

    const chat = await ChatService.create(options);
    const room = await chat.createRoom({
      tenantId: 'tenant-1',
      name: 'General',
      roomType: 'public',
      actorProfileId: 'profile-1',
    });
    const message = await chat.sendMessage({
      tenantId: 'tenant-1',
      roomId: String(room.id),
      actorProfileId: 'profile-1',
      content: 'hello',
    });
    expect(message.content).toBe('hello');

    expect(
      await ObjectRegistry.getCollection(
        '@happyvertical/smrt-chat:ChatParticipant',
        options,
      ),
    ).toBeInstanceOf(ChatParticipantCollection);
    expect(
      await ObjectRegistry.getCollection(
        '@happyvertical/smrt-chat:ChatRoom',
        options,
      ),
    ).toBeInstanceOf(ChatRoomCollection);
  });
});
