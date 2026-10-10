import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ProfileCollection,
  ProfileMetadataCollection,
  ProfileMetafieldCollection,
  ProfileTypeCollection,
} from '@happyvertical/smrt-profiles';
import { getDatabase } from '@happyvertical/sql';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEV_HELPER_PREFERENCES_METAFIELD } from '../../../dev-helper-server.js';

const state = vi.hoisted(() => ({ config: null as any }));
vi.mock('$app/environment', () => ({ dev: true }));
vi.mock('../dev-character-persistence/config.js', () => ({
  resolveDevCharacterPersistenceConfig: () => state.config,
  isLocalDevCharacterRequest: () => true,
}));

import { DELETE, GET, POST } from './+server.js';

const url = new URL('http://127.0.0.1:4189/api/dev-helper');
const event = (request: Request) =>
  ({ request, getClientAddress: () => '127.0.0.1' }) as Parameters<
    typeof POST
  >[0];
const preferences = (name: string) => ({
  version: 1,
  offeringId: 'happy',
  name,
  voiceId: 'marin',
  placement: 'bottom-right',
  heardSubtitles: true,
  spokenSubtitles: true,
});

async function seed() {
  const databaseUrl = `file:${join(tmpdir(), `dev-helper-concurrency-${randomUUID()}.db`)}`;
  const db = await getDatabase({ type: 'sqlite', url: databaseUrl });
  const types = await ProfileTypeCollection.create({ db });
  const type = await types.create({ name: 'Person' });
  await type.save();
  const profileId = `profile-${randomUUID()}`;
  const profiles = await ProfileCollection.create({ db });
  const profile = await profiles.create({
    id: profileId,
    typeId: type.id,
    name: 'Local helper',
    tenantId: 'tenant-a',
  });
  await profile.save();
  const fields = await ProfileMetafieldCollection.create({ db });
  const field = await fields.create({
    slug: DEV_HELPER_PREFERENCES_METAFIELD,
    name: 'Dev helper preferences',
    tenantId: 'tenant-a',
  });
  await field.save();
  state.config = {
    databaseUrl,
    assetDirectory: join(tmpdir(), `dev-helper-assets-${randomUUID()}`),
    profileId,
    tenantId: 'tenant-a',
  };
  return { db, profileId, fieldId: field.id as string };
}

describe('dev helper route concurrent first save', () => {
  beforeEach(() => {
    state.config = null;
  });

  it('serializes concurrent initial POST writes and retains one complete value', async () => {
    const { db, profileId, fieldId } = await seed();
    const [first, second] = await Promise.all([
      POST(
        event(
          new Request(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(preferences('First')),
          }),
        ),
      ),
      POST(
        event(
          new Request(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(preferences('Second')),
          }),
        ),
      ),
    ]);
    expect([first.status, second.status]).toEqual([200, 200]);
    const metadata = await ProfileMetadataCollection.create({ db });
    const rows = await metadata.list({
      where: { profileId, metafieldId: fieldId },
    });
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].value)).toMatchObject({
      name: expect.stringMatching(/First|Second/),
    });
    const loaded = await GET(event(new Request(url)));
    expect(loaded.status).toBe(200);
    expect((await loaded.json()).preferences).toMatchObject({
      name: expect.stringMatching(/First|Second/),
    });
    const cleared = await DELETE(event(new Request(url, { method: 'DELETE' })));
    expect(cleared.status).toBe(200);
    const after = await GET(event(new Request(url)));
    expect((await after.json()).preferences).toMatchObject({
      name: 'Happy',
      offeringId: 'happy',
    });
    await db.close?.();
  });
});
