import { resolve } from 'node:path';
import type { SchemaContractConfig } from '@happyvertical/smrt-config';
import { ObjectRegistry } from '@happyvertical/smrt-core';
import { toSnakeCase } from '@happyvertical/smrt-core/utils';
import glob from 'fast-glob';
import type { DiscoveredManifest } from '../discovery/manifest-discovery.js';

export type { SchemaContractConfig };

export interface ContractFailure {
  code:
    | 'missing_local_manifest'
    | 'missing_required_object'
    | 'missing_required_field'
    | 'missing_required_table'
    | 'missing_required_column'
    | 'missing_required_index';
  message: string;
  ref?: string;
}

export interface SchemaContractReport {
  ok: boolean;
  localManifest: {
    ok: boolean;
    count: number;
    paths: string[];
  };
  requiredObjects: Array<{
    ref: string;
    present: boolean;
    qualifiedName?: string;
  }>;
  requiredFields: Array<{
    ref: string;
    present: boolean;
    objectRef: string;
    fieldName: string;
    table?: string;
    column?: string;
  }>;
  inferredDatabaseShape: {
    tables: string[];
    columns: string[];
    indexes: string[];
  };
  requiredDatabaseShape: {
    tables: Array<{ ref: string; present?: boolean }>;
    columns: Array<{ ref: string; present?: boolean }>;
    indexes: Array<{ ref: string; present?: boolean }>;
  };
  failures: ContractFailure[];
}

export class SchemaContractError extends Error {
  constructor(public report: SchemaContractReport) {
    super(formatSchemaContractFailures(report));
    this.name = 'SchemaContractError';
  }
}

export class UnsupportedFileMigrationsError extends Error {
  constructor(
    public files: string[],
    directory: string,
  ) {
    super(
      [
        'File-backed SMRT migrations are not supported.',
        `Found migration file(s) in ${directory}:`,
        ...files.map((file) => `  - ${file}`),
        '',
        'SMRT schema migrations are manifest-driven. Remove these files and model the schema with @smrt objects instead.',
      ].join('\n'),
    );
    this.name = 'UnsupportedFileMigrationsError';
  }
}

export class UnsupportedMigrationModeError extends Error {
  constructor(
    public mode: string,
    public source: string,
  ) {
    super(
      `SMRT migration mode "${mode}" from ${source} is not supported. SMRT schema migrations are manifest-driven; set migrations.mode to "dynamic" or remove the file-backed mode setting.`,
    );
    this.name = 'UnsupportedMigrationModeError';
  }
}

const SCHEMA_PROJECT_MANIFEST_SUFFIXES = [
  '/.smrt/manifest.json',
  '/dist/manifest.json',
  '/src/manifest/manifest.json',
];

function isSchemaProjectManifest(manifest: DiscoveredManifest): boolean {
  if (manifest.source !== 'project' || manifest.objectCount <= 0) {
    return false;
  }

  const manifestPath = manifest.path.replace(/\\/g, '/');
  return SCHEMA_PROJECT_MANIFEST_SUFFIXES.some(
    (suffix) =>
      manifestPath === suffix.slice(1) || manifestPath.endsWith(suffix),
  );
}

function uniqueSorted(values: Iterable<string | undefined>): string[] {
  return Array.from(
    new Set(Array.from(values).filter(Boolean) as string[]),
  ).sort();
}

function resolveClass(ref: string): any {
  if (ref.includes(':')) {
    return (
      ObjectRegistry.getClassByQualifiedName(ref) ??
      ObjectRegistry.getClass(ref)
    );
  }

  return ObjectRegistry.getClass(ref);
}

function parseRequiredField(ref: string): {
  objectRef: string;
  fieldName: string;
} {
  const fieldSeparator = ref.lastIndexOf('.');
  if (fieldSeparator <= 0 || fieldSeparator === ref.length - 1) {
    return { objectRef: ref, fieldName: '' };
  }

  return {
    objectRef: ref.slice(0, fieldSeparator),
    fieldName: ref.slice(fieldSeparator + 1),
  };
}

