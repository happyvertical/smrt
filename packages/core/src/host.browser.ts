/**
 * Browser build of `host.ts` (#2838): selected through `package.json#browser`.
 *
 * Persistence runs on `@happyvertical/sql/pglite`, the SDK's browser-safe
 * adapter. Driver-independent query helpers come from `@happyvertical/sql/query`.
 * The AI SDK and installed-package discovery have no browser build either.
 *
 * Every export is typed against `host.ts`, so the two cannot drift.
 */
import { getDatabase as getPGliteDatabase } from '@happyvertical/sql/pglite';
import {
  NestedTransactionError as SdkNestedTransactionError,
  buildWhere as sdkBuildWhere,
  raw as sdkRaw,
} from '@happyvertical/sql/query';
import type * as NodeHost from './host.js';

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

export const buildWhere: typeof NodeHost.buildWhere = sdkBuildWhere;
export const raw: typeof NodeHost.raw = sdkRaw;
export const NestedTransactionError: typeof NodeHost.NestedTransactionError =
  SdkNestedTransactionError;

export const importAI: typeof NodeHost.importAI = () =>
  Promise.reject(
    new Error('[smrt-core] AI providers are not available in the browser'),
  );

export const discoverInstalledSmrtPackages: typeof NodeHost.discoverInstalledSmrtPackages =
  async () => [];
