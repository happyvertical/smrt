/**
 * Logical application export/import (schemaVersion 2 bundles).
 *
 * Ported unchanged from the template's `scripts/smrt-portability.mjs`: the
 * bundle shape, non-portable table/column rules, parent-first import plan,
 * empty-target rule, and asset staging/recovery are a persisted contract.
 */

import { randomBytes } from 'node:crypto';
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { DatabaseInterface } from '@happyvertical/sql';
import { errorCode } from './errors.js';
import { assertExternalArtifactPath } from './identity.js';
import {
  type AssetBundle,
  bundleContentDigest,
  collectFilesystemAssets,
  finishFilesystemAssets,
  MAX_BUNDLE_BYTES,
  type PortableRow,
  type PortableTable,
  publishFilesystemAssets,
  readSensitiveBundle,
  recoverFilesystemAssets,
  rollbackFilesystemAssets,
  stageFilesystemAssets,
  verifyFilesystemAssets,
  verifyPublishedFilesystemAssets,
} from './portability-assets.js';

const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const NON_PORTABLE_TABLE_PATTERN =
  /(?:^|_)(?:api_keys?|audit_logs?|auth_approve_limits?|auth_requests?|bootstrap|credentials?|magic_link_tokens?|secrets?|sessions?|tokens?)(?:_|$)/;
const NON_PORTABLE_COLUMN_PATTERN =
  /(?:^|_)(?:api_key|ciphertext|cookie|credential|encrypted|encryption|password|private_key|privkey|secret|token)(?:_|$)/;

/** Column definition fields the import planner reads from the manifest. */
export interface PortableColumnDefinition {
  primaryKey?: boolean;
  notNull?: boolean;
  foreignKey?: { table?: string };
  [key: string]: unknown;
}

/** Manifest-derived application table. */
export interface ManifestTable {
  name: string;
  columns: string[];
  columnDefinitions: Record<string, PortableColumnDefinition>;
  foreignKeys: Array<{ column: string; referencesTable: string }>;
  primaryKeys: string[];
}

/** Planned import step; `deferredColumns` are filled by a later UPDATE. */
export interface PlannedImportTable extends ManifestTable {
  deferredColumns: Set<string>;
}

/** A schemaVersion-2 logical bundle. */
export interface LogicalExportBundle {
  schemaVersion: 2;
  application: string;
  profile: string;
  exportedAt: string;
  tables: PortableTable[];
  assets: AssetBundle;
}

/** Runtime selection the adapter needs. */
export interface PortabilityRuntime {
  profile: string;
  providers: { database: { engine: string } };
}

/** Context for {@link exportApplication} / {@link importApplication}. */
export interface PortabilityContext {
  appId: string;
  sourceRoot: string;
  stateRoot: string;
  runtime: PortabilityRuntime;
  env: Record<string, string | undefined>;
  paths: { root: string; assets: string } | null;
  assetRoot: string | null;
  path?: string;
  /** Test seam: observe import phases (`assets-staged`, …). */
  onImportPhase?: (phase: string) => Promise<void> | void;
  /** Test seam: replace the database opener. */
  openDatabase?: (
    options: Record<string, unknown>,
  ) => Promise<DatabaseInterface>;
}

function quoteIdentifier(value: string): string {
  if (!SAFE_IDENTIFIER.test(value)) {
    throw new Error(
      'The generated manifest contains an unsafe SQL identifier.',
    );
  }
  return `"${value}"`;
}

function containsNonPortableRows(table: ManifestTable): boolean {
  return (
    NON_PORTABLE_TABLE_PATTERN.test(table.name) ||
    table.columns.some((column) => NON_PORTABLE_COLUMN_PATTERN.test(column))
  );
}

