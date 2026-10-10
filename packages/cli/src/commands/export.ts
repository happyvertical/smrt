/**
 * export Command
 *
 * Unified export command for static site generation.
 * Exports data from database to JSON files based on smrt.config.js export configuration.
 *
 * This replaces per-agent export commands (praeco export, caelus export, etc.)
 * with a single, schema-driven export that respects field-level export annotations.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  ExportFileConfig,
  ExportFilterValue,
} from '@happyvertical/smrt-config';
import type { DatabaseInterface } from '@happyvertical/sql';
import type { CLICommand } from '../cli-generator.js';
import {
  closeDatabaseConnection,
  redactDatabaseUrlsInText,
} from './db-command-utils.js';

/**
 * Minimal structural view of a registry field definition, covering only the
 * properties the export pipeline reads. Mirrors the relevant fields of
 * `FieldDefinition` from `@happyvertical/smrt-core` (which is not re-exported
 * from the package root).
 */
interface ExportFieldDef {
  type?: string;
  transient?: boolean;
  exported?: boolean;
  _meta?: { __smrtSystemField?: boolean } & Record<string, unknown>;
}

/** A single exportable database row keyed by column/field name. */
type ExportRow = Record<string, unknown>;

/** WHERE-clause filter map: field name → comparison value. */
type ExportFilters = Record<string, unknown>;

/** Per-file export summary entry. */
interface ExportFileSummary {
  types: string[];
  records: number;
  fields: number;
  path: string;
}

/** Parsed options for the `export` command handler. */
interface ExportCliOptions {
  output: string;
  file?: string;
  'show-drafts'?: boolean;
  'dry-run'?: boolean;
  json?: boolean;
  verbose?: boolean;
}

function toSnakeCase(str: string): string {
  return str
    .replace(/([A-Z])/g, '_$1')
    .toLowerCase()
    .replace(/^_/, '');
}

function toColumnName(fieldName: string): string {
  const dotIndex = fieldName.indexOf('.');
  const baseFieldName =
    dotIndex >= 0 ? fieldName.substring(0, dotIndex) : fieldName;
  const jsonPath = dotIndex >= 0 ? fieldName.substring(dotIndex) : '';

  const snakeBaseFieldName = baseFieldName.startsWith('_')
    ? `_${toSnakeCase(baseFieldName.slice(1))}`
    : toSnakeCase(baseFieldName);

  return `${snakeBaseFieldName}${jsonPath}`;
}

function assertSafeIdentifier(identifier: string, label: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)*$/.test(identifier)) {
    throw new Error(`Invalid ${label}: ${identifier}`);
  }

  return identifier;
}

function toSafeColumnName(fieldName: string, label = 'field name'): string {
  return assertSafeIdentifier(toColumnName(fieldName), label);
}

function toSafeTableName(tableName: string): string {
  return assertSafeIdentifier(tableName, 'table name');
}

type ExportProjectionCapabilities = {
  includeMetaType: boolean;
  includeMetaData: boolean;
  schemaColumns: Set<string>;
};

async function getProjectionCapabilities(
  typeName: string,
): Promise<ExportProjectionCapabilities> {
  const { ObjectRegistry } = await import('@happyvertical/smrt-core');

  const tableStrategy = ObjectRegistry.getTableStrategy(typeName);
  const schemaOwner =
    tableStrategy === 'sti'
      ? ObjectRegistry.getSTIBase(typeName) || typeName
      : typeName;
  const schema = ObjectRegistry.getSchema(schemaOwner) as
    | { columns?: Record<string, unknown> }
    | undefined;
  const schemaColumns = new Set(Object.keys(schema?.columns ?? {}));

  return {
    includeMetaType: tableStrategy === 'sti' || schemaColumns.has('_meta_type'),
    includeMetaData: schemaColumns.has('_meta_data'),
    schemaColumns,
  };
}

/**
 * Get fields that should be exported for a given type
 */
