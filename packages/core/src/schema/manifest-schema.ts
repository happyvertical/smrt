/**
 * Manifest schema → structured `SchemaDefinition` helpers (#2358).
 *
 * A manifest's `schema.ddl` string is an engine-neutral CREATE TABLE preview:
 * it carries no indexes and no per-engine type mapping, so nothing that needs
 * an executable schema may treat it as authoritative. Every consumer that
 * reads raw manifest JSON — `SchemaAggregator`, `createIsolatedTestDbFromManifest`
 * in `@happyvertical/smrt-vitest`, third-party tooling — should collect the
 * structured `columns` / `indexes` through this module and render them with
 * `getDDLStrategy(engine)`, exactly as `db:migrate` does.
 *
 * The cached `ddl` string is used only when a manifest object exposes no
 * structured columns at all (hand-authored or pre-structured manifests); that
 * legacy path keeps working but is not engine-complete.
 *
 * Keep this module light — type-only imports plus the DDL strategies and the
 * logger — so it can be re-exported from lightweight entry points without
 * pulling the registry/collection module graph in by itself.
 */

import { createLogger } from '@happyvertical/logger';
import { getDDLStrategy } from './ddl/index.js';
import {
  findCreateTableBodyRange,
  getSQLDefinitionComparisonKey,
  getSQLDefinitionIdentifier,
  isSQLTableConstraintDefinition,
  materializeManifestDDLForEngine,
  tokenizeSQLDDLBody,
} from './ddl/materialize-manifest.js';
import type { DatabaseEngine, EngineSpecificDDL } from './ddl/types.js';
import { quoteIdentifier } from './sql-identifiers.js';
import type {
  ColumnDefinition,
  IndexDefinition,
  SchemaDefinition,
  SQLDataType,
} from './types.js';

const logger = createLogger({ level: 'info' });

/**
 * Column shape as it appears in raw manifest JSON. `ManifestColumnDefinition`
 * spells the default `default`; registry-side `ColumnDefinition` spells it
 * `defaultValue`. Hand-authored manifests use either.
 */
export interface ManifestColumnLike {
  type: string;
  primaryKey?: boolean;
  referenceKind?: ColumnDefinition['referenceKind'];
  notNull?: boolean;
  unique?: boolean;
  default?: unknown;
  defaultValue?: unknown;
  foreignKey?: ColumnDefinition['foreignKey'];
  check?: string;
}

/** Index shape as it appears in raw manifest JSON. */
export interface ManifestIndexLike {
  name: string;
  columns?: string[];
  unique?: boolean;
  where?: string;
  jsonPath?: IndexDefinition['jsonPath'];
}

/** The subset of a manifest object's `schema` this module reads. */
export interface ManifestSchemaLike {
  tableName: string;
  ddl?: string;
  columns?: Record<string, ManifestColumnLike>;
  indexes?: ManifestIndexLike[];
  version?: string;
}

/**
 * Convert one raw manifest column map into structured `ColumnDefinition`s.
 * Picks known fields only, so stray manifest keys never leak into DDL.
 */
export function manifestColumnsToDefinitions(
  columns: Record<string, ManifestColumnLike> | undefined,
): Record<string, ColumnDefinition> {
  const result: Record<string, ColumnDefinition> = {};
  for (const [name, column] of Object.entries(columns || {})) {
    if (!column || typeof column.type !== 'string') continue;
    const definition: ColumnDefinition = {
      type: column.type as SQLDataType,
    };
    if (column.primaryKey !== undefined)
      definition.primaryKey = column.primaryKey;
    if (column.referenceKind !== undefined)
      definition.referenceKind = column.referenceKind;
    if (column.notNull !== undefined) definition.notNull = column.notNull;
    if (column.unique !== undefined) definition.unique = column.unique;
    const defaultValue =
      column.defaultValue !== undefined ? column.defaultValue : column.default;
    if (defaultValue !== undefined) definition.defaultValue = defaultValue;
    if (column.foreignKey) definition.foreignKey = { ...column.foreignKey };
    if (column.check) definition.check = column.check;
    result[name] = definition;
  }
  return result;
}

/**
 * Convert raw manifest indexes into structured `IndexDefinition`s, keeping
 * `where` (partial) and `jsonPath` (expression) targets — the two fields the
 * retired string-based renderers dropped.
 */