/** Read the application tables from `<sourceRoot>/.smrt/manifest.json`. */
export function manifestTables(sourceRoot: string): ManifestTable[] {
  const manifestPath = join(sourceRoot, '.smrt', 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error(
      'Build the application before exporting or importing data.',
    );
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    objects?: Record<string, unknown>;
  };
  const tables = new Map<string, ManifestTable>();
  for (const rawDefinition of Object.values(manifest.objects || {})) {
    const definition = rawDefinition as {
      className?: string;
      schema?: {
        tableName?: string;
        columns?: Record<string, PortableColumnDefinition>;
      };
    } | null;
    const schema = definition?.schema;
    if (definition?.className?.endsWith('Collection')) continue;
    if (!schema?.tableName || schema.tableName.startsWith('_smrt_')) continue;
    const columnDefinitions = schema.columns || {};
    const columns = Object.keys(columnDefinitions);
    if (columns.length === 0) continue;
    const foreignKeys = Object.entries(columnDefinitions).flatMap(
      ([column, columnDefinition]) =>
        columnDefinition.foreignKey?.table
          ? [{ column, referencesTable: columnDefinition.foreignKey.table }]
          : [],
    );
    const primaryKeys = Object.entries(columnDefinitions)
      .filter(([, columnDefinition]) => columnDefinition.primaryKey)
      .map(([column]) => column);
    tables.set(schema.tableName, {
      name: schema.tableName,
      columns,
      columnDefinitions,
      foreignKeys,
      primaryKeys,
    });
  }
  return [...tables.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}

/** Parent-first insertion plan with nullable cycle edges deferred to updates. */
export function planImportTables(
  tables: ManifestTable[],
): PlannedImportTable[] {
  const remaining = new Map(tables.map((table) => [table.name, table]));
  const inserted = new Set<string>();
  const plan: PlannedImportTable[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining.values()]
      .filter((table) =>
        table.foreignKeys.every(
          (foreignKey) =>
            foreignKey.referencesTable === table.name ||
            !remaining.has(foreignKey.referencesTable) ||
            inserted.has(foreignKey.referencesTable),
        ),
      )
      .sort((left, right) => left.name.localeCompare(right.name));
    const table =
      ready[0] ||
      [...remaining.values()].sort((left, right) =>
        left.name.localeCompare(right.name),
      )[0];
    const deferredColumns = new Set(
      table.foreignKeys
        .filter(
          (foreignKey) =>
            foreignKey.referencesTable === table.name ||
            remaining.has(foreignKey.referencesTable),
        )
        .map((foreignKey) => foreignKey.column),
    );
    plan.push({ ...table, deferredColumns });
    inserted.add(table.name);
    remaining.delete(table.name);
  }
  return plan;
}

async function withDatabase<T>(
  context: PortabilityContext,
  callback: (db: DatabaseInterface) => Promise<T>,
): Promise<T> {
  const options: Record<string, unknown> = {
    type: context.runtime.providers.database.engine,
    url: context.env.DATABASE_URL,
  };
  if (context.runtime.profile === 'local') {
    options.secureFile = {
      driver: 'node:sqlite',
      custody: 'trusted-parent',
      root: context.paths?.root,
    };
  }
  const open =
    context.openDatabase ??
    (async (databaseOptions: Record<string, unknown>) => {
      const { getDatabase } = await import('@happyvertical/sql');
      return getDatabase(
        databaseOptions as Parameters<typeof getDatabase>[0],
      ) as Promise<DatabaseInterface>;
    });
  const db = await open(options);
  try {
    return await callback(db);
  } finally {
    await db.close?.();
  }
}