async function getExportableFields(
  typeName: string,
  fileConfig: ExportFileConfig,
  fieldExportDefault: boolean,
): Promise<string[]> {
  const { ObjectRegistry } = await import('@happyvertical/smrt-core');
  const projection = await getProjectionCapabilities(typeName);

  // Export needs inherited STI/CTI fields as well as direct fields.
  const fields = await ObjectRegistry.getAllFields(typeName);
  if (fields.size === 0) {
    // A listed type with no registered fields is a configuration error, not an
    // empty set: silently contributing nothing would drop the whole file.
    throw new Error(
      `Export type "${typeName}" is not registered (no fields found). ` +
        'Check the spelling in smrt.config.js export types and that the ' +
        'class is registered (decorated and imported by the project).',
    );
  }

  // If include whitelist is specified, use only those fields
  if (fileConfig.include && fileConfig.include.length > 0) {
    return fileConfig.include.filter(
      (f) =>
        // `exported: false` is never overridable, not even by a whitelist.
        (fields.has(f) &&
          (fields.get(f) as ExportFieldDef).exported !== false) ||
        (f === '_meta_type' && projection.includeMetaType) ||
        (f === '_meta_data' && projection.includeMetaData) ||
        (f === 'id' && projection.schemaColumns.has('id')) ||
        (f === 'slug' && projection.schemaColumns.has('slug')),
    );
  }

  const exportableFields: string[] = [];

  for (const [fieldName, rawFieldDef] of fields) {
    const fieldDef = rawFieldDef as ExportFieldDef;
    if (fieldDef._meta?.__smrtSystemField === true) continue;

    // Skip transient and relationship fields
    if (fieldDef.transient) continue;
    if (fieldDef.type === 'oneToMany' || fieldDef.type === 'manyToMany')
      continue;

    // Check field-level export annotation (from @field({ exported: ... }))
    const exportedAnnotation = fieldDef.exported;

    // exported: false means never export (cannot be overridden)
    if (exportedAnnotation === false) continue;

    // exported: true means always export
    if (exportedAnnotation === true) {
      exportableFields.push(fieldName);
      continue;
    }

    // No annotation - use site's fieldExportDefault
    if (fieldExportDefault) {
      exportableFields.push(fieldName);
    }
  }

  // Apply exclude blacklist
  const excluded = new Set(fileConfig.exclude || []);
  const result = exportableFields.filter((f) => !excluded.has(f));

  if (projection.includeMetaType && !result.includes('_meta_type')) {
    result.push('_meta_type');
  }

  const standardFields = [
    projection.schemaColumns.has('id') ? 'id' : null,
    projection.schemaColumns.has('slug') ? 'slug' : null,
    projection.includeMetaData ? '_meta_data' : null,
  ].filter((field): field is string => field !== null);

  for (const standardField of standardFields) {
    if (!result.includes(standardField)) {
      result.push(standardField);
    }
  }

  return result;
}

/**
 * Build WHERE clause from filter config
 */
function buildWhereClause(
  filters: Record<string, string[] | number[] | ExportFilterValue> | undefined,
): ExportFilters {
  if (!filters) return {};

  const where: ExportFilters = {};

  for (const [field, value] of Object.entries(filters)) {
    if (Array.isArray(value)) {
      // Shorthand: field: ['a', 'b'] means IN clause
      where[field] = value;
    } else if (typeof value === 'object') {
      // Full filter object
      const filterValue = value as ExportFilterValue;
      if (filterValue.eq !== undefined) where[field] = filterValue.eq;
      else if (filterValue.in !== undefined) where[field] = filterValue.in;
      else if (filterValue.gte !== undefined)
        where[`${field}__gte`] = filterValue.gte;
      else if (filterValue.lte !== undefined)
        where[`${field}__lte`] = filterValue.lte;
      else if (filterValue.gt !== undefined)
        where[`${field}__gt`] = filterValue.gt;
      else if (filterValue.lt !== undefined)
        where[`${field}__lt`] = filterValue.lt;
      else if (filterValue.ne !== undefined)
        where[`${field}__ne`] = filterValue.ne;
      else if (filterValue.contains !== undefined)
        where[`${field}__contains`] = filterValue.contains;
    } else {
      // Simple value
      where[field] = value;
    }
  }

  return where;
}

/**
 * Query records with field projection
 */