export function manifestIndexesToDefinitions(
  indexes: ManifestIndexLike[] | undefined,
): IndexDefinition[] {
  const result: IndexDefinition[] = [];
  for (const index of indexes || []) {
    if (!index?.name) continue;
    const definition: IndexDefinition = {
      name: index.name,
      columns: Array.isArray(index.columns) ? [...index.columns] : [],
    };
    if (index.unique !== undefined) definition.unique = index.unique;
    if (index.where) definition.where = index.where;
    if (index.jsonPath?.column && index.jsonPath.path) {
      definition.jsonPath = { ...index.jsonPath };
    }
    result.push(definition);
  }
  return result;
}

/**
 * Convert one manifest object's `schema` into a `SchemaDefinition`.
 *
 * The cached `ddl` string is carried along (non-authoritative) so callers can
 * fall back to it when the manifest exposes no structured columns.
 */
export function manifestSchemaToDefinition(
  schema: ManifestSchemaLike,
): SchemaDefinition {
  const columns = manifestColumnsToDefinitions(schema.columns);
  const foreignKeys = Object.entries(columns).flatMap(([column, definition]) =>
    definition.foreignKey
      ? [
          {
            column,
            referencesTable: definition.foreignKey.table,
            referencesColumn: definition.foreignKey.column,
            onDelete: definition.foreignKey.onDelete,
            onUpdate: definition.foreignKey.onUpdate,
            ...(definition.foreignKey.engines
              ? { engines: definition.foreignKey.engines }
              : {}),
          },
        ]
      : [],
  );
  return {
    tableName: schema.tableName,
    ddl: schema.ddl,
    columns,
    indexes: manifestIndexesToDefinitions(schema.indexes),
    triggers: [],
    foreignKeys,
    dependencies: foreignKeys
      .map((foreignKey) => foreignKey.referencesTable)
      .filter((dependency) => dependency !== schema.tableName),
    version: schema.version ?? '',
  };
}

/**
 * One physical table collected from one or more manifest objects (STI
 * subclasses share a table and each contributes columns and indexes).
 */
export interface CollectedManifestTable {
  tableName: string;
  /**
   * Structured union of every contributor: columns first-wins by name,
   * indexes deduplicated by name.
   */
  definition: SchemaDefinition;
  /**
   * `true` when every contributor exposed structured columns, i.e. the whole
   * table is rendered by a DDL strategy. `false` means at least one
   * contributor carried only a cached `ddl` string: the CREATE TABLE is then
   * the strategy render of the structured contributors (if any) merged with
   * the cached strings of the column-less ones. The decision is per table,
   * not per contributor.
   */
  structured: boolean;
  /**
   * The contributors' cached `ddl` strings merged column-wise (legacy path).
   * Empty when no contributor carried a `ddl`.
   */
  legacyDdl: string;
  /** `<package>:<ClassName>` labels of the contributors, in encounter order. */
  sources: string[];
}

/**
 * Deterministic STI merge of two structured definitions: existing columns
 * win, new columns are appended, indexes are deduplicated by name.
 */
export function mergeSchemaDefinitionInto(
  target: SchemaDefinition,
  incoming: SchemaDefinition,
): void {
  for (const [name, column] of Object.entries(incoming.columns)) {
    if (!(name in target.columns)) {
      target.columns[name] = column;
    }
  }
  const indexNames = new Set(target.indexes.map((index) => index.name));
  for (const index of incoming.indexes) {
    if (!indexNames.has(index.name)) {
      indexNames.add(index.name);
      target.indexes.push(index);
    }
  }
  const foreignKeyKeys = new Set(
    target.foreignKeys.map(
      (foreignKey) =>
        `${foreignKey.column}\0${foreignKey.referencesTable}\0${foreignKey.referencesColumn}`,
    ),
  );
  for (const foreignKey of incoming.foreignKeys) {
    const key = `${foreignKey.column}\0${foreignKey.referencesTable}\0${foreignKey.referencesColumn}`;
    if (!foreignKeyKeys.has(key)) {
      foreignKeyKeys.add(key);
      target.foreignKeys.push(foreignKey);
    }
  }
  target.dependencies = Array.from(
    new Set([...target.dependencies, ...incoming.dependencies]),
  ).sort();
}

/**
 * Collect manifest schemas into physical tables.
 *
 * Accepts the `schema` entries of manifest objects (any package, any manifest)
 * in encounter order and groups them by `tableName`, merging STI contributors
 * structurally. Objects without a `schema`/`tableName` are skipped by the
 * caller; objects with neither columns nor `ddl` are ignored here.
 */
