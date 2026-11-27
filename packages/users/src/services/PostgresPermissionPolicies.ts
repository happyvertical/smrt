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
import { getGuestPermissionConfig } from '../guest-config.js';
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

/**
 * Narrows policy generation to one application schema, for a host that holds
 * a registry of run-time models (an app's tables are addressed unqualified
 * through a transaction-local `search_path`).
 *
 * With a scope the generator never falls back to `public`: every table is
 * addressed in `schemaName`, the `smrt_*` helper functions are created there
 * (policies call them unqualified, through that same `search_path`, so a
 * schema copied or renamed whole keeps its own helpers), only the registered classes
 * `includeClass` accepts get policies, and explicit catalog or config bindings
 * (which name tables of the deployment's own schema) are not applied.
 */
export interface PostgresPolicyScope {
  /** The schema the scoped tables and helper functions live in. */
  schemaName: string;
  /** Which registered classes get policies (default: none). */
  includeClass: (info: {
    className: string;
    qualifiedName?: string;
  }) => boolean;
  /**
   * The permission slugs that allow each action on a table, for a host whose
   * slugs are not the `<collection>.read|create|update|delete` default.
   */
  permissionsFor?: (info: {
    className: string;
    collection: string;
    tableName: string;
  }) => Partial<Record<PostgresPermissionAction, string[]>> | undefined;
}

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

const SCOPE_SCHEMA = /^[a-z_][a-z0-9_]{0,62}$/;

function assertScopeSchemaName(schemaName: unknown): void {
  if (typeof schemaName !== 'string' || !SCOPE_SCHEMA.test(schemaName)) {
    throw new Error(
      'A Postgres policy scope needs an explicit lower-case schemaName (it never falls back to public).',
    );
  }
}

/**
 * A policy is named per table, so names in different schemas cannot clash in
 * PostgreSQL; the schema still goes into the hash (except for `public`, whose
 * names predate it and must not change) so the same table name in two app
 * schemas never yields the same policy name.
 */
function buildPolicyName(
  tableName: string,
  action: PostgresPermissionAction,
  schemaName?: string,
): string {
  const actionSegment = action.toLowerCase();
  const hash = createHash('sha1')
    .update(
      schemaName && schemaName !== 'public'
        ? `${schemaName}.${tableName}:${action}`
        : `${tableName}:${action}`,
    )
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
  const policyName = buildPolicyName(
    target.tableName,
    'SELECT',
    target.schemaName,
  );
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
  const policyName = buildPolicyName(
    target.tableName,
    'INSERT',
    target.schemaName,
  );
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
  const policyName = buildPolicyName(
    target.tableName,
    'UPDATE',
    target.schemaName,
  );
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
  const policyName = buildPolicyName(
    target.tableName,
    'DELETE',
    target.schemaName,
  );
  const condition = `smrt_rls_bypass() OR ((${buildTenantMatchExpression(target.tenantField)}) AND (${buildPermissionExpression(permissions)}))`;

  return [
    `DROP POLICY IF EXISTS ${quoteIdent(policyName)} ON ${qualifiedTable}`,
    `CREATE POLICY ${quoteIdent(policyName)} ON ${qualifiedTable} FOR DELETE USING (${condition})`,
  ];
}

function buildForceRlsStatements(qualifiedTable: string): string[] {
  return [
    `ALTER TABLE ${qualifiedTable} ENABLE ROW LEVEL SECURITY`,
    `ALTER TABLE ${qualifiedTable} FORCE ROW LEVEL SECURITY`,
  ];
}

/**
 * Guest audit sink (#5196): the one INSERT policy a guest's own context gets
 * on the audit table. A guest has no user row, so its audit rows carry
 * `actor_kind = 'guest'` and a null profile; the policy admits only those rows,
 * only for the request's own tenant, and has NO `smrt_rls_bypass()` arm, so a
 * guest never needs (or gets) `smrt.system_context`.
 */
export interface GuestAuditPolicyOptions {
  /** The audit table (default `audit_logs`, the profiles `AuditLog`). */
  tableName?: string;
  /** Schema of the audit table (default `public`). */
  schemaName?: string;
  /** The tenant column (default `tenant_id`). */
  tenantField?: string;
  /** The actor-kind column (default `actor_kind`). */
  actorKindField?: string;
  /**
   * Also `ENABLE`/`FORCE` row-level security on the table (default false).
   * The audit table is optional-mode tenant data, so generation does not
   * enable RLS on it; the host opts in when it owns that decision.
   */
  enableRls?: boolean;
}

/**
 * SQL for the guest audit INSERT policy. Pure; needs the `smrt_current_tenant_id`
 * helper that {@link generatePostgresPermissionSql} creates.
 */
