// The engine suite's PostgreSQL pass: one PGlite per data directory, owned by
// the test process (host thread), schema `app` created before the engine
// starts, as a real host's provisioning would. Loaded only when
// `SMRT_APP_SHELL_DB=pglite` is set.

import { join } from 'node:path';
import { importPGlite } from '@happyvertical/sql/pglite';
import type { HostDatabase, PGliteClient } from './types.ts';

const open = new Map<string, { client: PGliteClient; users: number }>();

export async function createSchema(client: PGliteClient, schema: string) {
  await client.exec(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
}

/** An app database in `schema` on the PGlite of `dir`, shared by every host on `dir`. */
export async function harnessDatabase(
  dir: string,
  schema = 'app',
): Promise<HostDatabase> {
  let entry = open.get(dir);
  if (!entry) {
    const { PGlite } = await importPGlite();
    entry = {
      client: (await PGlite.create(join(dir, 'pglite'))) as PGliteClient,
      users: 0,
    };
    open.set(dir, entry);
    await createSchema(entry.client, schema);
  }
  const mine = entry;
  mine.users++;
  return {
    config: { kind: 'pglite', schema, client: mine.client },
    async release() {
      if (--mine.users > 0) return;
      open.delete(dir);
      await mine.client.close();
    },
  };
}