/** Reject bundles that do not exactly match the generated schema. */
export function validateImportBundle(
  bundle: { tables: unknown[] },
  expected: Map<string, Pick<ManifestTable, 'name' | 'columns'>>,
): void {
  const providedNames = bundle.tables.map(
    (table) => (table as { name?: unknown } | null)?.name,
  );
  if (
    providedNames.length !== expected.size ||
    new Set(providedNames).size !== expected.size ||
    providedNames.some((name) => !expected.has(name as string))
  ) {
    throw new Error(
      'The export does not contain the complete application schema.',
    );
  }
  for (const rawExported of bundle.tables) {
    const exported = rawExported as Partial<PortableTable>;
    const table = expected.get(exported.name as string);
    if (
      !table ||
      !Array.isArray(exported.rows) ||
      !Array.isArray(exported.columns)
    ) {
      throw new Error(
        'The export does not match the generated application schema.',
      );
    }
    if (
      exported.columns.length !== table.columns.length ||
      new Set(exported.columns).size !== table.columns.length ||
      exported.columns.some((column) => !table.columns.includes(column))
    ) {
      throw new Error(`The export schema does not match ${table.name}.`);
    }
    for (const row of exported.rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) {
        throw new Error(`The export has an invalid row for ${table.name}.`);
      }
      const columns = Object.keys(row);
      if (
        columns.length !== table.columns.length ||
        columns.some((column) => !table.columns.includes(column))
      ) {
        throw new Error(`The export has incomplete columns for ${table.name}.`);
      }
    }
  }
}

/** JSON cannot represent SQLite's lossless BigInt results; decimal strings do. */
export function serializeExportBundle(bundle: unknown): string {
  return JSON.stringify(
    bundle,
    (_key, value) => (typeof value === 'bigint' ? value.toString() : value),
    2,
  );
}

/** Result reported by `smrt app export`. */
export interface ExportResult {
  path: string;
  tableCount: number;
  assetsIncluded: true;
  assetCount: number;
}

/** Write a logical export bundle without replacing an existing file. */
export async function exportApplication(
  context: PortabilityContext,
): Promise<ExportResult> {
  const tables = manifestTables(context.sourceRoot);
  let bundle: LogicalExportBundle | undefined;
  await withDatabase(context, async (db) => {
    if (typeof db.transaction !== 'function') {
      throw new Error(
        'Logical export requires transactional database support.',
      );
    }
    bundle = (await db.transaction(async (tx) => {
      if (context.runtime.providers.database.engine === 'postgres') {
        await tx.query(
          'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
        );
      }
      const exported: Omit<LogicalExportBundle, 'assets'> & {
        assets?: AssetBundle;
      } = {
        schemaVersion: 2,
        application: context.appId,
        profile: context.runtime.profile,
        exportedAt: new Date().toISOString(),
        tables: [],
      };
      for (const table of tables) {
        exported.tables.push({
          name: table.name,
          columns: table.columns,
          rows: containsNonPortableRows(table)
            ? []
            : ((
                await tx.query(
                  `SELECT ${table.columns.map(quoteIdentifier).join(', ')} FROM ${quoteIdentifier(table.name)}`,
                )
              ).rows as PortableRow[]),
        });
      }
      exported.assets = collectFilesystemAssets({
        tables: exported.tables,
        sourceRoot: context.sourceRoot,
        assetRoot: context.assetRoot || context.paths?.assets,
      });
      return exported as LogicalExportBundle;
    })) as LogicalExportBundle;
  });
  const exportedBundle = bundle as LogicalExportBundle;
  const outputPath = assertExternalArtifactPath({
    sourceRoot: context.sourceRoot,
    path:
      context.path ||
      join(context.stateRoot, 'exports', `${context.appId}-${Date.now()}.json`),
    label: 'Export destination',
  });
  mkdirSync(dirname(outputPath), { recursive: true, mode: 0o700 });
  const temporaryPath = join(
    dirname(outputPath),
    `.${basename(outputPath)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`,
  );
  const serialized = `${serializeExportBundle(exportedBundle)}\n`;
  if (Buffer.byteLength(serialized) > MAX_BUNDLE_BYTES) {
    throw new Error('The portability bundle exceeds the supported size limit.');
  }
  try {
    writeFileSync(temporaryPath, serialized, { flag: 'wx', mode: 0o600 });
    // A same-filesystem hard link publishes the complete mode-0600 inode
    // atomically and fails rather than following or replacing a destination.
    try {
      linkSync(temporaryPath, outputPath);
    } catch (error) {
      if (errorCode(error) === 'EEXIST') {
        throw new Error(`Export destination already exists: ${outputPath}`);
      }
      throw error;
    }
  } finally {
    rmSync(temporaryPath, { force: true });
  }
  return {
    path: outputPath,
    tableCount: exportedBundle.tables.length,
    assetsIncluded: true,
    assetCount: exportedBundle.assets.entries.length,
  };
}