export function generateGuestAuditInsertPolicySql(
  options: GuestAuditPolicyOptions = {},
): string[] {
  const schemaName =
    options.schemaName ?? GUEST_AUDIT_TABLE_DEFAULTS.schemaName;
  const tableName = options.tableName ?? GUEST_AUDIT_TABLE_DEFAULTS.tableName;
  const qualifiedTable = `${quoteIdent(schemaName)}.${quoteIdent(tableName)}`;
  const policyName = guestAuditPolicyName({ schemaName, tableName });
  const tenant = quoteIdent(options.tenantField ?? 'tenant_id');
  const kind = quoteIdent(options.actorKindField ?? 'actor_kind');
  const condition = `${kind} = 'guest' AND ${tenant}::text = smrt_current_tenant_id()`;
  const statements: string[] = options.enableRls
    ? buildForceRlsStatements(qualifiedTable)
    : [];
  statements.push(
    `DROP POLICY IF EXISTS ${quoteIdent(policyName)} ON ${qualifiedTable}`,
    `CREATE POLICY ${quoteIdent(policyName)} ON ${qualifiedTable} FOR INSERT WITH CHECK (${condition})`,
  );
  return statements;
}

/** Where the audit table lives unless the host says otherwise. */
export const GUEST_AUDIT_TABLE_DEFAULTS = Object.freeze({
  schemaName: 'public',
  tableName: 'audit_logs',
  tenantField: 'tenant_id',
  actorKindField: 'actor_kind',
});

/**
 * The name of the guest audit INSERT policy for a table. One definition for
 * the installer and for the catalog check at guest admission, so the two can
 * never drift apart.
 */
export function guestAuditPolicyName(
  options: Pick<GuestAuditPolicyOptions, 'schemaName' | 'tableName'> = {},
): string {
  const tableName = options.tableName ?? GUEST_AUDIT_TABLE_DEFAULTS.tableName;
  return buildPolicyName(
    `${tableName}:guest`,
    'INSERT',
    options.schemaName ?? GUEST_AUDIT_TABLE_DEFAULTS.schemaName,
  );
}

/**
 * The companion policy that keeps every NON-guest writer working once
 * row-level security is FORCEd on the audit table: system context, super-admin
 * bypass, any signed-in principal (a user id is published) and any caller that
 * published no tenant at all keep exactly the access they had without RLS.
 * A guest context (a tenant, no user, no bypass) satisfies none of it, so the
 * guest's only door to the table is the INSERT-only guest policy.
 */
export function generateAuditNonGuestPolicySql(
  options: GuestAuditPolicyOptions = {},
): string[] {
  const schemaName =
    options.schemaName ?? GUEST_AUDIT_TABLE_DEFAULTS.schemaName;
  const tableName = options.tableName ?? GUEST_AUDIT_TABLE_DEFAULTS.tableName;
  const qualifiedTable = `${quoteIdent(schemaName)}.${quoteIdent(tableName)}`;
  const policyName = buildPolicyName(
    `${tableName}:nonguest`,
    'ALL' as PostgresPermissionAction,
    schemaName,
  );
  const condition = [
    'smrt_rls_bypass()',
    "NULLIF(current_setting('smrt.user_id', true), '') IS NOT NULL",
    'smrt_current_tenant_id() IS NULL',
  ].join(' OR ');
  return [
    `DROP POLICY IF EXISTS ${quoteIdent(policyName)} ON ${qualifiedTable}`,
    `CREATE POLICY ${quoteIdent(policyName)} ON ${qualifiedTable} FOR ALL USING (${condition}) WITH CHECK (${condition})`,
  ];
}

/** Opt-in additions to the generated policy set. */
export interface PostgresPolicyExtras {
  /**
   * Add the guest audit INSERT policy (see {@link GuestAuditPolicyOptions}).
   * When omitted and the app configures guests, it is installed by
   * default with row-level security enabled and forced on the audit table
   * (guests are refused at admission without it); `false` opts out.
   */
  guestAudit?: GuestAuditPolicyOptions | true | false;
}

