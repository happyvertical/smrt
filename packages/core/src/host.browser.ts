/**
 * Browser build of `host.ts` (#2838): selected through `package.json#browser`.
 *
 * Persistence runs on `@happyvertical/sql/pglite`, the SDK's browser-safe
 * adapter. The SDK exposes only `getDatabase` there, so the other SQL helpers
 * `host.ts` forwards from the package root (`buildWhere`, `raw`,
 * `NestedTransactionError`) have no browser-safe source yet and throw when
 * used; collection queries need them. Tracked as the SDK follow-up to #2838.
 * The AI SDK and installed-package discovery have no browser build either.
 *
 * Every export is typed against `host.ts`, so the two cannot drift.
 */
import { getDatabase as getPGliteDatabase } from '@happyvertical/sql/pglite';
import type * as NodeHost from './host.js';

const SQL_FOLLOW_UP =
  'needs a browser-safe export from @happyvertical/sql (tracked as the SDK follow-up to smrt#2838)';

/**
 * Opens a PGlite database. Rejects the other engines, which are Node-only,
 * instead of silently opening something different from what was asked.
 */
export const getDatabase: typeof NodeHost.getDatabase = (options) => {
  const requested = (options as { type?: string } | undefined)?.type;
  if (requested !== undefined && requested !== 'pglite') {
    throw new Error(
      `[smrt-core] Database type "${requested}" is not available in the browser; use type "pglite"`,
    );
  }
  return getPGliteDatabase(options as Parameters<typeof getPGliteDatabase>[0]);
};

export const buildWhere: typeof NodeHost.buildWhere = () => {
  throw new Error(`[smrt-core] buildWhere ${SQL_FOLLOW_UP}`);
};

export const raw: typeof NodeHost.raw = () => {
  throw new Error(`[smrt-core] raw ${SQL_FOLLOW_UP}`);
};

/**
 * Stand-in for the SDK's `NestedTransactionError`, which has no browser-safe
 * export. `instanceof` against it is always false for errors the PGlite
 * adapter throws, so callers rethrow them, the safe default.
 */
export const NestedTransactionError: typeof NodeHost.NestedTransactionError =
  class NestedTransactionError extends Error {} as typeof NodeHost.NestedTransactionError;

export const importAI: typeof NodeHost.importAI = () =>
  Promise.reject(
    new Error('[smrt-core] AI providers are not available in the browser'),
  );

export const discoverInstalledSmrtPackages: typeof NodeHost.discoverInstalledSmrtPackages =
  async () => [];
