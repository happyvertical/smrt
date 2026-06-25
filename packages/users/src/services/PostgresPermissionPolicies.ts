/**
 * Postgres policy generation and application for SMRT permissions
 * @packageDocumentation
 */

import { createHash } from 'node:crypto';
import {
  findManifestEntryByQualifiedName,
  ObjectRegistry,
  type SmrtClassOptions,
} from '@happyvertical/smrt-core';
import { PermissionCollection } from '../collections/PermissionCollection.js';
import {
  PermissionCatalogService,
  type PostgresPermissionAction,
  type PostgresPermissionBinding,
} from './PermissionCatalogService.js';

interface QueryableDatabase {
  query: (sql: string, ...params: unknown[]) => Promise<unknown>;
  url?: string;
}

type DatabaseConfig = SmrtClassOptions['db'] | SmrtClassOptions['persistence'];

interface TablePolicyTarget {
  actions: Map<PostgresPermissionAction, Set<string>>;
  className?: string;
  collection?: string;
  qualifiedName?: string;
  schemaName: string;
  tableName: string;
  tenantField: string;
}

export interface PostgresPermissionPolicyReportItem {
  className?: string;
  collection?: string;
  qualifiedName?: string;
  reason: string;
  schemaName?: string;
  tableName?: string;
}

export interface PostgresPermissionPolicyTarget {
  actions: Partial<Record<PostgresPermissionAction, string[]>>;
  className?: string;
  collection?: string;
  qualifiedName?: string;
  schemaName: string;
  tableName: string;
  tenantField: string;
}

export interface GeneratePostgresPermissionSqlResult {
  bindings: PostgresPermissionBinding[];
  skipped: PostgresPermissionPolicyReportItem[];
  sql: string;
  statements: string[];
  targets: PostgresPermissionPolicyTarget[];
}

function toSnakeCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[-\s]+/g, '_')
    .toLowerCase();
}

