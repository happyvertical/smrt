// The hosted receiver of a desktop user app (#5193): install a portable bundle
// (`exportUserApp`, `smrt app export`) as the signed-in owner's app in the
// shared multi-tenant PostgreSQL, in the schema the host chose for THAT tenant.
//
// The tenant is the verified owner's (`assertOwner`, never an argument or a
// field of the bundle), the schema comes from the host's own tenant and app
// ids (`appSchemaName`), and nothing is ever overwritten: the target must be a
// tenant whose app has never held content. Resumable and idempotent in the
// engine's own way (`importUserApp`: a crash leaves empty tables or
// everything, a rerun converges; a target that already matches is left alone)
// and followed by a verification pass that compares counts and digests per
// table and the version history, which is what the result reports.
import { existsSync } from 'node:fs';
import type { DatabaseInterface } from '@happyvertical/sql';
import {
  checkUserAppBundle,
  EngineError,
  importUserApp,
  type PortableUserApp,
  type VersionRecord,
  verifyUserApp,
} from '../../engine/index.ts';
import {
  appSchemaName,
  assertNothingPending,
  closeOwnApp,
  dataRoot,
  getShellDb,
  requireAppDatabase,
  requireCloudProfile,
  safeId,
  tenantAppDirs,
} from './host.ts';
import { assertOwner } from './owner.ts';
import { ShellVersionStore } from './version-store.ts';

/** The completion fact recorded once, in the app's own schema, with the import's commit. */
export const RECEIVE_COMPLETION_KEY = 'user-app-received';

export interface ReceiveUserAppResult {
  /** `already-received`: the schema and the history already held this bundle. */
  status: 'received' | 'already-received';
  tables: number;
  rows: number;
  digest: string;
  /** The verification pass: every table's counts and digests, and the history, agree. */
  verified: true;
}

/** Versions compared on what the engine reads: number, parent, definition, migration. */
function shape(v: VersionRecord): string {
  return JSON.stringify([v.version, v.parent, v.definition, v.migration]);
}

/** Is `existing` the engine's own first, empty version (an app nobody has built in)? */
function isEmptyStart(existing: VersionRecord[]): boolean {
  return (
    existing.length === 1 &&
    existing[0].version === 0 &&
    existing[0].author === 'engine' &&
    Object.keys(existing[0].definition.models ?? {}).length === 0
  );
}

/**
 * Install `bundle` as the signed-in owner's app. Hosted profile with
 * `appDatabase` only. Refuses (nothing written) when the bundle does not check
 * against itself, when the tenant's app already has content or a draft, or when
 * it still lives in a SQLite file (use the migration).
 */
export async function receiveOwnUserApp(
  bundle: PortableUserApp,
): Promise<ReceiveUserAppResult> {
  await requireCloudProfile('Receiving a user app');
  const owner = await assertOwner();
  const tenant = safeId(owner.tenantId, 'the tenant');
  const problems = checkUserAppBundle(bundle);
  if (problems.length)
    throw new EngineError(
      `The user app is not usable: ${problems[0]}.`,
      'invalid',
    );
  const provider = requireAppDatabase();
  const db: DatabaseInterface = await getShellDb();
  const store = new ShellVersionStore(db, tenant);
  const app = await store.appRow();
  const { live, draft } = tenantAppDirs(
    await dataRoot(),
    tenant,
    app.id as string,
  );
  if (existsSync(`${live}/app.db`))
    throw new EngineError(
      'this app lives in a SQLite file; migrate it instead of receiving another',
      'refused',
    );
  await assertNothingPending(db, tenant, draft, 'receiving an app');

  const existing = await store.list();
  const incoming = bundle.versions;
  const placed =
    existing.length === incoming.length &&
    existing.every((v, i) => shape(v) === shape(incoming[i]));
  if (!placed && existing.length > 0 && !isEmptyStart(existing))
    throw new EngineError(
      'this tenant already has an app with content; nothing was overwritten',
      'refused',
    );
  const starts = incoming[0];
  if (!placed && existing.length === 1 && shape(existing[0]) !== shape(starts))
    throw new EngineError(
      'the bundle does not start from the empty app; nothing was overwritten',
      'refused',
    );

  await closeOwnApp();
  const schema = appSchemaName(tenant, app.id as string);
  await provider.provision(schema);
  // The history first, in one shell transaction with the pointer (versions
  // already stored, a rerun or the empty start, are skipped). If the app is
  // opened before the rows are in, it boots at the bundle's version on empty
  // tables (the engine's own migration), and the rows still go in; the other
  // order would let that open rewrite the schema's record to the empty app and
  // refuse every rerun.
  if (!placed) {
    const have = new Set(existing.map((v) => v.version));
    await store.commit(
      incoming.filter((v) => !have.has(v.version)),
      bundle.version,
    );
  }
  const imported = await importUserApp({
    dataDir: live,
    database: provider.config(schema),
    bundle,
    tenantId: tenant,
    completion: {
      key: RECEIVE_COMPLETION_KEY,
      value: JSON.stringify({ digest: bundle.digest, version: bundle.version }),
    },
  });

  // The verification pass: tables (counts and digests), meta, then the history.
  const found = await verifyUserApp({
    dataDir: live,
    bundle,
    database: provider.config(schema),
    tenantId: tenant,
  });
  const after = await store.list();
  const historyOk =
    after.length === incoming.length &&
    after.every((v, i) => shape(v) === shape(incoming[i])) &&
    (await store.current()) === bundle.version;
  if (!found.ok || !historyOk)
    throw new EngineError(
      'the received app did not verify against the bundle; it was not opened. Rerun the receive to converge, or ask the operator.',
      'refused',
    );
  return {
    status:
      placed && imported.status === 'already-imported'
        ? 'already-received'
        : 'received',
    tables: imported.tables,
    rows: imported.rows,
    digest: imported.digest,
    verified: true,
  };
}