export async function queryWithProjection(
  db: DatabaseInterface,
  tableName: string,
  types: string[],
  fields: string[],
  filters: ExportFilters,
  orderBy?: string,
  limit?: number,
): Promise<ExportRow[]> {
  const projection =
    types.length > 0
      ? await getProjectionCapabilities(types[0])
      : {
          includeMetaType: false,
          includeMetaData: false,
          schemaColumns: new Set<string>(),
        };

  // Build SELECT clause with only exportable fields
  const fieldColumns = fields.map((field) => ({
    field,
    column: toSafeColumnName(field),
  }));
  const selectFields = fieldColumns.map(({ column }) => column).join(', ');

  // Build WHERE clause
  const whereClauses: string[] = [];
  const whereValues: unknown[] = [];

  // Filter by _meta_type if specified types
  if (types.length > 0 && projection.includeMetaType) {
    // Map type names to qualified names or just use as-is
    const typePatterns = types.map((t) => `%:${t}`);
    if (typePatterns.length === 1) {
      whereClauses.push('_meta_type LIKE ?');
      whereValues.push(typePatterns[0]);
    } else {
      whereClauses.push(
        `(${typePatterns.map(() => '_meta_type LIKE ?').join(' OR ')})`,
      );
      whereValues.push(...typePatterns);
    }
  }

  // Apply custom filters
  for (const [field, value] of Object.entries(filters)) {
    if (field.endsWith('__gte')) {
      whereClauses.push(
        `${toSafeColumnName(field.replace('__gte', ''), 'filter field')} >= ?`,
      );
      whereValues.push(value);
    } else if (field.endsWith('__lte')) {
      whereClauses.push(
        `${toSafeColumnName(field.replace('__lte', ''), 'filter field')} <= ?`,
      );
      whereValues.push(value);
    } else if (field.endsWith('__gt')) {
      whereClauses.push(
        `${toSafeColumnName(field.replace('__gt', ''), 'filter field')} > ?`,
      );
      whereValues.push(value);
    } else if (field.endsWith('__lt')) {
      whereClauses.push(
        `${toSafeColumnName(field.replace('__lt', ''), 'filter field')} < ?`,
      );
      whereValues.push(value);
    } else if (field.endsWith('__ne')) {
      whereClauses.push(
        `${toSafeColumnName(field.replace('__ne', ''), 'filter field')} != ?`,
      );
      whereValues.push(value);
    } else if (field.endsWith('__contains')) {
      whereClauses.push(
        `${toSafeColumnName(field.replace('__contains', ''), 'filter field')} LIKE ?`,
      );
      whereValues.push(`%${value}%`);
    } else if (Array.isArray(value)) {
      whereClauses.push(
        `${toSafeColumnName(field, 'filter field')} IN (${value.map(() => '?').join(', ')})`,
      );
      whereValues.push(...value);
    } else {
      whereClauses.push(`${toSafeColumnName(field, 'filter field')} = ?`);
      whereValues.push(value);
    }
  }

  // Build query
  let sql = `SELECT ${selectFields} FROM ${toSafeTableName(tableName)}`;
  if (whereClauses.length > 0) {
    sql += ` WHERE ${whereClauses.join(' AND ')}`;
  }
  if (orderBy) {
    const desc = orderBy.startsWith('-');
    const column = toSafeColumnName(
      desc ? orderBy.slice(1) : orderBy,
      'sort field',
    );
    sql += ` ORDER BY ${column} ${desc ? 'DESC' : 'ASC'}`;
  }
  if (limit) {
    sql += ` LIMIT ${limit}`;
  }

  try {
    const result = await db.query(sql, ...whereValues);
    return Array.isArray(result) ? result : (result?.rows ?? []);
  } catch (error) {
    const contextMessage = `Export query failed for ${tableName} (columns: ${selectFields})`;
    if (error instanceof Error) {
      throw new Error(`${contextMessage}: ${error.message}`, { cause: error });
    }

    throw new Error(`${contextMessage}: ${String(error)}`);
  }
}

function parseExportValue(value: unknown) {
  if (
    typeof value === 'string' &&
    (value.startsWith('{') || value.startsWith('['))
  ) {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }

  return value;
}

export function formatProjectedRecords(
  records: ExportRow[],
  fieldColumns: Array<{ field: string; column: string }>,
) {
  return records.map((row: ExportRow) => {
    const record: Record<string, unknown> = {};
    for (const { field, column } of fieldColumns) {
      const rawValue =
        row[field] !== undefined && row[field] !== null
          ? row[field]
          : row[column];
      record[field] = parseExportValue(rawValue);
    }
    return record;
  });
}