function quoteIdent(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function isProbablyPostgres(
  configDb: DatabaseConfig,
  database: QueryableDatabase,
): boolean {
  if (
    configDb &&
    typeof configDb === 'object' &&
    !('query' in configDb) &&
    'type' in configDb &&
    configDb.type === 'postgres'
  ) {
    return true;
  }

  if (typeof database.url === 'string' && database.url.startsWith('postgres')) {
    return true;
  }

  return (database.constructor?.name || '').toLowerCase().includes('postgres');
}

function normalizePostgresPermissionAction(
  action: PostgresPermissionBinding['action'],
): PostgresPermissionAction {
  const normalized = action.toUpperCase();
  if (
    normalized === 'SELECT' ||
    normalized === 'INSERT' ||
    normalized === 'UPDATE' ||
    normalized === 'DELETE'
  ) {
    return normalized;
  }

  throw new Error(
    `Invalid Postgres permission binding action "${action}". Expected one of SELECT, INSERT, UPDATE, DELETE.`,
  );
}

function normalizePostgresPermissionBinding(
  binding: PostgresPermissionBinding,
  fallbackPermission?: string,
): PostgresPermissionBinding {
  const tableName = binding.tableName?.trim();
  if (!tableName) {
    throw new Error(
      'Postgres permission binding is missing a tableName value.',
    );
  }

  const permission = binding.permission ?? fallbackPermission;
  if (!permission) {
    throw new Error(
      'Postgres permission binding is missing a permission value.',
    );
  }

  return {
    action: normalizePostgresPermissionAction(binding.action),
    permission,
    schemaName: binding.schemaName,
    tableName,
    tenantField: binding.tenantField,
  };
}

function parseTableReference(
  binding: Pick<PostgresPermissionBinding, 'schemaName' | 'tableName'>,
): { schemaName: string; tableName: string } {
  if (binding.tableName.includes('.')) {
    const [schemaName, tableName] = binding.tableName.split('.', 2);
    return {
      schemaName,
      tableName,
    };
  }

  return {
    schemaName: binding.schemaName ?? 'public',
    tableName: binding.tableName,
  };
}

function buildPolicyName(
  tableName: string,
  action: PostgresPermissionAction,
): string {
  const actionSegment = action.toLowerCase();
  const hash = createHash('sha1')
    .update(`${tableName}:${action}`)
    .digest('hex')
    .slice(0, 8);
  const sanitizedTable = tableName
    .replace(/[^a-zA-Z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const prefix = 'smrt_';
  const separatorLength = 2;
  const maxTableSegmentLength =
    63 - prefix.length - actionSegment.length - hash.length - separatorLength;
  const tableSegment = (sanitizedTable || 'table').slice(
    0,
    Math.max(maxTableSegmentLength, 1),
  );

  return `${prefix}${tableSegment}_${actionSegment}_${hash}`;
}

function buildPermissionExpression(permissionSlugs: string[]): string {
  if (permissionSlugs.length === 0) {
    return 'FALSE';
  }

  return permissionSlugs
    .map((permission) => `smrt_has_permission(${quoteLiteral(permission)})`)
    .join(' OR ');
}

function buildTenantMatchExpression(tenantField: string): string {
  return `${quoteIdent(tenantField)}::text = smrt_current_tenant_id()`;
}

function buildSelectPolicySql(
  target: TablePolicyTarget,
  permissions: string[],
): string[] {
  const qualifiedTable = `${quoteIdent(target.schemaName)}.${quoteIdent(target.tableName)}`;
  const policyName = buildPolicyName(target.tableName, 'SELECT');
  const condition = `smrt_rls_bypass() OR ((${buildTenantMatchExpression(target.tenantField)}) AND (${buildPermissionExpression(permissions)}))`;

  return [
    `DROP POLICY IF EXISTS ${quoteIdent(policyName)} ON ${qualifiedTable}`,
    `CREATE POLICY ${quoteIdent(policyName)} ON ${qualifiedTable} FOR SELECT USING (${condition})`,
  ];
}

function buildInsertPolicySql(
  target: TablePolicyTarget,
  permissions: string[],
): string[] {
  const qualifiedTable = `${quoteIdent(target.schemaName)}.${quoteIdent(target.tableName)}`;
  const policyName = buildPolicyName(target.tableName, 'INSERT');
  const condition = `smrt_rls_bypass() OR ((${buildTenantMatchExpression(target.tenantField)}) AND (${buildPermissionExpression(permissions)}))`;

  return [
    `DROP POLICY IF EXISTS ${quoteIdent(policyName)} ON ${qualifiedTable}`,
    `CREATE POLICY ${quoteIdent(policyName)} ON ${qualifiedTable} FOR INSERT WITH CHECK (${condition})`,
  ];
}

function buildUpdatePolicySql(
  target: TablePolicyTarget,
  permissions: string[],
): string[] {
  const qualifiedTable = `${quoteIdent(target.schemaName)}.${quoteIdent(target.tableName)}`;
  const policyName = buildPolicyName(target.tableName, 'UPDATE');
  const condition = `smrt_rls_bypass() OR ((${buildTenantMatchExpression(target.tenantField)}) AND (${buildPermissionExpression(permissions)}))`;

  return [
    `DROP POLICY IF EXISTS ${quoteIdent(policyName)} ON ${qualifiedTable}`,
    `CREATE POLICY ${quoteIdent(policyName)} ON ${qualifiedTable} FOR UPDATE USING (${condition}) WITH CHECK (${condition})`,
  ];
}

function buildDeletePolicySql(
  target: TablePolicyTarget,
  permissions: string[],
): string[] {
  const qualifiedTable = `${quoteIdent(target.schemaName)}.${quoteIdent(target.tableName)}`;
  const policyName = buildPolicyName(target.tableName, 'DELETE');
  const condition = `smrt_rls_bypass() OR ((${buildTenantMatchExpression(target.tenantField)}) AND (${buildPermissionExpression(permissions)}))`;

  return [
    `DROP POLICY IF EXISTS ${quoteIdent(policyName)} ON ${qualifiedTable}`,
    `CREATE POLICY ${quoteIdent(policyName)} ON ${qualifiedTable} FOR DELETE USING (${condition})`,
  ];
}

function buildHelperStatements(): string[] {
  return [
    [
      'CREATE OR REPLACE FUNCTION smrt_rls_bypass()',
      'RETURNS boolean',
      'LANGUAGE sql',
      'STABLE',
      'AS $$',
      "  SELECT COALESCE(NULLIF(current_setting('smrt.system_context', true), ''), 'false')::boolean",
      "      OR COALESCE(NULLIF(current_setting('smrt.super_admin_bypass', true), ''), 'false')::boolean",
      '$$',
    ].join('\n'),
    [
      'CREATE OR REPLACE FUNCTION smrt_current_tenant_id()',
      'RETURNS text',
      'LANGUAGE sql',
      'STABLE',
      'AS $$',
      "  SELECT NULLIF(current_setting('smrt.tenant_id', true), '')",
      '$$',
    ].join('\n'),
    [
      'CREATE OR REPLACE FUNCTION smrt_has_permission(required_permission text)',
      'RETURNS boolean',
      'LANGUAGE sql',
      'STABLE',
      'AS $$',
      '  SELECT smrt_rls_bypass()',
      "      OR jsonb_exists(COALESCE(NULLIF(current_setting('smrt.permissions', true), ''), '[]')::jsonb, required_permission)",
      '$$',
    ].join('\n'),
  ];
}

function addBindingToTarget(
  targets: Map<string, TablePolicyTarget>,
  binding: PostgresPermissionBinding,
  source: Pick<
    TablePolicyTarget,
    'className' | 'collection' | 'qualifiedName'
  > = {},
): void {
  const { schemaName, tableName } = parseTableReference(binding);
  const targetKey = `${schemaName}.${tableName}`;
  const existing = targets.get(targetKey);
  const tenantField = binding.tenantField ?? 'tenant_id';

  if (existing && existing.tenantField !== tenantField) {
    throw new Error(
      `Conflicting tenant fields for table '${targetKey}': '${existing.tenantField}' !== '${tenantField}'`,
    );
  }

  const target = existing ?? {
    actions: new Map<PostgresPermissionAction, Set<string>>(),
    ...source,
    schemaName,
    tableName,
    tenantField,
  };
  const action = normalizePostgresPermissionAction(binding.action);
  const permissions = target.actions.get(action) ?? new Set<string>();
  if (binding.permission) {
    permissions.add(binding.permission);
  }
  target.actions.set(action, permissions);
  targets.set(targetKey, target);
}

export function generatePostgresPermissionSql(
  options: SmrtClassOptions = {},
): GeneratePostgresPermissionSqlResult {
  const catalogService = PermissionCatalogService.create(options);
  const catalog = catalogService.getCatalog();
  const config = catalogService.getUsersConfig();
  const candidateTargets = new Map<string, TablePolicyTarget>();
  const skipped: PostgresPermissionPolicyReportItem[] = [];

  const autoCandidates = new Map<
    string,
    Array<{
      className?: string;
      collection: string;
      qualifiedName?: string;
      schemaName: string;
      tableName: string;
      tenantField: string;
    }>
  >();

  for (const metadata of ObjectRegistry.getAllObjectMetadata()) {
    const registered =
      ObjectRegistry.getClassByConstructor(metadata.constructor) ??
      ObjectRegistry.getClass(metadata.name);
    const tenantScoped = registered?.tenantScopedConfig;
    const manifestEntry = registered?.qualifiedName
      ? findManifestEntryByQualifiedName(registered.qualifiedName)
      : undefined;

    if (!tenantScoped) {
      skipped.push({
        className: metadata.name,
        qualifiedName: registered?.qualifiedName,
        reason: 'not tenant-scoped',
      });
      continue;
    }

    if (tenantScoped.mode !== 'required') {
      skipped.push({
        className: metadata.name,
        qualifiedName: registered?.qualifiedName,
        reason: `tenant mode '${tenantScoped.mode}' is not supported for automatic Postgres RLS generation`,
      });
      continue;
    }

    const rawTableName =
      registered?.schema?.tableName ?? manifestEntry?.schema?.tableName;
    if (!rawTableName) {
      skipped.push({
        className: metadata.name,
        qualifiedName: registered?.qualifiedName,
        reason: 'no schema table name available',
      });
      continue;
    }

    const parsedTable = parseTableReference({
      tableName: rawTableName,
    });
    const tableKey = `${parsedTable.schemaName}.${parsedTable.tableName}`;
    const objectConfig = manifestEntry?.decoratorConfig ?? metadata.config;
    const rawCollection = (objectConfig as { collection?: unknown } | undefined)
      ?.collection;
    const configuredCollection =
      typeof rawCollection === 'string' && rawCollection.length > 0
        ? rawCollection
        : undefined;
    const collection =
      configuredCollection ??
      manifestEntry?.collection ??
      `${toSnakeCase(metadata.name)}s`;

    const entries = autoCandidates.get(tableKey) ?? [];
    entries.push({
      className: metadata.name,
      collection,
      qualifiedName: registered?.qualifiedName,
      schemaName: parsedTable.schemaName,
      tableName: parsedTable.tableName,
      tenantField: toSnakeCase(tenantScoped.field),
    });
    autoCandidates.set(tableKey, entries);
  }

  for (const [tableKey, entries] of autoCandidates) {
    if (entries.length > 1) {
      for (const entry of entries) {
        skipped.push({
          className: entry.className,
          collection: entry.collection,
          qualifiedName: entry.qualifiedName,
          reason: `table '${tableKey}' is shared by multiple objects, so automatic policy generation was skipped`,
          schemaName: entry.schemaName,
          tableName: entry.tableName,
        });
      }
      continue;
    }

    const entry = entries[0];
    addBindingToTarget(
      candidateTargets,
      {
        action: 'SELECT',
        permission: `${entry.collection}.read`,
        schemaName: entry.schemaName,
        tableName: entry.tableName,
        tenantField: entry.tenantField,
      },
      entry,
    );
    addBindingToTarget(
      candidateTargets,
      {
        action: 'INSERT',
        permission: `${entry.collection}.create`,
        schemaName: entry.schemaName,
        tableName: entry.tableName,
        tenantField: entry.tenantField,
      },
      entry,
    );
    addBindingToTarget(
      candidateTargets,
      {
        action: 'UPDATE',
        permission: `${entry.collection}.update`,
        schemaName: entry.schemaName,
        tableName: entry.tableName,
        tenantField: entry.tenantField,
      },
      entry,
    );
    addBindingToTarget(
      candidateTargets,
      {
        action: 'DELETE',
        permission: `${entry.collection}.delete`,
        schemaName: entry.schemaName,
        tableName: entry.tableName,
        tenantField: entry.tenantField,
      },
      entry,
    );
  }

  const explicitBindings: PostgresPermissionBinding[] = [];
  for (const definition of catalog.permissions) {
    for (const binding of definition.postgres?.bindings ?? []) {
      explicitBindings.push(
        normalizePostgresPermissionBinding(binding, definition.slug),
      );
    }
  }
  for (const binding of config.permissions?.postgres?.bindings ?? []) {
    explicitBindings.push(normalizePostgresPermissionBinding(binding));
  }

  for (const binding of explicitBindings) {
    addBindingToTarget(candidateTargets, binding);
  }

  const statements = [...buildHelperStatements()];
  const targets = Array.from(candidateTargets.values())
    .sort((left, right) =>
      `${left.schemaName}.${left.tableName}`.localeCompare(
        `${right.schemaName}.${right.tableName}`,
      ),
    )
    .map((target) => ({
      actions: Object.fromEntries(
        Array.from(target.actions.entries()).map(([action, permissions]) => [
          action,
          Array.from(permissions).sort(),
        ]),
      ) as Partial<Record<PostgresPermissionAction, string[]>>,
      className: target.className,
      collection: target.collection,
      qualifiedName: target.qualifiedName,
      schemaName: target.schemaName,
      tableName: target.tableName,
      tenantField: target.tenantField,
    }));

  for (const target of Array.from(candidateTargets.values())) {
    const qualifiedTable = `${quoteIdent(target.schemaName)}.${quoteIdent(target.tableName)}`;
    statements.push(`ALTER TABLE ${qualifiedTable} ENABLE ROW LEVEL SECURITY`);
    statements.push(`ALTER TABLE ${qualifiedTable} FORCE ROW LEVEL SECURITY`);

    const selectPermissions = Array.from(
      target.actions.get('SELECT') ?? [],
    ).sort();
    const insertPermissions = Array.from(
      target.actions.get('INSERT') ?? [],
    ).sort();
    const updatePermissions = Array.from(
      target.actions.get('UPDATE') ?? [],
    ).sort();
    const deletePermissions = Array.from(
      target.actions.get('DELETE') ?? [],
    ).sort();

    if (selectPermissions.length > 0) {
      statements.push(...buildSelectPolicySql(target, selectPermissions));
    }
    if (insertPermissions.length > 0) {
      statements.push(...buildInsertPolicySql(target, insertPermissions));
    }
    if (updatePermissions.length > 0) {
      statements.push(...buildUpdatePolicySql(target, updatePermissions));
    }
    if (deletePermissions.length > 0) {
      statements.push(...buildDeletePolicySql(target, deletePermissions));
    }
  }

  return {
    bindings: explicitBindings,
    skipped,
    sql: `${statements.join(';\n')};\n`,
    statements,
    targets,
  };
}

export async function applyPostgresPermissionPolicies(
  options: SmrtClassOptions = {},
): Promise<GeneratePostgresPermissionSqlResult> {
  const permissions = await PermissionCollection.create(options);
  const databaseOptions = options.db ?? options.persistence;
  if (
    !isProbablyPostgres(databaseOptions, permissions.db as QueryableDatabase)
  ) {
    throw new Error(
      'applyPostgresPermissionPolicies() requires a Postgres database connection.',
    );
  }

  const result = generatePostgresPermissionSql(options);
  for (const statement of result.statements) {
    try {
      await permissions.db.query(statement);
    } catch (error) {
      throw new Error(
        `Failed to apply Postgres permission policy statement:\n${statement}`,
        {
          cause: error,
        },
      );
    }
  }

  return result;
}
