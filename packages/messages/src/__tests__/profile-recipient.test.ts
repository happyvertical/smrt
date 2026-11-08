import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import { vi } from 'vitest';
import { defineProfileRecipientSuite } from './helpers/profile-recipient-suite.js';

defineProfileRecipientSuite(async () => {
  const directory = await mkdtemp(join(tmpdir(), 'profile-recipient-race-'));
  const url = join(directory, 'fixture.sqlite');
  const db = await getTestDatabase({ type: 'sqlite', url });
  const { getDatabase } =
    await vi.importActual<typeof import('@happyvertical/sql')>(
      '@happyvertical/sql',
    );
  if (typeof db.url !== 'string')
    throw new Error('SQLite fixture must expose its actual shared URL.');
  const raceDb = await getDatabase({
    type: 'sqlite',
    url: db.url,
    cache: false,
  });
  return {
    db,
    raceDb,
    cleanup: async () => {
      await Promise.all([db.close?.(), raceDb.close?.()]);
      await rm(directory, { recursive: true, force: true });
    },
  };
}, 'sqlite');