/**
 * Resolve table name for given types
 */
async function resolveTableName(types: string[]): Promise<string> {
  const { ObjectRegistry } = await import('@happyvertical/smrt-core');

  // Get table from first type's registry
  for (const typeName of types) {
    const tableName = ObjectRegistry.getTableName(typeName);
    if (tableName) {
      return tableName;
    }
  }

  // Default to 'events' or 'contents' based on common patterns
  const typeNames = types.map((t) => t.toLowerCase());
  if (
    typeNames.some((t) =>
      ['meeting', 'game', 'forecast', 'weatherforecast', 'event'].includes(t),
    )
  ) {
    return 'events';
  }
  if (
    typeNames.some((t) =>
      ['article', 'meetingrecap', 'meetingannouncement', 'content'].includes(t),
    )
  ) {
    return 'contents';
  }

  return 'events'; // Default fallback
}

/**
 * Get common fields across all types for an export file
 */
export async function getCommonFields(
  types: string[],
  fileConfig: ExportFileConfig,
  fieldExportDefault: boolean,
): Promise<string[]> {
  const fieldSets: Set<string>[] = [];

  for (const typeName of types) {
    const fields = await getExportableFields(
      typeName,
      fileConfig,
      fieldExportDefault,
    );
    fieldSets.push(new Set(fields));
  }

  if (fieldSets.length === 0) return [];

  // Find intersection of all field sets
  const commonFields = [...fieldSets[0]].filter((field) =>
    fieldSets.every((set) => set.has(field)),
  );

  return commonFields;
}

/**
 * Columns to select for an export file, plus the per-type exclusions that must
 * still be enforced row by row.
 */
export interface ExportColumnPlan {
  /** Output fields, in first-appearance order. */
  fields: string[];
  /**
   * Union exports only: for each listed type, the fields that type has but does
   * not export (`exported: false`, `exclude`, or `fieldExportDefault: false`)
   * while another listed type does. The union column set contains these, so
   * rows of the excluding type must have them blanked after the query.
   * Types with nothing to blank are omitted.
   */
  excludedByType: Map<string, Set<string>>;
}

/**
 * Get the union of exportable fields across all types for an export file, and
 * the per-type exclusions the union would otherwise leak.
 *
 * Fields are ordered by first appearance. Rows of a type that lacks a column
 * come back NULL, so this is only appropriate for types that share one table.
 * A column exportable for one type but excluded for another (`exported: false`)
 * is in the union, so `excludedByType` names it for the excluding type and the
 * caller blanks it per row via {@link applyTypeExclusions}.
 */
export async function getUnionPlan(
  types: string[],
  fileConfig: ExportFileConfig,
  fieldExportDefault: boolean,
): Promise<ExportColumnPlan> {
  const { ObjectRegistry } = await import('@happyvertical/smrt-core');
  const union = new Set<string>();
  const perType = new Map<
    string,
    { exportable: Set<string>; has: Set<string> }
  >();

  for (const typeName of types) {
    const fields = await getExportableFields(
      typeName,
      fileConfig,
      fieldExportDefault,
    );
    for (const field of fields) union.add(field);
    const all = await ObjectRegistry.getAllFields(typeName);
    perType.set(typeName, {
      exportable: new Set(fields),
      has: new Set(all.keys()),
    });
  }

  const excludedByType = new Map<string, Set<string>>();
  for (const [typeName, { exportable, has }] of perType) {
    const excluded = new Set<string>();
    for (const field of union) {
      // A column the type does not have is NULL on its rows already; only a
      // column the type owns but withholds can carry data that must not leak.
      if (!exportable.has(field) && has.has(field)) excluded.add(field);
    }
    if (excluded.size > 0) excludedByType.set(typeName, excluded);
  }

  if (excludedByType.size > 0) {
    // Blanking is keyed on the row's type discriminator; without one the
    // exclusions cannot be enforced, so refuse rather than publish the column.
    for (const typeName of excludedByType.keys()) {
      const projection = await getProjectionCapabilities(typeName);
      if (!projection.includeMetaType) {
        throw new Error(
          `Export cannot enforce per-type field exclusions for "${typeName}": ` +
            `its table has no _meta_type discriminator. ${describeExclusions(excludedByType)}`,
        );
      }
    }
  }

  return { fields: [...union], excludedByType };
}