export function collectManifestTables(
  entries: Iterable<{ schema: ManifestSchemaLike; source: string }>,
): Map<string, CollectedManifestTable> {
  const tables = new Map<string, CollectedManifestTable>();
  // Structured contributors whose cached ddl declares table constraints. Only
  // a fully structured table drops them (a mixed table re-merges the string),
  // so the warning is decided after collection.
  const constraintCarriers = new Map<
    string,
    Array<{ source: string; constraints: string[] }>
  >();

  for (const { schema, source } of entries) {
    if (!schema?.tableName) continue;
    const definition = manifestSchemaToDefinition(schema);
    const hasColumns = Object.keys(definition.columns).length > 0;
    const ddl = typeof schema.ddl === 'string' ? schema.ddl : '';
    if (!hasColumns && !ddl.trim()) continue;

    if (hasColumns && ddl.trim()) {
      const constraints = cachedDdlTableConstraints(ddl);
      if (constraints.length > 0) {
        const carriers = constraintCarriers.get(schema.tableName) ?? [];
        carriers.push({ source, constraints });
        constraintCarriers.set(schema.tableName, carriers);
      }
    }

    const existing = tables.get(schema.tableName);
    if (!existing) {
      tables.set(schema.tableName, {
        tableName: schema.tableName,
        definition,
        structured: hasColumns,
        legacyDdl: ddl,
        sources: [source],
      });
      continue;
    }

    mergeSchemaDefinitionInto(existing.definition, definition);
    existing.structured = existing.structured && hasColumns;
    existing.legacyDdl = existing.legacyDdl
      ? ddl
        ? mergeManifestDDL(existing.legacyDdl, ddl)
        : existing.legacyDdl
      : ddl;
    existing.sources.push(source);
  }

  for (const [tableName, carriers] of constraintCarriers) {
    if (!tables.get(tableName)?.structured) continue;
    for (const { source, constraints } of carriers) {
      warnAboutDroppedTableConstraints(tableName, source, constraints);
    }
  }

  return tables;
}

/**
 * Render a collected table for one engine.
 *
 * Structured tables go through the engine strategy for the CREATE TABLE
 * (per-engine types, inline UNIQUE where the engine needs it) and for every
 * index (partial `WHERE`, JSON-path expressions, engine-specific syntax).
 * Tables with a column-less contributor keep that contributor's cached `ddl`
 * string, made minimally safe with `materializeManifestDDLForEngine`, merged
 * on top of the strategy render of any structured contributors — so a
 * structured STI base never loses its engine typing to a hand-authored
 * subclass, and the subclass's extra columns and table constraints survive.
 * Indexes always render through the strategy — the string never carried them.
 */
export function renderCollectedManifestTable(
  table: CollectedManifestTable,
  engine: DatabaseEngine,
): EngineSpecificDDL {
  const strategy = getDDLStrategy(engine);
  const hasColumns = Object.keys(table.definition.columns).length > 0;
  let createTable: string;
  if (table.structured) {
    createTable = strategy.generateCreateTable(table.definition);
  } else if (hasColumns) {
    createTable = mergeManifestDDL(
      strategy.generateCreateTable(table.definition),
      materializeManifestDDLForEngine(table.legacyDdl, engine),
    );
  } else {
    createTable = materializeManifestDDLForEngine(table.legacyDdl, engine);
  }

  // Engines that need UNIQUE inline for ON CONFLICT (DuckDB, JSON) get it
  // from `generateCreateTable` on the structured path and skip those indexes
  // in `generateIndexes`. A cached string never carried them, so a table with
  // a column-less contributor would lose its uniqueness entirely; append the
  // missing constraints as table elements (deduplicated against any the
  // string already declares).
  if (!table.structured && strategy.requiresInlineUnique()) {
    const uniqueElements = table.definition.indexes
      .filter(
        (index) =>
          index.unique &&
          !index.where &&
          !index.jsonPath &&
          index.columns.length > 0,
      )
      .map(
        (index) =>
          `UNIQUE(${index.columns.map((column) => quoteIdentifier(column)).join(', ')})`,
      );
    // Hand-authored strings may spell the same constraint without quotes
    // (`UNIQUE(tenant_id)`); compare quote- and whitespace-insensitively so
    // the synthesized element is not added beside it.
    const declared = new Set(
      cachedDdlTableConstraints(createTable).map(normalizeTableElement),
    );
    const missing = uniqueElements.filter(
      (element) => !declared.has(normalizeTableElement(element)),
    );
    if (missing.length > 0) {
      createTable = mergeManifestDDL(
        createTable,
        `CREATE TABLE ${quoteIdentifier(table.tableName)} (\n  ${missing.join(',\n  ')}\n)`,
      );
    }
  }

  return {
    createTable,
    indexes: strategy.generateIndexes(table.definition),
    triggers: strategy.generateTriggers(table.definition),
  };
}

// ---------------------------------------------------------------------------
// Legacy cached-DDL string merge (column-less manifests only)
// ---------------------------------------------------------------------------

