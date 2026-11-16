import { createLogger } from '@happyvertical/logger';
import type { DatabaseInterface } from '@happyvertical/sql';
import { getVerificationKey } from '../table-cache.js';

const logger = createLogger({ level: 'info' });

/**
 * Who builds a runtime-managed database's schema, and why core's migrate does
 * not. Both are required and are kept with the handle so a refusal or an audit
 * can name them.
 */
export interface RuntimeManagedDatabaseDeclaration {
  /** The package that opens the database and builds its schema, e.g. `@happyvertical/smrt-app-shell`. */
  owner: string;
  /** Why core's migrate never runs against it, in one sentence. */
  reason: string;
}

// Keyed by the handle and by its driver client: a transaction handle is a new
// object over the same client, so it stays declared; a second handle opened
// on the same file has its own client and is not.
//
// A declaration is keyed by object identity only: no file path, and it is not
// shared across threads (a worker thread has its own module instance and
// registry). The app-shell engine therefore declares in `AppRuntime.boot`, once
// per handle it opens: each engine worker is its own thread with its own
// handle, and a new worker is spawned on every definition change; a draft copy
// or publish rehearsal is a different file with its own handle. Each of those
// boots declares its own handle; none inherits another's.
const declaredHandles = new WeakMap<
  object,
  RuntimeManagedDatabaseDeclaration
>();
const declaredClients = new WeakMap<
  object,
  RuntimeManagedDatabaseDeclaration
>();

/**
 * What identifies the database in the log: the key the startup check already
 * uses (id, file path, or connection URL). A URL loses its credentials and
 * query string.
 */
function describeDatabase(db: DatabaseInterface): string {
  const key = getVerificationKey(db);
  if (!key.includes('://')) return key;
  try {
    const url = new URL(key);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return '(unparseable connection URL)';
  }
}

function clientOf(db: DatabaseInterface): object | undefined {
  const client = (db as { client?: unknown }).client;
  return client && typeof client === 'object' ? client : undefined;
}

/**
 * Declare that the code which just opened `db` builds and versions its schema
 * itself, so core's migrate never runs against it and the startup check
 * (`assertDatabaseMigratedForBuild`) must not compare its migrate record with
 * the build's stamp. Everything else still applies to the handle: collections
 * still verify that each table exists.
 *
 * Call it once, where the handle is opened. Inside this repository, callers
 * are limited to an allow-list (`scripts/check-runtime-managed-databases.mjs`);
 * that check cannot see other repositories, so outside it the declaration is
 * the app author's own choice. For that reason the first declaration of each
 * handle is logged at `info` (owner, reason, database), and the function is
 * exported from `@happyvertical/smrt-core/migrations` only.
 */
export function declareRuntimeManagedDatabase(
  db: DatabaseInterface,
  declaration: RuntimeManagedDatabaseDeclaration,
): void {
  const owner = declaration?.owner?.trim();
  const reason = declaration?.reason?.trim();
  if (!db || typeof db !== 'object')
    throw new TypeError(
      'declareRuntimeManagedDatabase needs a database handle',
    );
  if (!owner || !reason)
    throw new TypeError(
      'declareRuntimeManagedDatabase needs an owner and a reason',
    );
  const record = Object.freeze({ owner, reason });
  if (!declaredHandles.has(db))
    logger.info(
      `Runtime-managed database declared: owner ${owner}; reason: ${reason}; database ${describeDatabase(db)}. ` +
        "Core's migrate-record and build-stamp check is skipped for this handle.",
    );
  declaredHandles.set(db, record);
  const client = clientOf(db);
  if (client) declaredClients.set(client, record);
}

/** The declaration covering `db` (the handle itself or its client), if any. */
export function runtimeManagedDatabaseDeclaration(
  db: DatabaseInterface,
): RuntimeManagedDatabaseDeclaration | undefined {
  if (!db || typeof db !== 'object') return undefined;
  const direct = declaredHandles.get(db);
  if (direct) return direct;
  const client = clientOf(db);
  return client ? declaredClients.get(client) : undefined;
}