/** Human-readable `field (Type, Type)` list for error messages. */
function describeExclusions(excludedByType: Map<string, Set<string>>): string {
  const byField = new Map<string, string[]>();
  for (const [typeName, fields] of excludedByType) {
    for (const field of fields) {
      byField.set(field, [...(byField.get(field) ?? []), typeName]);
    }
  }
  const parts = [...byField].map(
    ([field, typeNames]) => `"${field}" (excluded for ${typeNames.join(', ')})`,
  );
  return `Fields: ${parts.join('; ')}.`;
}

/**
 * Get the union of exportable fields across all types for an export file.
 * See {@link getUnionPlan} for the per-type exclusions this set implies.
 */
export async function getUnionFields(
  types: string[],
  fileConfig: ExportFileConfig,
  fieldExportDefault: boolean,
): Promise<string[]> {
  return (await getUnionPlan(types, fileConfig, fieldExportDefault)).fields;
}

/**
 * Resolve the columns (and per-type exclusions) for an export file.
 *
 * Types that share one table (single-table inheritance) export the union of
 * their columns, so subtype columns reach the file; `fields: 'common'` opts
 * back into the intersection. Types spread over different tables always use
 * the intersection, because only one table is queried. The intersection never
 * contains a column excluded for any type, so only the union path needs
 * per-row exclusions.
 */
export async function resolveExportPlan(
  types: string[],
  fileConfig: ExportFileConfig,
  fieldExportDefault: boolean,
): Promise<ExportColumnPlan> {
  if (types.length > 1 && fileConfig.fields !== 'common') {
    const { ObjectRegistry } = await import('@happyvertical/smrt-core');
    const tables = new Set(types.map((t) => ObjectRegistry.getTableName(t)));
    if (tables.size === 1 && !tables.has(undefined)) {
      return getUnionPlan(types, fileConfig, fieldExportDefault);
    }
    if (fileConfig.fields === 'union') {
      throw new Error(
        `Export "fields: 'union'" requires all types to share one table; ` +
          `got ${types.join(', ')}.`,
      );
    }
  }

  return {
    fields: await getCommonFields(types, fileConfig, fieldExportDefault),
    excludedByType: new Map(),
  };
}

/** Resolve just the columns for an export file. See {@link resolveExportPlan}. */
export async function resolveExportFields(
  types: string[],
  fileConfig: ExportFileConfig,
  fieldExportDefault: boolean,
): Promise<string[]> {
  return (await resolveExportPlan(types, fileConfig, fieldExportDefault))
    .fields;
}

/**
 * Blank, in place of the stored value, every field a row's own type excludes.
 *
 * The row's type comes from its `_meta_type` discriminator (`scope:Class`).
 * Excluded fields are set to `null` under both the field and column keys so
 * output shape stays identical across rows. A row whose type cannot be matched
 * to a listed type fails the export, naming the fields and types involved,
 * instead of risking an excluded value reaching the file.
 */
export function applyTypeExclusions(
  rows: ExportRow[],
  excludedByType: Map<string, Set<string>>,
  typeNames: string[],
): ExportRow[] {
  if (excludedByType.size === 0) return rows;

  return rows.map((row) => {
    const discriminator = row._meta_type;
    const matched =
      typeof discriminator === 'string'
        ? typeNames.filter(
            (t) => discriminator === t || discriminator.endsWith(`:${t}`),
          )
        : [];
    if (matched.length === 0) {
      throw new Error(
        'Export cannot determine the type of a row ' +
          `(_meta_type=${JSON.stringify(discriminator ?? null)}; expected one of ` +
          `${typeNames.join(', ')}), so per-type field exclusions cannot be ` +
          `enforced. ${describeExclusions(excludedByType)}`,
      );
    }

    // If several listed types match, withhold what any of them withholds.
    const redacted = { ...row };
    for (const typeName of matched) {
      for (const field of excludedByType.get(typeName) ?? []) {
        redacted[field] = null;
        redacted[toColumnName(field)] = null;
      }
    }
    return redacted;
  });
}

