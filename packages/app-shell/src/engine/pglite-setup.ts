// Setup file of the engine suite's PostgreSQL pass (`vitest.pglite.config.ts`):
// a host opened without a database gets its own PGlite (schema `app`), as the
// desktop's would get SQLite. Not shipped behaviour: production hosts are told
// their database. The host's `close` also releases the PGlite it was given.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { harnessDatabase } from './db/harness.ts';
import { DRAFT_MARKER_FILE, readDraftMarker } from './draft.ts';
import { AppHost, type HostOptions } from './host.ts';

const open = AppHost.open.bind(AppHost);
AppHost.open = async (dataDir: string, opts: HostOptions) => {
  if (opts.database) return open(dataDir, opts);
  // A draft marker without a schema is a SQLite draft copy (a test that
  // writes one by hand): it stays SQLite, as `AppHost.open` requires.
  if (
    readDraftMarker(dataDir)?.schema === undefined &&
    existsSync(join(dataDir, DRAFT_MARKER_FILE))
  )
    return open(dataDir, opts);
  const db = await harnessDatabase(dataDir);
  try {
    const host = await open(dataDir, { ...opts, database: db.config });
    const close = host.close.bind(host);
    host.close = async () => {
      await close();
      await db.release?.();
    };
    return host;
  } catch (e) {
    await db.release?.();
    throw e;
  }
};