/** Minimal query surface the import plan needs (a transaction handle). */
export interface ImportExecutor {
  query(
    sql: string,
    ...params: unknown[]
  ): Promise<{ rows: Array<Record<string, unknown>> }>;
}

/** Execute a prevalidated parent-first import against one database transaction. */
export async function executeImportPlan(
  tx: ImportExecutor,
  plan: PlannedImportTable[],
  exportedByName: Map<string, { rows: PortableRow[] }>,
): Promise<number> {
  const deferredUpdates: Array<{
    table: PlannedImportTable;
    column: string;
    value: unknown;
    primaryKey: string;
    primaryValue: unknown;
  }> = [];
  let rowCount = 0;
  for (const table of plan) {
    const exported = exportedByName.get(table.name) as { rows: PortableRow[] };
    const count = await tx.query(
      `SELECT COUNT(*) AS count FROM ${quoteIdentifier(table.name)}`,
    );
    if (Number(count.rows[0]?.count || 0) !== 0) {
      throw new Error(`Import target table ${table.name} is not empty.`);
    }
    for (const row of exported.rows) {
      const columns = Object.keys(row);
      await tx.query(
        `INSERT INTO ${quoteIdentifier(table.name)} (${columns.map(quoteIdentifier).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
        ...columns.map((column) =>
          table.deferredColumns.has(column) ? null : row[column],
        ),
      );
      for (const column of table.deferredColumns) {
        if (row[column] != null) {
          deferredUpdates.push({
            table,
            column,
            value: row[column],
            primaryKey: table.primaryKeys[0],
            primaryValue: row[table.primaryKeys[0]],
          });
        }
      }
      rowCount += 1;
    }
  }
  for (const update of deferredUpdates) {
    await tx.query(
      `UPDATE ${quoteIdentifier(update.table.name)} SET ${quoteIdentifier(update.column)} = ? WHERE ${quoteIdentifier(update.primaryKey)} = ?`,
      update.value,
      update.primaryValue,
    );
  }
  return rowCount;
}

async function inspectImportTarget(
  db: ImportExecutor,
  plan: PlannedImportTable[],
  exportedByName: Map<string, { rows: PortableRow[] }>,
): Promise<'empty' | 'complete' | 'dirty'> {
  let empty = true;
  let complete = true;
  for (const table of plan) {
    const count = await db.query(
      `SELECT COUNT(*) AS count FROM ${quoteIdentifier(table.name)}`,
    );
    const actual = Number(count.rows[0]?.count || 0);
    const expected = (exportedByName.get(table.name) as { rows: unknown[] })
      .rows.length;
    if (actual !== 0) empty = false;
    if (actual !== expected) complete = false;
  }
  if (empty) return 'empty';
  if (complete) return 'complete';
  return 'dirty';
}

/** Result reported by `smrt app import`. */
export interface ImportResult {
  path: string;
  rowCount: number;
  assetsIncluded: true;
  assetCount: number;
}

/** Import a logical bundle into an empty application database. */
export async function importApplication(
  context: PortabilityContext,
): Promise<ImportResult> {
  if (!context.path) {
    throw new Error('Usage: pnpm app:import -- /absolute/path/export.json');
  }
  const serialized = readSensitiveBundle(context.path);
  const bundle = JSON.parse(serialized) as Omit<
    Partial<LogicalExportBundle>,
    'schemaVersion'
  > & { schemaVersion?: unknown };
  if (bundle.schemaVersion === 1) {
    throw new Error(
      'Database-only logical export bundles are not importable; create a new asset-aware export.',
    );
  }
  if (bundle.schemaVersion !== 2 || !Array.isArray(bundle.tables)) {
    throw new Error('Unsupported logical export bundle.');
  }
  if (bundle.application !== context.appId) {
    throw new Error('The export belongs to a different application.');
  }
  const tables = bundle.tables;
  const expected = new Map(
    manifestTables(context.sourceRoot).map((table) => [table.name, table]),
  );
  validateImportBundle({ tables }, expected);
  const exportedByName = new Map(tables.map((table) => [table.name, table]));
  const plan = planImportTables([...expected.values()]);
  for (const table of plan) {
    const exported = exportedByName.get(table.name) as PortableTable;
    for (const column of table.deferredColumns) {
      if (
        table.columnDefinitions[column]?.notNull &&
        exported.rows.some((row) => row[column] != null)
      ) {
        throw new Error(
          `Import cannot safely defer required cyclic reference ${table.name}.${column}.`,
        );
      }
    }
    if (table.deferredColumns.size > 0 && table.primaryKeys.length !== 1) {
      throw new Error(
        `Import cannot update cyclic references for ${table.name} without one primary key.`,
      );
    }
  }
  const assetRoot = context.assetRoot || context.paths?.assets || null;
  const verifiedAssets = verifyFilesystemAssets({
    assetBundle: bundle.assets,
    tables,
    sourceRoot: context.sourceRoot,
    assetRoot,
  });
  const bundleDigest = bundleContentDigest(serialized);
  const totalRows = () =>
    tables.reduce((count, table) => count + table.rows.length, 0);
  let rowCount = 0;
  await withDatabase(context, async (db) => {
    if (typeof db.transaction !== 'function') {
      throw new Error(
        'Logical import requires transactional database support.',
      );
    }
    const executor = db as unknown as ImportExecutor;
    let targetState = await inspectImportTarget(executor, plan, exportedByName);
    if (verifiedAssets.root) {
      const recovery = recoverFilesystemAssets({
        stateRoot: context.stateRoot,
        appId: context.appId,
        bundleDigest,
        assetRoot: verifiedAssets.root,
        targetState,
      });
      if (recovery === 'complete') {
        rowCount = totalRows();
        return;
      }
      if (recovery === 'retry') {
        targetState = await inspectImportTarget(executor, plan, exportedByName);
      }
    }
    if (targetState !== 'empty') {
      throw new Error('Import target is not empty.');
    }
    const staged = stageFilesystemAssets({
      verified: verifiedAssets,
      stateRoot: context.stateRoot,
      appId: context.appId,
      bundleDigest,
    });
    try {
      await context.onImportPhase?.('assets-staged');
      await db.transaction(async (tx) => {
        publishFilesystemAssets(staged);
        await context.onImportPhase?.('assets-published');
        rowCount = await executeImportPlan(
          tx as unknown as ImportExecutor,
          plan,
          exportedByName,
        );
        await context.onImportPhase?.('database-staged');
        verifyPublishedFilesystemAssets(staged);
      });
      finishFilesystemAssets(staged);
    } catch (error) {
      const stateAfterFailure = await inspectImportTarget(
        executor,
        plan,
        exportedByName,
      );
      if (stateAfterFailure === 'complete') {
        finishFilesystemAssets(staged);
        rowCount = totalRows();
        return;
      }
      if (stateAfterFailure === 'empty') {
        rollbackFilesystemAssets(staged);
      }
      throw error;
    }
  });
  return {
    path: context.path,
    rowCount,
    assetsIncluded: true,
    assetCount: (bundle.assets as AssetBundle).entries.length,
  };
}