function parseDefinitionsFromDDL(ddl: string): {
  columns: Map<string, string>;
  tableElements: string[];
} {
  const columns = new Map<string, string>();
  const tableElements: string[] = [];
  const bodyRange = findCreateTableBodyRange(ddl);
  if (!bodyRange) return { columns, tableElements };
  const [bodyStart, bodyEnd] = bodyRange;

  const segments = tokenizeSQLDDLBody(ddl.slice(bodyStart + 1, bodyEnd));

  for (const segment of segments) {
    const identifier = getSQLDefinitionIdentifier(segment);
    if (!identifier) continue;
    if (isSQLTableConstraintDefinition(segment)) {
      tableElements.push(segment);
      continue;
    }

    columns.set(identifier.name, segment);
  }

  return { columns, tableElements };
}

/**
 * Table-level constraints (`UNIQUE(...)`, `CHECK (...)`, `CONSTRAINT ...`,
 * ...) declared in a cached CREATE TABLE string. Structured `columns` cannot
 * represent them, so a structured render drops them — exactly as `db:migrate`
 * does. Exposed so callers can warn instead of losing them silently.
 *
 * @internal
 */
export function cachedDdlTableConstraints(ddl: string): string[] {
  return parseDefinitionsFromDDL(ddl).tableElements;
}

/** Quote/whitespace/case-insensitive key for a table constraint element. */
function normalizeTableElement(element: string): string {
  return element.replace(/"/g, '').replace(/\s+/g, '').toLowerCase();
}

const warnedDroppedConstraints = new Set<string>();

/**
 * Warn once per process per table+source when a structured contributor's
 * cached `ddl` declares table constraints that the structured render cannot
 * carry. The structured schema is authoritative: a constraint that lives only
 * in the string never reaches `db:migrate` either, so rendering it here would
 * recreate the test/production drift #2358 removes.
 */
function warnAboutDroppedTableConstraints(
  tableName: string,
  source: string,
  constraints: string[],
): void {
  const key = `${tableName}\0${source}`;
  if (warnedDroppedConstraints.has(key)) return;
  warnedDroppedConstraints.add(key);
  logger.warn(
    `[manifest-schema] ${source}: cached ddl for table "${tableName}" declares ` +
      `${constraints.length} table constraint(s) that structured columns cannot ` +
      `carry (${constraints.join('; ')}). They are not rendered — the ` +
      `structured schema is authoritative (#2358). Declare uniqueness through ` +
      `indexes/conflictColumns or a column-level constraint instead.`,
  );
}

/**
 * Merge two cached CREATE TABLE strings for the same table (STI subclasses):
 * the union of columns, existing definitions winning, new columns inserted
 * before any trailing table constraints, missing table constraints appended.
 *
 * Only the legacy column-less manifest path uses this; structured manifests
 * merge through `mergeSchemaDefinitionInto`.
 */
function mergeManifestDDL(existingDDL: string, newDDL: string): string {
  const existingDefinitions = parseDefinitionsFromDDL(existingDDL);
  const newDefinitions = parseDefinitionsFromDDL(newDDL);

  const missingCols: string[] = [];
  for (const [name, def] of newDefinitions.columns) {
    if (!existingDefinitions.columns.has(name)) {
      missingCols.push(def);
    }
  }

  const existingTableElements = new Set(
    existingDefinitions.tableElements.map(getSQLDefinitionComparisonKey),
  );
  const missingTableElements = newDefinitions.tableElements.filter(
    (definition) =>
      !existingTableElements.has(getSQLDefinitionComparisonKey(definition)),
  );

  if (missingCols.length === 0 && missingTableElements.length === 0) {
    return existingDDL;
  }

  const bodyRange = findCreateTableBodyRange(existingDDL);
  if (!bodyRange) return existingDDL;
  const [bodyStart, bodyEnd] = bodyRange;
  const prefix = existingDDL.slice(0, bodyStart + 1);
  const body = existingDDL.slice(bodyStart + 1, bodyEnd);
  const suffix = existingDDL.slice(bodyEnd);
  const segments = tokenizeSQLDDLBody(body);
  const firstConstraintIndex = segments.findIndex((segment) =>
    isSQLTableConstraintDefinition(segment),
  );
  const insertionIndex =
    firstConstraintIndex === -1 ? segments.length : firstConstraintIndex;
  const mergedSegments = [
    ...segments.slice(0, insertionIndex),
    ...missingCols,
    ...segments.slice(insertionIndex),
    ...missingTableElements,
  ];

  return `${prefix}\n${mergedSegments.map((segment) => `  ${segment}`).join(',\n')}\n${suffix}`;
}