function buildHelperStatements(schemaName?: string): string[] {
  const prefix = schemaName ? `${quoteIdent(schemaName)}.` : '';
  return [
    [
      `CREATE OR REPLACE FUNCTION ${prefix}smrt_rls_bypass()`,
      'RETURNS boolean',
      'LANGUAGE sql',
      'STABLE',
      'AS $$',
      "  SELECT COALESCE(NULLIF(current_setting('smrt.system_context', true), ''), 'false')::boolean",
      "      OR COALESCE(NULLIF(current_setting('smrt.super_admin_bypass', true), ''), 'false')::boolean",
      '$$',
    ].join('\n'),
    [
      `CREATE OR REPLACE FUNCTION ${prefix}smrt_current_tenant_id()`,
      'RETURNS text',
      'LANGUAGE sql',
      'STABLE',
      'AS $$',
      "  SELECT NULLIF(current_setting('smrt.tenant_id', true), '')",
      '$$',
    ].join('\n'),
    [
      `CREATE OR REPLACE FUNCTION ${prefix}smrt_has_permission(required_permission text)`,
      'RETURNS boolean',
      'LANGUAGE sql',
      'STABLE',
      'AS $$',
      // The bypass is spelled out, not called: a schema copied whole creates its
      // functions in name order, and a SQL function's body is checked when it
      // is created, so it must not depend on a sibling that comes after it.
      "  SELECT COALESCE(NULLIF(current_setting('smrt.system_context', true), ''), 'false')::boolean",
      "      OR COALESCE(NULLIF(current_setting('smrt.super_admin_bypass', true), ''), 'false')::boolean",
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
  scope?: PostgresPolicyScope,
  extras: PostgresPolicyExtras = {},
): GeneratePostgresPermissionSqlResult {
  if (scope) assertScopeSchemaName(scope.schemaName);

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
      permissions?: Partial<Record<PostgresPermissionAction, string[]>>;
    }>
  >();

  for (const metadata of ObjectRegistry.getAllObjectMetadata()) {
    const registered =
      ObjectRegistry.getClassByConstructor(metadata.constructor) ??
      ObjectRegistry.getClass(metadata.name);
    if (
      scope &&
      !scope.includeClass({
        className: metadata.name,
        qualifiedName: registered?.qualifiedName,
      })
    ) {
      continue;
    }
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
      schemaName: scope?.schemaName,
      tableName: rawTableName,
    });
    if (scope && parsedTable.schemaName !== scope.schemaName) {
      skipped.push({
        className: metadata.name,
        qualifiedName: registered?.qualifiedName,
        reason: `table '${rawTableName}' is qualified with another schema than '${scope.schemaName}'`,
      });
      continue;
    }
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
      permissions: scope?.permissionsFor?.({
        className: metadata.name,
        collection,
        tableName: parsedTable.tableName,
      }),
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
    const permissionSlugs: Record<PostgresPermissionAction, string[]> = {
      SELECT: entry.permissions?.SELECT ?? [`${entry.collection}.read`],
      INSERT: entry.permissions?.INSERT ?? [`${entry.collection}.create`],
      UPDATE: entry.permissions?.UPDATE ?? [`${entry.collection}.update`],
      DELETE: entry.permissions?.DELETE ?? [`${entry.collection}.delete`],
    };
    for (const action of ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] as const) {
      for (const permission of permissionSlugs[action]) {
        addBindingToTarget(
          candidateTargets,
          {
            action,
            permission,
            schemaName: entry.schemaName,
            tableName: entry.tableName,
            tenantField: entry.tenantField,
          },
          entry,
        );
      }
    }
  }

  // A scope names the one schema it speaks for; the deployment's own explicit
  // bindings name tables of its default schema and are not applied to it.
  const explicitBindings: PostgresPermissionBinding[] = [];
  if (!scope) {
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
  }

  for (const binding of explicitBindings) {
    addBindingToTarget(candidateTargets, binding);
  }

  const statements = [...buildHelperStatements(scope?.schemaName)];
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
    statements.push(...buildForceRlsStatements(qualifiedTable));

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

  // Guest creates write an audit row under the guest's own context, so the
  // audit table must carry the guest INSERT policy and FORCEd RLS. Installed
  // by default whenever the app configures guests (not only when a caller
  // remembers to ask; a read-only config can gain a create collection at any
  // deploy, and admission refuses guests without it); a policy scope (app-schema run-time models)
  // never gets the default because its schema has no audit table.
  const guestAudit =
    extras.guestAudit ??
    (!scope && getGuestPermissionConfig() !== null
      ? { enableRls: true }
      : false);
  if (guestAudit) {
    const auditOptions = guestAudit === true ? {} : { ...guestAudit };
    if (scope && !auditOptions.schemaName) {
      auditOptions.schemaName = scope.schemaName;
    }
    statements.push(...generateGuestAuditInsertPolicySql(auditOptions));
    // FORCEd RLS without a non-guest arm would lock out every signed-in,
    // system and background audit writer.
    if (auditOptions.enableRls) {
      statements.push(...generateAuditNonGuestPolicySql(auditOptions));
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
  extras: PostgresPolicyExtras = {},
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

  const result = generatePostgresPermissionSql(options, undefined, extras);
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

/**
 * Apply the policies of one scoped schema through a handle the caller already
 * holds, so they commit or roll back with the caller's own DDL (an app's
 * tables are created in the same transaction). The scope is required: nothing
 * here falls back to `public`. The handle must be a PostgreSQL one.
 */
export async function applyScopedPostgresPermissionPolicies(
  db: { query: (sql: string, ...params: unknown[]) => Promise<unknown> },
  scope: PostgresPolicyScope,
  options: SmrtClassOptions = {},
): Promise<GeneratePostgresPermissionSqlResult> {
  const result = generatePostgresPermissionSql(options, scope);
  for (const statement of result.statements) {
    try {
      await db.query(statement);
    } catch (error) {
      throw new Error(
        `Failed to apply Postgres permission policy statement:\n${statement}`,
        { cause: error },
      );
    }
  }
  return result;
}
