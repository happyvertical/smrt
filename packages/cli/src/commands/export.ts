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
import type { CLICommand } from '../cli-generator.js';

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

/**
 * Get fields that should be exported for a given type
 */
async function getExportableFields(
  typeName: string,
  fileConfig: ExportFileConfig,
  fieldExportDefault: boolean,
): Promise<string[]> {
  const { ObjectRegistry } = await import('@happyvertical/smrt-core');

  // Get fields from registry
  const fields = ObjectRegistry.getFields(typeName);
  if (fields.size === 0) {
    console.warn(`⚠️  No fields found for type: ${typeName}`);
    return [];
  }

  // If include whitelist is specified, use only those fields
  if (fileConfig.include && fileConfig.include.length > 0) {
    return fileConfig.include.filter(
      (f) => fields.has(f) || f === '_meta_type',
    );
  }

  const exportableFields: string[] = [];

  for (const [fieldName, fieldDef] of fields) {
    // Skip transient and relationship fields
    if (fieldDef.transient) continue;
    if (fieldDef.type === 'oneToMany' || fieldDef.type === 'manyToMany')
      continue;

    // Check field-level export annotation (from @field({ exported: ... }))
    const exportedAnnotation = (fieldDef as any).exported;

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

  // Always include _meta_type for STI discrimination
  if (!result.includes('_meta_type')) {
    result.push('_meta_type');
  }

  for (const standardField of ['id', 'slug', '_meta_data']) {
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
): Record<string, any> {
  if (!filters) return {};

  const where: Record<string, any> = {};

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
  db: any,
  tableName: string,
  types: string[],
  fields: string[],
  filters: Record<string, any>,
  orderBy?: string,
  limit?: number,
): Promise<any[]> {
  // Build SELECT clause with only exportable fields
  const fieldColumns = fields.map((field) => ({
    field,
    column: toSafeColumnName(field),
  }));
  const selectFields = fieldColumns.map(({ column }) => column).join(', ');

  // Build WHERE clause
  const whereClauses: string[] = [];
  const whereValues: any[] = [];

  // Filter by _meta_type if specified types
  if (types.length > 0) {
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
    const result = await db.query(sql, whereValues);
    return Array.isArray(result) ? result : (result?.rows ?? []);
  } catch (error) {
    // If query fails (missing column, etc.), return empty
    console.warn(
      `⚠️  Query failed for ${tableName}: ${error instanceof Error ? error.message : error}`,
    );
    return [];
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
  records: any[],
  fieldColumns: Array<{ field: string; column: string }>,
) {
  return records.map((row: any) => {
    const record: Record<string, any> = {};
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
async function getCommonFields(
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

  // Add _meta_type if not present (needed for STI discrimination)
  if (!commonFields.includes('_meta_type')) {
    commonFields.push('_meta_type');
  }

  return commonFields;
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
  handler: async (_args: string[], options: any) => {
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
      const db = await getDatabase({
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
      const summary: Record<string, any> = {};
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

        // Get fields to export (union of all type fields)
        const fields = await getCommonFields(
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
        const records = await queryWithProjection(
          db,
          tableName,
          types,
          fields,
          filters,
          fileConfig.orderBy,
          fileConfig.limit,
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
            content = formattedRecords
              .map((r: any) => JSON.stringify(r))
              .join('\n');
          } else if (format === 'csv') {
            // Simple CSV (headers + rows)
            if (formattedRecords.length > 0) {
              const headers = Object.keys(formattedRecords[0]);
              const rows = formattedRecords.map((r: any) =>
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
          `   Records: ${Object.values(summary).reduce((acc, s: any) => acc + s.records, 0)}`,
        );
        if (showDrafts) {
          console.log('   Mode: Including drafts');
        }
      }
    } catch (error) {
      if (options.json) {
        console.log(
          JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      } else {
        console.error('\n❌ Export failed:');
        if (error instanceof Error) {
          console.error(`   ${error.message}`);
          if (options.verbose) {
            console.error(error.stack);
          }
        }
      }
      process.exit(1);
    }
  },
};
