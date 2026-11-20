// Setup file of the engine suite's PostgreSQL pass (`vitest.pglite.config.ts`):
// a host opened without a database gets its own PGlite (schema `app`), as the
// desktop's would get SQLite. Not shipped behaviour: production hosts are told
// their database. The host's `close` also releases the PGlite it was given.
import { harnessDatabase } from './db/harness.ts';
import { AppHost, type HostOptions } from './host.ts';

const open = AppHost.open.bind(AppHost);
AppHost.open = async (dataDir: string, opts: HostOptions) => {
  if (opts.database) return open(dataDir, opts);
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