function inferTableName(entry: any): string | undefined {
  const className = entry?.name;
  if (!className) return entry?.schema?.tableName;

  if (ObjectRegistry.getTableStrategy(className) === 'sti') {
    const stiBase = ObjectRegistry.getSTIBase(className);
    if (stiBase) {
      return ObjectRegistry.getTableName(stiBase) ?? entry?.schema?.tableName;
    }
  }

  return ObjectRegistry.getTableName(className) ?? entry?.schema?.tableName;
}

async function checkTable(db: any, tableName: string): Promise<any | null> {
  if (typeof db?.getTableSchema !== 'function') {
    return null;
  }

  return (await db.getTableSchema(tableName)) ?? null;
}

function schemaHasColumn(schema: any, columnName: string): boolean {
  return Boolean(schema?.columns?.[columnName]);
}

function schemaHasIndex(schema: any, indexName: string): boolean {
  if (Array.isArray(schema?.indexes)) {
    return schema.indexes.some((index: any) => index?.name === indexName);
  }

  return Boolean(schema?.indexes?.[indexName]);
}

async function checkDatabaseShape(
  db: any,
  report: SchemaContractReport,
): Promise<void> {
  const tableCache = new Map<string, any | null>();
  const getTable = async (tableName: string) => {
    if (!tableCache.has(tableName)) {
      tableCache.set(tableName, await checkTable(db, tableName));
    }
    return tableCache.get(tableName) ?? null;
  };

  for (const table of report.requiredDatabaseShape.tables) {
    const schema = await getTable(table.ref);
    table.present = Boolean(schema);
    if (!table.present) {
      report.failures.push({
        code: 'missing_required_table',
        ref: table.ref,
        message: `Required table "${table.ref}" is missing from the live database.`,
      });
    }
  }

  for (const column of report.requiredDatabaseShape.columns) {
    const [tableName, columnName] = column.ref.split('.');
    const schema = tableName && columnName ? await getTable(tableName) : null;
    column.present = Boolean(schema && schemaHasColumn(schema, columnName));
    if (!column.present) {
      report.failures.push({
        code: 'missing_required_column',
        ref: column.ref,
        message: `Required column "${column.ref}" is missing from the live database.`,
      });
    }
  }

  for (const index of report.requiredDatabaseShape.indexes) {
    const [tableName, indexName] = index.ref.split('.');
    const schema = tableName && indexName ? await getTable(tableName) : null;
    index.present = Boolean(schema && schemaHasIndex(schema, indexName));
    if (!index.present) {
      report.failures.push({
        code: 'missing_required_index',
        ref: index.ref,
        message: `Required index "${index.ref}" is missing from the live database.`,
      });
    }
  }
}

export async function assertNoUnsupportedMigrationFiles(
  config: {
    migrations?: {
      directory?: string;
      mode?: string;
      modeByEnvironment?: {
        development?: string;
        test?: string;
        staging?: string;
        production?: string;
      };
    };
  },
  projectRoot: string = process.cwd(),
): Promise<void> {
  const environment = process.env.NODE_ENV ?? 'development';
  const environmentModes = config.migrations?.modeByEnvironment as
    | Record<string, string | undefined>
    | undefined;
  const environmentMode = environmentModes?.[environment];
  const mode = environmentMode ?? config.migrations?.mode;
  if (mode && mode !== 'dynamic') {
    throw new UnsupportedMigrationModeError(
      mode,
      environmentMode
        ? `migrations.modeByEnvironment.${environment}`
        : 'migrations.mode',
    );
  }

  const directory = resolve(
    projectRoot,
    config.migrations?.directory ?? './migrations',
  );
  const files = await glob(['*.sql', '*.ts'], {
    cwd: directory,
    absolute: false,
    onlyFiles: true,
    suppressErrors: true,
    ignore: ['*.d.ts'],
  });

  if (files.length > 0) {
    throw new UnsupportedFileMigrationsError(files.sort(), directory);
  }
}