export const exportCommand: CLICommand = {
  name: 'export',
  description:
    'Export data from database to JSON files for static site generation',
  aliases: ['dump'],
  args: [],
  options: {
    output: {
      type: 'string',
      description: 'Output directory (default: ./data)',
      default: './data',
      short: 'o',
    },
    file: {
      type: 'string',
      description: 'Export only a specific file (e.g., contents, events)',
      short: 'f',
    },
    'show-drafts': {
      type: 'boolean',
      description:
        'Include draft/review status content (reads PUBLIC_SHOW_DRAFTS env)',
      default: false,
    },
    'dry-run': {
      type: 'boolean',
      description: 'Show what would be exported without writing files',
      default: false,
    },
    json: {
      type: 'boolean',
      description: 'Output summary as JSON',
      default: false,
    },
    verbose: {
      type: 'boolean',
      description: 'Show detailed output',
      short: 'v',
      default: false,
    },
  },
  handler: async (_args: string[], options: ExportCliOptions) => {
    let db: DatabaseInterface | undefined;

    try {
      // 1. Load config
      const { getConfig, getPackageConfig } = await import(
        '@happyvertical/smrt-config'
      );
      const { DEFAULT_CLI_CONFIG } = await import('../config.js');

      const smrtConfig = getConfig();
      const cliConfig = getPackageConfig('cli', DEFAULT_CLI_CONFIG);

      // Check for smrt config
      if (!smrtConfig) {
        if (!options.json) {
          console.error('\n❌ No smrt.config.js found');
        } else {
          console.log(JSON.stringify({ error: 'No smrt.config.js found' }));
        }
        process.exit(1);
      }

      // Check for export configuration
      const exportConfig = smrtConfig.export;
      if (!exportConfig || Object.keys(exportConfig).length === 0) {
        if (!options.json) {
          console.error('\n❌ No export configuration found');
          console.error('\nPlease add an `export` section to smrt.config.js');
          console.error('\nExample:');
          console.error(`
  export: {
    fieldExportDefault: true,
    contents: {
      types: ['MeetingRecap', 'MeetingAnnouncement'],
      filters: { status: ['published'] },
    },
    events: {
      types: ['Meeting', 'Game', 'WeatherForecast'],
    },
  },
`);
        } else {
          console.log(
            JSON.stringify({ error: 'No export configuration found' }),
          );
        }
        process.exit(1);
      }

      // 2. Validate database configuration
      if (!cliConfig.database?.url || cliConfig.database.url === ':memory:') {
        if (options.json) {
          console.log(JSON.stringify({ error: 'Database not configured' }));
        } else {
          console.error('\n❌ Database configuration required');
          console.error(
            '\nPlease configure database in smrt.config.js packages.cli.database\n',
          );
        }
        process.exit(1);
      }

      if (!options.json) {
        console.log('\n📦 Exporting Data for Static Site\n');
      }

      // 3. Connect to database
      const { getDatabase } = await import('@happyvertical/sql');
      db = await getDatabase({
        type: cliConfig.database.type || 'sqlite',
        url: cliConfig.database.url,
      });

      // 4. Get ObjectRegistry (already loaded via .smrt/register.js at CLI startup)
      const { ObjectRegistry } = await import('@happyvertical/smrt-core');

      // 5. Get export defaults
      const fieldExportDefault = exportConfig.fieldExportDefault !== false; // Default: true
      const defaultFormat = exportConfig.format || 'json';

      // Determine if we should show drafts
      const showDrafts =
        options['show-drafts'] || process.env.PUBLIC_SHOW_DRAFTS === 'true';

      // 6. Process each export file
      const outputDir = path.resolve(process.cwd(), options.output);
      const summary: Record<string, ExportFileSummary> = {};
      const onlyFile = options.file;

      // Ensure output directory exists
      if (!options['dry-run'] && !fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }

      // Extract file configs (skip reserved keys)
      const reservedKeys = new Set(['fieldExportDefault', 'format']);
      const fileConfigs = Object.entries(exportConfig).filter(
        ([key, value]) =>
          !reservedKeys.has(key) && typeof value === 'object' && value !== null,
      ) as [string, ExportFileConfig][];

      for (const [filename, fileConfig] of fileConfigs) {
        // Skip if only exporting specific file
        if (onlyFile && filename !== onlyFile) continue;

        if (options.verbose && !options.json) {
          console.log(`Processing: ${filename}`);
        }

        // Get types and resolve table
        const types = fileConfig.types || [];
        if (types.length === 0) {
          console.warn(`⚠️  No types specified for ${filename}, skipping`);
          continue;
        }

        // Get fields to export (union for same-table types, else common)
        const { fields, excludedByType } = await resolveExportPlan(
          types,
          fileConfig,
          fieldExportDefault,
        );
        if (fields.length === 0) {
          console.warn(`⚠️  No exportable fields for ${filename}, skipping`);
          continue;
        }

        // Resolve table name from first type
        const tableName = await resolveTableName(types);

        // Build filters
        const filters = buildWhereClause(fileConfig.filters);

        // Add status filter if not showing drafts
        if (
          tableName === 'contents' &&
          !showDrafts &&
          fields.includes('status')
        ) {
          if (!filters.status) {
            filters.status = ['published'];
          }
        }

        // Query records
        // Per-type exclusions are enforced from the row's type discriminator,
        // so select it even when the file does not output it.
        const queryFields =
          excludedByType.size > 0 && !fields.includes('_meta_type')
            ? [...fields, '_meta_type']
            : fields;
        const queriedRecords = await queryWithProjection(
          db,
          tableName,
          types,
          queryFields,
          filters,
          fileConfig.orderBy,
          fileConfig.limit,
        );

        const records = applyTypeExclusions(
          queriedRecords,
          excludedByType,
          types,
        );

        // Format records (parse JSON fields, etc.)
        const fieldColumns = fields.map((field) => ({
          field,
          column: toColumnName(field),
        }));

        const formattedRecords = formatProjectedRecords(records, fieldColumns);

        // Write file
        const format = fileConfig.format || defaultFormat;
        const extension =
          format === 'ndjson' ? 'ndjson' : format === 'csv' ? 'csv' : 'json';
        const outputPath = path.join(outputDir, `${filename}.${extension}`);

        if (!options['dry-run']) {
          let content: string;
          if (format === 'ndjson') {
            content = formattedRecords.map((r) => JSON.stringify(r)).join('\n');
          } else if (format === 'csv') {
            // Simple CSV (headers + rows)
            if (formattedRecords.length > 0) {
              const headers = Object.keys(formattedRecords[0]);
              const rows = formattedRecords.map((r) =>
                headers.map((h) => JSON.stringify(r[h] ?? '')).join(','),
              );
              content = [headers.join(','), ...rows].join('\n');
            } else {
              content = '';
            }
          } else {
            content = JSON.stringify(formattedRecords, null, 2);
          }

          fs.writeFileSync(outputPath, content, 'utf-8');
        }

        summary[filename] = {
          types,
          records: formattedRecords.length,
          fields: fields.length,
          path: outputPath,
        };

        if (!options.json) {
          const dryRunNote = options['dry-run'] ? ' (dry-run)' : '';
          console.log(
            `  ✓ ${filename}.${extension}: ${formattedRecords.length} records${dryRunNote}`,
          );
        }
      }

      // 7. Output summary
      if (options.json) {
        console.log(JSON.stringify(summary, null, 2));
      } else {
        console.log('\n✅ Export complete');
        console.log(`   Output: ${outputDir}`);
        console.log(`   Files: ${Object.keys(summary).length}`);
        console.log(
          `   Records: ${Object.values(summary).reduce((acc, s) => acc + s.records, 0)}`,
        );
        if (showDrafts) {
          console.log('   Mode: Including drafts');
        }
      }
    } catch (error) {
      if (options.json) {
        console.log(
          JSON.stringify({
            error: redactDatabaseUrlsInText(
              error instanceof Error ? error.message : String(error),
            ),
          }),
        );
      } else {
        console.error('\n❌ Export failed:');
        if (error instanceof Error) {
          console.error(`   ${redactDatabaseUrlsInText(error.message)}`);
          if (options.verbose && error.stack) {
            console.error(redactDatabaseUrlsInText(error.stack));
          }
        }
      }
      process.exitCode = 1;
      return;
    } finally {
      await closeDatabaseConnection(db);
    }
  },
};