export async function evaluateSchemaContract(options: {
  discovered: DiscoveredManifest[];
  schemaContract?: SchemaContractConfig;
  db?: any;
}): Promise<SchemaContractReport> {
  const { discovered, schemaContract = {}, db } = options;
  const projectManifests = discovered.filter(isSchemaProjectManifest);
  const failures: ContractFailure[] = [];
  const requiredDatabaseShape = {
    tables: (schemaContract.requiredDatabaseShape?.tables ?? []).map((ref) => ({
      ref,
    })),
    columns: (schemaContract.requiredDatabaseShape?.columns ?? []).map(
      (ref) => ({ ref }),
    ),
    indexes: (schemaContract.requiredDatabaseShape?.indexes ?? []).map(
      (ref) => ({ ref }),
    ),
  };
  const inferredTables = new Set<string>();
  const inferredColumns = new Set<string>();
  const inferredIndexes = new Set<string>();

  if (projectManifests.length === 0) {
    failures.push({
      code: 'missing_local_manifest',
      message:
        'No local SMRT project manifest was loaded from .smrt/manifest.json, dist/manifest.json, or src/manifest/manifest.json. Package manifests from node_modules and legacy project manifest locations are not sufficient for schema commands.',
    });
  }

  const requiredObjects = (schemaContract.requiredObjects ?? []).map((ref) => {
    const entry = resolveClass(ref);
    if (!entry) {
      failures.push({
        code: 'missing_required_object',
        ref,
        message: `Required SMRT object "${ref}" is not registered.`,
      });
    } else {
      const table = inferTableName(entry);
      if (table) {
        inferredTables.add(table);
        requiredDatabaseShape.tables.push({ ref: table });
      }
    }

    return {
      ref,
      present: Boolean(entry),
      qualifiedName: entry?.qualifiedName,
    };
  });

  const requiredFields = [];
  for (const ref of schemaContract.requiredFields ?? []) {
    const { objectRef, fieldName } = parseRequiredField(ref);
    const entry = resolveClass(objectRef);
    let present = false;
    let table: string | undefined;
    let column: string | undefined;

    if (entry && fieldName) {
      const fields = await ObjectRegistry.getAllFields(entry.name);
      present = fields.has(fieldName);
      if (present) {
        table = inferTableName(entry);
        column = toSnakeCase(fieldName);
        if (table) {
          inferredTables.add(table);
          inferredColumns.add(`${table}.${column}`);
          requiredDatabaseShape.tables.push({ ref: table });
          requiredDatabaseShape.columns.push({ ref: `${table}.${column}` });
        }
      }
    }

    if (!present) {
      failures.push({
        code: 'missing_required_field',
        ref,
        message: `Required SMRT field "${ref}" is not registered.`,
      });
    }

    requiredFields.push({
      ref,
      present,
      objectRef,
      fieldName,
      table,
      column,
    });
  }

  const report: SchemaContractReport = {
    ok: false,
    localManifest: {
      ok: projectManifests.length > 0,
      count: projectManifests.length,
      paths: projectManifests.map((manifest) => manifest.path),
    },
    requiredObjects,
    requiredFields,
    inferredDatabaseShape: {
      tables: uniqueSorted(inferredTables),
      columns: uniqueSorted(inferredColumns),
      indexes: uniqueSorted(inferredIndexes),
    },
    requiredDatabaseShape,
    failures,
  };

  report.requiredDatabaseShape.tables = Array.from(
    new Map(
      report.requiredDatabaseShape.tables.map((item) => [item.ref, item]),
    ).values(),
  );
  report.requiredDatabaseShape.columns = Array.from(
    new Map(
      report.requiredDatabaseShape.columns.map((item) => [item.ref, item]),
    ).values(),
  );
  report.requiredDatabaseShape.indexes = Array.from(
    new Map(
      report.requiredDatabaseShape.indexes.map((item) => [item.ref, item]),
    ).values(),
  );

  if (db) {
    await checkDatabaseShape(db, report);
  }

  report.ok = report.failures.length === 0;
  return report;
}

export function formatSchemaContractFailures(
  report: SchemaContractReport,
): string {
  if (report.ok) {
    return 'SMRT schema contract passed.';
  }

  return [
    'SMRT schema contract failed:',
    ...report.failures.map((failure) => `  - ${failure.message}`),
    '',
    'Build or generate the local project manifest before running schema commands, and ensure required SMRT objects/fields are registered.',
  ].join('\n');
}

export function assertSchemaContract(report: SchemaContractReport): void {
  if (!report.ok) {
    throw new SchemaContractError(report);
  }
}
