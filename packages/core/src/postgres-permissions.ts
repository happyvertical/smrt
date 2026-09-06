import { createHash } from 'node:crypto';
import type { DatabaseInterface } from '@happyvertical/sql';
import {
  CREATE_POSTGRES_CHANGE_FEED_APPEND_FUNCTION,
  CREATE_POSTGRES_CHANGE_FEED_DRAIN_FUNCTION,
  POSTGRES_CHANGE_FEED_APPEND_FUNCTION_IDENTITY,
  POSTGRES_CHANGE_FEED_DRAIN_BATCH,
  POSTGRES_CHANGE_FEED_DRAIN_FUNCTION_IDENTITY,
} from './system/schema.js';

/** PostgreSQL ACLs only; this is not application authorization or RLS. */
export interface PostgresPermissionContract {
  schema: string;
  /** Defaults affect every future object created by migrationOwner in schema. */
  schemaExclusive: true;
  migrationOwner: string;
  runtimeRole: string;
  managedTables: string[];
  /** Exact zero-argument trigger functions bound only to managed tables. */
  managedTriggerFunctions?: string[];
  monitor?: { role: string; tables: Record<string, string[]> };
}

export interface PostgresPermissionDiagnostic {
  code: string;
  severity: 'missing' | 'excessive' | 'unsupported';
  role?: string;
  resource: string;
  message: string;
}

export interface PostgresPermissionPlan {
  contract: PostgresPermissionContract;
  diagnostics: PostgresPermissionDiagnostic[];
  statements: string[];
  canApply: boolean;
  fingerprint: string;
  limitations: string[];
}

type NormalizedPostgresPermissionContract = PostgresPermissionContract & {
  managedTriggerFunctions: string[];
};

type Executor = Pick<DatabaseInterface, 'query'>;
interface Row {
  [key: string]: unknown;
  oid: string;
  name: string;
  schema: string;
  identity: string;
  argument_types: string;
  argument_count: string;
  argument_defaults: string | null;
  return_type: string;
  result: string;
  cost: string;
  rows: string;
  support: string;
  language: string;
  security_definer: boolean;
  config: unknown;
  source: string;
  volatility: string;
  parallel: string;
  leakproof: boolean;
  strict: boolean;
  function_oid: string;
  table_name: string;
  enabled: string;
  internal: boolean;
  owner: string;
  acl: Acl[];
  kind: string;
  rolname: string;
  member: string;
  parent: string;
  relation: string;
  version: string;
  executor: string;
  superuser: boolean;
  rls: boolean;
}
type Acl = {
  grantee: string;
  privilege: string;
  grantable: boolean;
  grantor?: string;
};
const bookkeeping = new Set([
  '_smrt_migrations',
  '_smrt_schema_migrations',
  '_smrt_backfills',
]);
const identifier = (value: string) => `"${value.replaceAll('"', '""')}"`;
const literal = (value: string) =>
  `E'${value.replaceAll('\\', '\\\\').replaceAll("'", "''")}'`;
const qualified = (schema: string, name: string) =>
  `${identifier(schema)}.${identifier(name)}`;

const normalizeFunctionSource = (value: string) =>
  value.replaceAll('\r\n', '\n').trim();
const normalizeArgumentTypes = (value: string) =>
  value.replaceAll(/\s*,\s*/g, ',');
const normalizeFunctionResult = (value: string) =>
  value
    .replaceAll(/\s+/g, ' ')
    .replaceAll(/\s*,\s*/g, ',')
    .replaceAll(/\(\s*/g, '(')
    .replaceAll(/\s*\)/g, ')')
    .trim()
    .toLowerCase();

function sourceFromFunctionDdl(ddl: string): string {
  const match = ddl.match(
    /\bAS\s+\$([A-Za-z_][A-Za-z0-9_]*)\$\n([\s\S]*?)\n\$\1\$;/,
  );
  if (!match)
    throw new Error('Framework function DDL has no dollar-quoted body.');
  return normalizeFunctionSource(match[2]);
}

function resultFromFunctionDdl(ddl: string): string {
  const match = ddl.match(/\bRETURNS\s+([\s\S]*?)\nLANGUAGE\s+/);
  if (!match) throw new Error('Framework function DDL has no return result.');
  return normalizeFunctionResult(match[1]);
}

type FrameworkRoutine = {
  name: string;
  argumentTypes: string;
  argumentDefaults: string | null;
  result: string;
  source: string;
};

function frameworkRoutine(identity: string, ddl: string): FrameworkRoutine {
  const match = identity.match(/^([^()]+)\((.*)\)$/);
  if (!match)
    throw new Error(`Invalid framework function identity: ${identity}`);
  return {
    name: match[1],
    argumentTypes: normalizeArgumentTypes(match[2]),
    argumentDefaults:
      match[1] === '_smrt_drain_changes'
        ? String(POSTGRES_CHANGE_FEED_DRAIN_BATCH)
        : null,
    result: resultFromFunctionDdl(ddl),
    source: sourceFromFunctionDdl(ddl),
  };
}

const frameworkRoutines = [
  frameworkRoutine(
    POSTGRES_CHANGE_FEED_APPEND_FUNCTION_IDENTITY,
    CREATE_POSTGRES_CHANGE_FEED_APPEND_FUNCTION,
  ),
  frameworkRoutine(
    POSTGRES_CHANGE_FEED_DRAIN_FUNCTION_IDENTITY,
    CREATE_POSTGRES_CHANGE_FEED_DRAIN_FUNCTION,
  ),
];

function object(
  value: unknown,
  keys: string[],
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  for (const key of Object.keys(value)) {
    if (!keys.includes(key))
      throw new Error(`Unknown ${label} property: ${key}.`);
  }
  return value as Record<string, unknown>;
}
function name(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !value.length ||
    value.includes('\0') ||
    Buffer.byteLength(value) > 63
  ) {
    throw new Error(
      `${label} must be a nonempty PostgreSQL identifier (at most 63 bytes).`,
    );
  }
  return value;
}
/** Validate configuration before opening a connection; unknown options fail closed. */
export function validatePostgresPermissionContract(
  value: unknown,
): NormalizedPostgresPermissionContract {
  const input = object(
    value,
    [
      'schema',
      'schemaExclusive',
      'migrationOwner',
      'runtimeRole',
      'managedTables',
      'managedTriggerFunctions',
      'monitor',
    ],
    'postgresPermissions',
  );
  if (input.schemaExclusive !== true)
    throw new Error(
      'postgresPermissions.schemaExclusive must explicitly be true.',
    );
  const schema = name(input.schema, 'schema');
  if (schema === 'information_schema' || schema.startsWith('pg_'))
    throw new Error('A dedicated application schema is required.');
  const migrationOwner = name(input.migrationOwner, 'migrationOwner');
  const runtimeRole = name(input.runtimeRole, 'runtimeRole');
  if (!Array.isArray(input.managedTables))
    throw new Error('managedTables must be an array.');
  const managedTables = [
    ...new Set(
      input.managedTables.map((table) => name(table, 'managedTables entry')),
    ),
  ].sort();
  if (
    input.managedTriggerFunctions !== undefined &&
    !Array.isArray(input.managedTriggerFunctions)
  )
    throw new Error('managedTriggerFunctions must be an array.');
  const managedTriggerFunctions = [
    ...new Set(
      (input.managedTriggerFunctions ?? []).map((routine) =>
        name(routine, 'managedTriggerFunctions entry'),
      ),
    ),
  ].sort();
  let monitor: PostgresPermissionContract['monitor'];
  if (input.monitor !== undefined) {
    const entry = object(input.monitor, ['role', 'tables'], 'monitor');
    const role = name(entry.role, 'monitor.role');
    if (
      !entry.tables ||
      typeof entry.tables !== 'object' ||
      Array.isArray(entry.tables)
    )
      throw new Error('monitor.tables must map tables to column arrays.');
    const tables: Record<string, string[]> = Object.create(null);
    for (const [table, columns] of Object.entries(entry.tables).sort(
      ([a], [b]) => a.localeCompare(b),
    )) {
      name(table, 'monitor table');
      if (!Array.isArray(columns) || !columns.length)
        throw new Error(
          `monitor table ${table} requires a nonempty column array.`,
        );
      tables[table] = [
        ...new Set(columns.map((column) => name(column, 'monitor column'))),
      ].sort();
    }
    monitor = { role, tables };
  }
  const roles = [
    migrationOwner,
    runtimeRole,
    ...(monitor ? [monitor.role] : []),
  ];
  if (
    new Set(roles).size !== roles.length ||
    roles.some(
      (role) => role.toUpperCase() === 'PUBLIC' || role.startsWith('pg_'),
    )
  )
    throw new Error(
      'Migration, runtime and monitor roles must be distinct non-system roles.',
    );
  return {
    schema,
    schemaExclusive: true,
    migrationOwner,
    runtimeRole,
    managedTables,
    managedTriggerFunctions,
    ...(monitor ? { monitor } : {}),
  };
}

const acl = (expression: string) =>
  `COALESCE((SELECT json_agg(json_build_object('grantee', CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END, 'grantor', pg_get_userbyid(a.grantor), 'privilege', a.privilege_type, 'grantable', a.is_grantable) ORDER BY a.grantee, a.privilege_type, a.grantor) FROM aclexplode(${expression}) a), '[]'::json)`;

async function snapshot(
  db: Executor,
  contract: NormalizedPostgresPermissionContract,
): Promise<Record<string, Row[]>> {
  const roleNames = [
    contract.migrationOwner,
    contract.runtimeRole,
    ...(contract.monitor ? [contract.monitor.role] : []),
  ]
    .map(literal)
    .join(',');
  const restrictedRoleNames = [
    contract.runtimeRole,
    ...(contract.monitor ? [contract.monitor.role] : []),
  ]
    .map(literal)
    .join(',');
  // information_schema.sql runs after initial ACL recording. Trust only its
  // explicitly PUBLIC-readable stock relations, never internal metadata views.
  // Normal-operation OIDs start at 16384:
  // https://www.postgresql.org/docs/16/system-catalog-initial-data.html
  // Source: postgres/postgres REL_14_STABLE..REL_18_STABLE,
  // GRANT SELECT [ON TABLE] ... TO PUBLIC in:
  // https://github.com/postgres/postgres/blob/REL_14_STABLE/src/backend/catalog/information_schema.sql
  // https://github.com/postgres/postgres/blob/REL_18_STABLE/src/backend/catalog/information_schema.sql
  const informationSchemaPublicSelect =
    "'administrable_role_authorizations','applicable_roles','attributes','character_sets','check_constraint_routine_usage','check_constraints','collation_character_set_applicability','collations','column_column_usage','column_domain_usage','column_options','column_privileges','column_udt_usage','columns','constraint_column_usage','constraint_table_usage','data_type_privileges','domain_constraints','domain_udt_usage','domains','element_types','enabled_roles','foreign_data_wrapper_options','foreign_data_wrappers','foreign_server_options','foreign_servers','foreign_table_options','foreign_tables','information_schema_catalog_name','key_column_usage','parameters','referential_constraints','role_column_grants','role_routine_grants','role_table_grants','role_udt_grants','role_usage_grants','routine_column_usage','routine_privileges','routine_routine_usage','routine_sequence_usage','routine_table_usage','routines','schemata','sequences','sql_features','sql_implementation_info','sql_sizing','table_constraints','table_privileges','tables','triggered_update_columns','triggers','udt_privileges','usage_privileges','user_defined_types','user_mapping_options','user_mappings','view_column_usage','view_routine_usage','view_table_usage','views'";
  // pg_init_privs records non-default initial ACLs. Missing entries use the
  // PostgreSQL object-kind default; extension-provided ACLs are not stock trust.
  // https://www.postgresql.org/docs/current/catalog-pg-init-privs.html
  const initialAcl = (fallback: string) =>
    `CASE WHEN i.privtype='i' THEN i.initprivs WHEN i.privtype='e' THEN NULL::aclitem[] ELSE ${fallback} END`;
  // Only a type referenced by another type's typarray is its generated array.
  // Nonzero typelem also describes non-array types (point); domains over arrays
  // remain independent privilege targets and must not be filtered out.
  const queries: Record<string, string> = {
    server: `SELECT current_setting('server_version_num') AS version, current_database() AS database, current_user AS executor, (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser`,
    roles: `SELECT oid::text, rolname, rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls FROM pg_roles WHERE rolname IN (${roleNames}) ORDER BY rolname`,
    memberships: `SELECT pg_get_userbyid(member) AS member, pg_get_userbyid(roleid) AS parent FROM pg_auth_members WHERE member IN (SELECT oid FROM pg_roles WHERE rolname IN (${roleNames})) OR roleid IN (SELECT oid FROM pg_roles WHERE rolname IN (${roleNames})) ORDER BY member, roleid`,
    database: `SELECT datname AS name, pg_get_userbyid(datdba) AS owner, ${acl("COALESCE(datacl, acldefault('d',datdba))")} AS acl FROM pg_database WHERE datname=current_database()`,
    schemas: `SELECT nspname AS name, pg_get_userbyid(nspowner) AS owner, ${acl("COALESCE(nspacl, acldefault('n',nspowner))")} AS acl FROM pg_namespace WHERE left(nspname,3) <> 'pg_' AND nspname <> 'information_schema' ORDER BY nspname`,
    relations: `SELECT c.oid::text, n.nspname AS schema, c.relname AS name, c.relkind AS kind, pg_get_userbyid(c.relowner) AS owner, c.relrowsecurity AS rls, ${acl("COALESCE(c.relacl, acldefault(CASE WHEN c.relkind='S' THEN 's'::\"char\" ELSE 'r'::\"char\" END,c.relowner))")} AS acl FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE left(n.nspname,3) <> 'pg_' AND n.nspname <> 'information_schema' AND c.relkind IN ('r','p','v','m','f','S') ORDER BY n.nspname,c.relname`,
    columns: `SELECT c.oid::text AS relation, a.attname AS name, ${acl('a.attacl')} AS acl FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE left(n.nspname,3) <> 'pg_' AND n.nspname <> 'information_schema' AND c.relkind IN ('r','p','v','m','f') AND a.attnum>0 AND NOT a.attisdropped ORDER BY c.oid,a.attnum`,
    routines: `SELECT n.nspname AS schema, p.oid::text, p.proname AS name, format('%I.%I(%s)', n.nspname, p.proname, oidvectortypes(p.proargtypes)) AS identity, oidvectortypes(p.proargtypes) AS argument_types, pg_get_expr(p.proargdefaults,0) AS argument_defaults, p.prokind AS kind, p.prorettype::regtype::text AS return_type, pg_get_function_result(p.oid) AS result, p.procost::text AS cost, p.prorows::text AS rows, p.prosupport::regproc::text AS support, p.pronargs::text AS argument_count, l.lanname AS language, p.prosecdef AS security_definer, p.provolatile::text AS volatility, p.proparallel::text AS parallel, p.proleakproof AS leakproof, p.proisstrict AS strict, COALESCE(to_json(p.proconfig),'[]'::json) AS config, p.prosrc AS source, CASE WHEN p.prokind='f' THEN pg_get_functiondef(p.oid) END AS definition, pg_get_userbyid(p.proowner) AS owner, ${acl("COALESCE(p.proacl, acldefault('f',p.proowner))")} AS acl FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang WHERE left(n.nspname,3) <> 'pg_' AND n.nspname <> 'information_schema' ORDER BY n.nspname,p.oid`,
    triggers: `SELECT t.oid::text, n.nspname AS schema, c.relname AS table_name, t.tgname AS name, t.tgfoid::text AS function_oid, t.tgenabled AS enabled, t.tgisinternal AS internal, t.tgtype::text AS type, encode(t.tgargs,'hex') AS arguments, pg_get_triggerdef(t.oid, true) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE left(n.nspname,3) <> 'pg_' AND n.nspname <> 'information_schema' ORDER BY n.nspname,c.oid,t.oid`,
    types: `SELECT n.nspname AS schema, t.typname AS name, pg_get_userbyid(t.typowner) AS owner, ${acl("COALESCE(t.typacl, acldefault('T',t.typowner))")} AS acl FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace LEFT JOIN pg_class c ON c.oid=t.typrelid WHERE left(n.nspname,3) <> 'pg_' AND n.nspname <> 'information_schema' AND NOT EXISTS (SELECT 1 FROM pg_type element WHERE element.typarray=t.oid) AND (t.typrelid=0 OR c.relkind='c') ORDER BY n.nspname,t.typname`,
    systemSchemas: `SELECT nspname AS name, pg_get_userbyid(nspowner) AS owner, ${acl("COALESCE(nspacl, acldefault('n',nspowner))")} AS acl FROM pg_namespace WHERE left(nspname,3)='pg_' OR nspname='information_schema' ORDER BY nspname`,
    systemPrivileges: `WITH resources AS (
      SELECT n.nspname AS schema, c.relname AS name, c.oid::text AS oid, CASE WHEN c.relkind='S' THEN 'sequence' ELSE 'relation' END AS kind, pg_get_userbyid(c.relowner) AS owner,
        COALESCE(c.relacl,acldefault(CASE WHEN c.relkind='S' THEN 's'::"char" ELSE 'r'::"char" END,c.relowner)) AS current_acl,
        CASE WHEN i.objoid IS NULL AND n.nspname='information_schema' AND c.oid<16384 AND c.relname IN (${informationSchemaPublicSelect}) THEN ARRAY[makeaclitem(0,c.relowner,'SELECT',false)] ELSE ${initialAcl("acldefault(CASE WHEN c.relkind='S' THEN 's'::\"char\" ELSE 'r'::\"char\" END,c.relowner)")} END AS initial_acl
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      LEFT JOIN pg_init_privs i ON i.objoid=c.oid AND i.classoid='pg_class'::regclass AND i.objsubid=0
      WHERE (left(n.nspname,3)='pg_' OR n.nspname='information_schema') AND c.relkind IN ('r','p','v','m','f','S')
      UNION ALL
      SELECT n.nspname, c.relname || '.' || a.attname, c.oid::text || ':' || a.attnum::text, 'column', pg_get_userbyid(c.relowner),
        a.attacl, ${initialAcl('NULL::aclitem[]')}
      FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      LEFT JOIN pg_init_privs i ON i.objoid=c.oid AND i.classoid='pg_class'::regclass AND i.objsubid=a.attnum
      WHERE (left(n.nspname,3)='pg_' OR n.nspname='information_schema') AND a.attnum>0 AND NOT a.attisdropped
      UNION ALL
      SELECT n.nspname, p.proname, p.oid::text, 'routine', pg_get_userbyid(p.proowner), COALESCE(p.proacl,acldefault('f',p.proowner)), ${initialAcl("CASE WHEN p.oid<16384 THEN acldefault('f',p.proowner) ELSE NULL::aclitem[] END")}
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      LEFT JOIN pg_init_privs i ON i.objoid=p.oid AND i.classoid='pg_proc'::regclass AND i.objsubid=0
      WHERE left(n.nspname,3)='pg_' OR n.nspname='information_schema'
      UNION ALL
      SELECT n.nspname, t.typname, t.oid::text, 'type', pg_get_userbyid(t.typowner), COALESCE(t.typacl,acldefault('T',t.typowner)), ${initialAcl("CASE WHEN t.oid<16384 THEN acldefault('T',t.typowner) ELSE NULL::aclitem[] END")}
      FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace LEFT JOIN pg_class c ON c.oid=t.typrelid
      LEFT JOIN pg_init_privs i ON i.objoid=t.oid AND i.classoid='pg_type'::regclass AND i.objsubid=0
      WHERE (left(n.nspname,3)='pg_' OR n.nspname='information_schema') AND NOT EXISTS (SELECT 1 FROM pg_type element WHERE element.typarray=t.oid) AND (t.typrelid=0 OR c.relkind='c')
    ) SELECT r.schema,r.name,r.oid,r.kind,r.owner,COALESCE(d.acl,'[]'::json) AS acl FROM resources r
    CROSS JOIN LATERAL (
      SELECT json_agg(json_build_object('grantee', CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,
        'grantor',pg_get_userbyid(a.grantor),'privilege',a.privilege_type,'grantable',a.is_grantable)
        ORDER BY a.grantee,a.privilege_type,a.grantor) AS acl
      FROM aclexplode(r.current_acl) a
      WHERE a.grantee IN (SELECT oid FROM pg_roles WHERE rolname IN (${restrictedRoleNames}))
        OR (a.grantee=0 AND NOT EXISTS (SELECT 1 FROM aclexplode(r.initial_acl) b WHERE b.grantee=0 AND b.privilege_type=a.privilege_type AND (b.is_grantable OR NOT a.is_grantable)))
    ) d WHERE d.acl IS NOT NULL OR (r.kind<>'column' AND r.owner IN (${restrictedRoleNames})) ORDER BY r.schema,r.kind,r.name,r.oid`,
    largeObjects: `SELECT oid::text, pg_get_userbyid(lomowner) AS owner, ${acl("COALESCE(lomacl, acldefault('L',lomowner))")} AS acl FROM pg_largeobject_metadata ORDER BY oid`,
    largeObjectSettings: `SELECT setting,reset_val,source FROM pg_settings WHERE name='lo_compat_privileges'`,
    largeObjectRoleSettings: `SELECT s.setdatabase::text AS database, CASE WHEN s.setrole=0 THEN 'ALL ROLES' ELSE pg_get_userbyid(s.setrole) END AS role, split_part(config.value,'=',2) AS setting FROM pg_db_role_setting s CROSS JOIN LATERAL unnest(s.setconfig) config(value) WHERE s.setdatabase IN (0,(SELECT oid FROM pg_database WHERE datname=current_database())) AND (s.setrole=0 OR s.setrole IN (SELECT oid FROM pg_roles WHERE rolname IN (${restrictedRoleNames}))) AND split_part(config.value,'=',1)='lo_compat_privileges' ORDER BY s.setdatabase,s.setrole,config.value`,
    parameters: `SELECT parname AS name, ${acl('paracl')} AS acl FROM pg_parameter_acl ORDER BY parname`,
    defaults: `SELECT pg_get_userbyid(d.defaclrole) AS owner, COALESCE(n.nspname,'') AS schema, d.defaclobjtype AS kind, ${acl('d.defaclacl')} AS acl FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid=d.defaclnamespace ORDER BY d.defaclrole,d.defaclnamespace,d.defaclobjtype`,
  };
  const result: Record<string, Row[]> = {};
  // A transaction executor must never have concurrent statements dispatched to it.
  for (const [key, query] of Object.entries(queries)) {
    // Parameter ACLs were introduced in PostgreSQL 15.
    if (key === 'parameters' && Number(result.server[0].version) < 150000) {
      result[key] = [];
      continue;
    }
    result[key] = (await db.query(query)).rows as Row[];
  }
  return result;
}

async function plan(
  db: Executor,
  input: unknown,
): Promise<PostgresPermissionPlan> {
  const contract = validatePostgresPermissionContract(input);
  const state = await snapshot(db, contract);
  const diagnostics: PostgresPermissionDiagnostic[] = [];
  const statements: string[] = [];
  const roles = [
    contract.runtimeRole,
    ...(contract.monitor ? [contract.monitor.role] : []),
  ];
  const add = (
    severity: PostgresPermissionDiagnostic['severity'],
    code: string,
    resource: string,
    message: string,
    role?: string,
  ) =>
    diagnostics.push({
      severity,
      code,
      resource,
      message,
      ...(role ? { role } : {}),
    });
  const unsupported = (
    code: string,
    resource: string,
    message: string,
    role?: string,
  ) => add('unsupported', code, resource, message, role);
  if (Number(state.server[0].version) < 140000)
    unsupported(
      'server-version',
      'database',
      'PostgreSQL 14 or later is required.',
    );
  for (const role of [contract.migrationOwner, ...roles]) {
    const row = state.roles.find((entry) => entry.rolname === role);
    if (!row) {
      unsupported(
        'missing-role',
        role,
        'Infrastructure must create this role.',
        role,
      );
      continue;
    }
    if (
      roles.includes(role) &&
      [
        'rolsuper',
        'rolcreaterole',
        'rolcreatedb',
        'rolreplication',
        'rolbypassrls',
      ].some((key) => row[key])
    )
      unsupported(
        'privileged-role',
        role,
        'Remove SUPERUSER, CREATEROLE, CREATEDB, REPLICATION and BYPASSRLS authority using infrastructure role management.',
        role,
      );
  }
  for (const membership of state.memberships)
    unsupported(
      'role-membership',
      membership.member,
      `Role ${membership.member} is a member of ${membership.parent}; inbound and outbound membership, inherited privileges, and SET ROLE authority require infrastructure review. Memberships are never modified.`,
      membership.member,
    );
  const schema = state.schemas.find((entry) => entry.name === contract.schema);
  if (!schema)
    unsupported(
      'missing-schema',
      contract.schema,
      'Create the dedicated schema as the migration owner before reconciliation.',
    );
  else if (schema.owner !== contract.migrationOwner)
    unsupported(
      'schema-owner',
      contract.schema,
      `Schema must be owned by ${contract.migrationOwner}; ownership is never changed.`,
    );
  const database = state.database[0];
  if (roles.includes(database.owner))
    unsupported(
      'database-owner',
      database.name,
      'Runtime and monitor must not own the database.',
      database.owner,
    );

  const relevant = (entries: Acl[], role: string) =>
    entries.filter(
      (entry) => entry.grantee === role || entry.grantee === 'PUBLIC',
    );
  function reconcile(
    kind: string,
    resource: string,
    entries: Acl[],
    role: string,
    desired: string[],
    suffix = '',
  ) {
    for (const entry of entries)
      if (entry.grantor === role && entry.grantee !== role)
        unsupported(
          'dependent-grant',
          resource,
          `Configured role granted ${entry.privilege} to ${entry.grantee}; grant chains require infrastructure review to preserve other roles.`,
          role,
        );
    for (const entry of entries) {
      if (
        entry.grantee === 'PUBLIC' &&
        !(
          kind === 'DATABASE' &&
          entry.privilege === 'CONNECT' &&
          !entry.grantable
        )
      ) {
        unsupported(
          'public-privilege',
          resource,
          `PUBLIC ${entry.privilege} is outside the explicit role contract; infrastructure must review it without changing unrelated access.`,
          role,
        );
      }
    }
    const effective = relevant(entries, role);
    const excess = effective.filter(
      (entry) => !desired.includes(entry.privilege) || entry.grantable,
    );
    const missing = desired.filter(
      (privilege) =>
        !entries.some(
          (entry) => entry.grantee === role && entry.privilege === privilege,
        ),
    );
    for (const entry of excess) {
      add(
        'excessive',
        'excessive-privilege',
        resource,
        `${entry.privilege}${entry.grantable ? ' WITH GRANT OPTION' : ''} is not declared (source: ${entry.grantee}).`,
        role,
      );
      if (entry.grantee === 'PUBLIC')
        unsupported(
          'public-privilege',
          resource,
          `PUBLIC ${entry.privilege} requires infrastructure review; revoking it would affect other roles.`,
          role,
        );
    }
    for (const privilege of missing)
      add(
        'missing',
        'missing-privilege',
        resource,
        `${privilege} is required.`,
        role,
      );
    if (!excess.length && !missing.length) return;
    statements.push(
      `REVOKE ALL PRIVILEGES${suffix} ON ${kind} ${resource} FROM ${identifier(role)}`,
    );
    if (desired.length)
      statements.push(
        `GRANT ${desired.join(', ')}${suffix} ON ${kind} ${resource} TO ${identifier(role)}`,
      );
  }
  function reconcileRoutine(
    resource: string,
    entries: Acl[],
    desiredByRole: ReadonlyMap<string, readonly string[]>,
  ) {
    const grantee = (role: string) =>
      role === 'PUBLIC' ? 'PUBLIC' : identifier(role);
    for (const entry of entries)
      if (
        roles.includes(entry.grantor ?? '') &&
        entry.grantee !== entry.grantor
      )
        unsupported(
          'dependent-routine-grant',
          resource,
          `Configured role granted ${entry.privilege} to ${entry.grantee}; grant chains require infrastructure review to preserve other roles.`,
          entry.grantor,
        );
    const managedGrantees = new Set([
      contract.migrationOwner,
      ...roles,
      'PUBLIC',
    ]);
    for (const entry of entries)
      if (!managedGrantees.has(entry.grantee))
        unsupported(
          'outside-routine-grant',
          resource,
          `${entry.grantee} has ${entry.privilege}; direct routine access outside the declared roles requires infrastructure review.`,
          entry.grantee,
        );
    for (const role of [...roles, 'PUBLIC']) {
      const desired = desiredByRole.get(role) ?? [];
      const effective = entries.filter((entry) => entry.grantee === role);
      const excess = effective.filter(
        (entry) => !desired.includes(entry.privilege) || entry.grantable,
      );
      const missing = desired.filter(
        (privilege) =>
          !entries.some(
            (entry) => entry.grantee === role && entry.privilege === privilege,
          ),
      );
      for (const entry of excess)
        add(
          'excessive',
          'excessive-routine-privilege',
          resource,
          `${entry.privilege}${entry.grantable ? ' WITH GRANT OPTION' : ''} is not declared.`,
          role,
        );
      for (const privilege of missing)
        add(
          'missing',
          'missing-routine-privilege',
          resource,
          `${privilege} is required.`,
          role,
        );
      if (!excess.length && !missing.length) continue;
      statements.push(
        `REVOKE ALL PRIVILEGES ON FUNCTION ${resource} FROM ${grantee(role)}`,
      );
      if (desired.length)
        statements.push(
          `GRANT ${desired.join(', ')} ON FUNCTION ${resource} TO ${grantee(role)}`,
        );
    }
  }
  for (const role of roles) {
    reconcile('DATABASE', identifier(database.name), database.acl, role, [
      'CONNECT',
    ]);
    for (const entry of state.schemas) {
      if (entry.owner === role)
        unsupported(
          'resource-owner',
          entry.name,
          'Configured role owns a schema and has DDL authority.',
          role,
        );
      if (entry.name === contract.schema)
        reconcile('SCHEMA', identifier(entry.name), entry.acl, role, ['USAGE']);
      else if (
        relevant(entry.acl, role).some((grant) => grant.privilege === 'CREATE')
      )
        unsupported(
          'outside-schema-create',
          entry.name,
          'Effective CREATE outside the dedicated schema requires infrastructure repair.',
          role,
        );
    }
  }
  for (const schema of state.systemSchemas) {
    for (const role of roles) {
      if (schema.owner === role) {
        unsupported(
          'system-schema-owner',
          schema.name,
          'Configured roles must not own system schemas; infrastructure must restore separate ownership. System schema ownership is never modified.',
          role,
        );
      }
      for (const grant of relevant(schema.acl, role)) {
        if (grant.privilege === 'CREATE') {
          unsupported(
            'system-schema-authority',
            schema.name,
            `Effective CREATE on a system schema (source: ${grant.grantee}) gives DDL authority and requires infrastructure repair. System schema ACLs are never modified.`,
            role,
          );
        }
      }
    }
  }
  for (const resource of state.systemPrivileges) {
    if (resource.kind !== 'column' && roles.includes(resource.owner)) {
      unsupported(
        'system-object-owner',
        qualified(resource.schema, resource.name),
        `Configured role owns a system ${resource.kind}; ownership retains implicit alteration and grant authority even when its ordinary ACLs are revoked. Infrastructure must restore ownership; SMRT never changes it.`,
        resource.owner,
      );
    }
    for (const grant of resource.acl) {
      unsupported(
        'system-privilege-delta',
        qualified(resource.schema, resource.name),
        `${grant.grantee} has exceptional ${grant.privilege}${grant.grantable ? ' WITH GRANT OPTION' : ''} on a system ${resource.kind}; review infrastructure grants against PostgreSQL initial ACLs. System ACLs are never modified.`,
        grant.grantee === 'PUBLIC' ? undefined : grant.grantee,
      );
    }
  }
  for (const resource of state.largeObjects) {
    if (roles.includes(resource.owner)) {
      unsupported(
        'large-object-owner',
        `large object ${resource.oid}`,
        'Configured role owns a large object outside the declared table/column contract. Infrastructure must review ownership; SMRT never changes it.',
        resource.owner,
      );
    }
    for (const grant of resource.acl) {
      if (roles.includes(grant.grantee) || grant.grantee === 'PUBLIC') {
        unsupported(
          'large-object-privilege',
          `large object ${resource.oid}`,
          `${grant.grantee} has ${grant.privilege}${grant.grantable ? ' WITH GRANT OPTION' : ''} outside the declared table/column contract. Infrastructure must review this ACL; SMRT neither reads payloads nor changes large-object permissions.`,
          grant.grantee === 'PUBLIC' ? undefined : grant.grantee,
        );
      }
    }
  }
  const explicitlyOff = (value: unknown) =>
    ['off', 'false', 'no', '0'].includes(String(value).toLowerCase());
  if (state.largeObjectSettings.length !== 1) {
    unsupported(
      'large-object-compatibility',
      'lo_compat_privileges',
      'The large-object ACL compatibility setting could not be established; qualification requires an observable disabled setting.',
    );
  }
  for (const settings of state.largeObjectSettings) {
    if (
      !explicitlyOff(settings.setting) ||
      !explicitlyOff(settings.reset_val) ||
      !['default', 'configuration file', 'command line', 'database'].includes(
        String(settings.source),
      )
    ) {
      unsupported(
        'large-object-compatibility',
        'lo_compat_privileges',
        'Large-object ACL checks must be enabled for every configured role. An enabled or operator-specific lo_compat_privileges override cannot establish that baseline; review deployment settings and reconnect without an operator-specific override.',
      );
    }
  }
  for (const settings of state.largeObjectRoleSettings) {
    if (!explicitlyOff(settings.setting)) {
      unsupported(
        'large-object-compatibility',
        'lo_compat_privileges',
        `Role/database defaults enable or do not establish large-object ACL checks (${String(settings.role)}, database OID ${String(settings.database)}). Infrastructure must disable compatibility mode before qualification.`,
        settings.role === 'ALL ROLES' ? undefined : String(settings.role),
      );
    }
  }
  for (const parameter of state.parameters) {
    for (const role of roles) {
      for (const grant of relevant(parameter.acl, role)) {
        unsupported(
          'parameter-privilege',
          parameter.name,
          `Effective ${grant.privilege} on a PostgreSQL configuration parameter (source: ${grant.grantee}) requires infrastructure review; parameter ACLs are never modified.`,
          role,
        );
      }
    }
  }
  const tables = state.relations.filter(
    (entry) => entry.schema === contract.schema && entry.kind !== 'S',
  );
  for (const table of bookkeeping) {
    if (!tables.some((entry) => entry.name === table)) {
      unsupported(
        'missing-bookkeeping-table',
        qualified(contract.schema, table),
        'Bootstrap all framework bookkeeping tables as the migration owner before permission setup. Stop runtime and monitoring access during migrations or restores, then reconcile before reactivation.',
      );
    }
  }
  const declared = new Set(contract.managedTables);
  // Framework feature tables are owned by SMRT even when absent from manifests.
  for (const table of tables)
    if (table.name.startsWith('_smrt_')) declared.add(table.name);
  for (const table of declared)
    if (!tables.some((entry) => entry.name === table))
      unsupported(
        'missing-table',
        qualified(contract.schema, table),
        'Run supported schema migrations before reconciling permissions.',
      );
  for (const [table, columns] of Object.entries(
    contract.monitor?.tables ?? {},
  )) {
    const relation = tables.find((entry) => entry.name === table);
    if (!declared.has(table) || !relation)
      unsupported(
        'monitor-table',
        table,
        'Monitor tables must exist and belong to managedTables or framework tables.',
      );
    for (const column of columns)
      if (
        !relation ||
        !state.columns.some(
          (entry) => entry.relation === relation.oid && entry.name === column,
        )
      )
        unsupported(
          'monitor-column',
          `${table}.${column}`,
          'The declared monitoring column does not exist.',
        );
  }
  for (const relation of state.relations) {
    const resource = qualified(relation.schema, relation.name);
    const columns = state.columns.filter(
      (entry) => entry.relation === relation.oid,
    );
    if (relation.schema !== contract.schema) {
      for (const role of roles)
        if (
          relation.owner === role ||
          relevant(relation.acl, role).length ||
          columns.some((column) => relevant(column.acl, role).length)
        )
          unsupported(
            'outside-resource-access',
            resource,
            'Effective access to an unrelated relation requires infrastructure review; unrelated ACLs are preserved.',
            role,
          );
      continue;
    }
    if (relation.owner !== contract.migrationOwner)
      unsupported(
        'resource-owner',
        resource,
        `Managed resources must be owned by ${contract.migrationOwner}; ownership is never changed.`,
      );
    if (relation.kind !== 'S' && !declared.has(relation.name))
      unsupported(
        'undeclared-table',
        resource,
        'The dedicated schema contains an undeclared table; defaults cannot safely cover a mixed schema.',
      );
    if (!['r', 'p', 'S'].includes(relation.kind))
      unsupported(
        'unsupported-relation',
        resource,
        `Relation kind ${relation.kind} requires a separate security review.`,
      );
    if (relation.rls)
      unsupported(
        'row-level-security',
        resource,
        'RLS policies require a separate application authorization review; ACL verification cannot establish allowed row operations.',
      );
    for (const role of roles) {
      const isRuntime = role === contract.runtimeRole;
      const desired = isRuntime
        ? relation.kind === 'S'
          ? ['USAGE']
          : bookkeeping.has(relation.name)
            ? ['SELECT']
            : ['SELECT', 'INSERT', 'UPDATE', 'DELETE']
        : [];
      reconcile(
        relation.kind === 'S' ? 'SEQUENCE' : 'TABLE',
        resource,
        relation.acl,
        role,
        desired,
      );
      for (const column of columns) {
        const wanted =
          !isRuntime &&
          (contract.monitor?.tables[relation.name] ?? []).includes(column.name)
            ? ['SELECT']
            : [];
        reconcile(
          'TABLE',
          resource,
          column.acl,
          role,
          wanted,
          ` (${identifier(column.name)})`,
        );
      }
    }
  }
  const triggerRoutineNames = new Set(contract.managedTriggerFunctions);
  const acceptedTriggerRoutineNames = new Set<string>();
  const routineConfigIsEmpty = (value: unknown) =>
    (Array.isArray(value) && value.length === 0) || value === '[]';
  for (const resource of state.routines) {
    const resourceName = qualified(resource.schema, resource.name);
    const framework = frameworkRoutines.find(
      (expected) =>
        resource.schema === contract.schema &&
        resource.name === expected.name &&
        normalizeArgumentTypes(resource.argument_types) ===
          expected.argumentTypes,
    );
    if (framework) {
      const valid =
        resource.owner === contract.migrationOwner &&
        resource.kind === 'f' &&
        resource.language === 'plpgsql' &&
        resource.security_definer === false &&
        resource.argument_defaults === framework.argumentDefaults &&
        normalizeFunctionResult(resource.result) === framework.result &&
        resource.cost === '100' &&
        resource.rows === '1000' &&
        resource.support === '-' &&
        resource.volatility === 'v' &&
        resource.parallel === 'u' &&
        resource.leakproof === false &&
        resource.strict === false &&
        routineConfigIsEmpty(resource.config) &&
        normalizeFunctionSource(String(resource.source)) === framework.source;
      if (!valid)
        unsupported(
          'framework-routine-definition',
          resourceName,
          'Framework routine must retain its canonical identity, owner, invoker security, defaults, execution properties, settings and generated body.',
        );
      else
        reconcileRoutine(
          resource.identity,
          resource.acl,
          new Map([[contract.runtimeRole, ['EXECUTE']]]),
        );
      continue;
    }
    const bindings = state.triggers.filter(
      (trigger) => trigger.function_oid === resource.oid,
    );
    const triggerRoutine =
      resource.schema === contract.schema &&
      triggerRoutineNames.has(resource.name) &&
      resource.kind === 'f' &&
      resource.return_type === 'trigger' &&
      resource.argument_types === '' &&
      resource.argument_count === '0' &&
      resource.owner === contract.migrationOwner &&
      resource.language === 'plpgsql' &&
      resource.security_definer === false &&
      routineConfigIsEmpty(resource.config) &&
      bindings.length > 0 &&
      bindings.every(
        (trigger) =>
          trigger.schema === contract.schema &&
          trigger.internal === false &&
          (trigger.enabled === 'O' || trigger.enabled === 'A') &&
          declared.has(trigger.table_name),
      );
    if (triggerRoutine) {
      acceptedTriggerRoutineNames.add(resource.name);
      reconcileRoutine(resource.identity, resource.acl, new Map());
      continue;
    }
    for (const role of roles)
      if (
        resource.schema === contract.schema ||
        resource.owner === role ||
        relevant(resource.acl, role).length
      )
        unsupported(
          'unsupported-routines',
          resourceName,
          triggerRoutineNames.has(resource.name)
            ? 'Declared trigger routines must be migration-owner invoker PL/pgSQL functions returning trigger with no declared arguments, no function settings, and enabled non-internal bindings only to declared managed tables.'
            : 'User-defined routines are outside the supported table/sequence and declared trigger contract; review their effective privileges explicitly.',
          role,
        );
  }
  for (const name of triggerRoutineNames)
    if (!acceptedTriggerRoutineNames.has(name))
      unsupported(
        'missing-managed-trigger-function',
        qualified(contract.schema, name),
        'Run the migration that creates this exact managed trigger function and its enabled binding before reconciling permissions.',
      );
  for (const resource of state.types)
    for (const role of roles)
      if (
        resource.schema === contract.schema ||
        resource.owner === role ||
        relevant(resource.acl, role).length
      )
        unsupported(
          'unsupported-types',
          qualified(resource.schema, resource.name),
          'User-defined types are outside the supported table/sequence contract; review their effective privileges explicitly.',
          role,
        );
  // Global grants combine with schema grants: a schema REVOKE cannot cancel them.
  for (const defaults of state.defaults) {
    const resource = `DEFAULT ${defaults.kind} (${defaults.schema || 'global'})`;
    if (
      defaults.owner !== contract.migrationOwner &&
      defaults.acl.some((entry: Acl) => roles.includes(entry.grantee))
    )
      unsupported(
        'other-creator-access',
        resource,
        `Creator ${defaults.owner} grants configured roles future access outside this contract.`,
      );
    if (
      defaults.schema !== contract.schema &&
      defaults.schema !== '' &&
      defaults.acl.some(
        (entry: Acl) =>
          entry.grantee === 'PUBLIC' || roles.includes(entry.grantee),
      )
    )
      unsupported(
        'outside-default-privilege',
        resource,
        'Defaults outside the managed schema grant future access and require infrastructure review.',
      );
    if (
      defaults.schema === '' &&
      defaults.acl.some(
        (entry: Acl) =>
          roles.includes(entry.grantee) ||
          (entry.grantee === 'PUBLIC' &&
            ['r', 'S', 'n'].includes(defaults.kind)),
      )
    )
      unsupported(
        'global-default-privilege',
        resource,
        'Global creator defaults grant configured roles or PUBLIC access and cannot be repaired within this schema.',
      );
    if (
      defaults.schema === contract.schema &&
      defaults.owner !== contract.migrationOwner
    )
      unsupported(
        'other-creator-default',
        resource,
        `Defaults for creator ${defaults.owner} require separate ownership review.`,
      );
    if (
      defaults.schema === contract.schema &&
      !['r', 'S'].includes(defaults.kind) &&
      defaults.acl.some(
        (entry: Acl) =>
          roles.includes(entry.grantee) || entry.grantee === 'PUBLIC',
      )
    )
      unsupported(
        'unsupported-default',
        resource,
        'Only table and sequence schema defaults are supported.',
      );
  }
  for (const [kind, sqlKind, runtime] of [
    ['r', 'TABLES', ['SELECT', 'INSERT', 'UPDATE', 'DELETE']],
    ['S', 'SEQUENCES', ['USAGE']],
  ] as const) {
    const entry = state.defaults.find(
      (item) =>
        item.schema === contract.schema &&
        item.owner === contract.migrationOwner &&
        item.kind === kind,
    );
    if (entry?.acl.some((grant) => grant.grantee === 'PUBLIC')) {
      unsupported(
        'public-default',
        `${contract.schema} ${sqlKind}`,
        'PUBLIC creator defaults are outside the explicit role contract and require infrastructure review.',
      );
    }
    for (const role of roles) {
      const desired: readonly string[] =
        role === contract.runtimeRole ? runtime : [];
      const effective = relevant(entry?.acl ?? [], role);
      const extra = effective.filter(
        (grant) => !desired.includes(grant.privilege) || grant.grantable,
      );
      const missing = desired.filter(
        (privilege) =>
          !(entry?.acl ?? []).some(
            (grant) => grant.grantee === role && grant.privilege === privilege,
          ),
      );
      if (!extra.length && !missing.length) continue;
      for (const grant of extra) {
        add(
          'excessive',
          'default-excessive',
          `${contract.schema} ${sqlKind}`,
          `${grant.privilege} default from ${grant.grantee} is not declared.`,
          role,
        );
        if (grant.grantee === 'PUBLIC')
          unsupported(
            'public-default',
            contract.schema,
            'PUBLIC defaults affect other roles and require infrastructure repair.',
          );
      }
      for (const privilege of missing)
        add(
          'missing',
          'default-missing',
          `${contract.schema} ${sqlKind}`,
          `Creator ${contract.migrationOwner} must default ${privilege}.`,
          role,
        );
      const prefix = `ALTER DEFAULT PRIVILEGES FOR ROLE ${identifier(contract.migrationOwner)} IN SCHEMA ${identifier(contract.schema)}`;
      statements.push(
        `${prefix} REVOKE ALL PRIVILEGES ON ${sqlKind} FROM ${identifier(role)}`,
      );
      if (desired.length)
        statements.push(
          `${prefix} GRANT ${desired.join(', ')} ON ${sqlKind} TO ${identifier(role)}`,
        );
    }
  }
  const executor = state.server[0];
  if (
    statements.length &&
    !executor.superuser &&
    executor.executor !== contract.migrationOwner
  )
    unsupported(
      'execution-authority',
      'database',
      'Apply requires the migration owner or a superuser; plan and apply must use the same actor.',
    );
  if (
    statements.some((sql) => sql.includes(' ON DATABASE ')) &&
    !executor.superuser &&
    database.owner !== executor.executor
  )
    unsupported(
      'database-authority',
      database.name,
      'Database ACL remediation requires its owner or a superuser.',
    );
  return {
    contract,
    diagnostics,
    limitations: [
      'Only PostgreSQL table, column, sequence, schema and database ACLs are qualified; application authorization and RLS are separate. Large-object ownership/access is unsupported, and lo_compat_privileges must remain off for deployed roles.',
      'Future user-defined routines and types are unsupported. PostgreSQL implicit global defaults grant PUBLIC EXECUTE/USAGE; rerun diagnostics after every migration before activating runtime roles.',
      'Pause migrations and external ACL/role writers during planning and apply. The advisory lock coordinates SMRT permission writers only.',
      'All framework bookkeeping tables must exist before setup. Stop runtime and monitor access throughout migrations, restores and repair: recreated bookkeeping tables temporarily receive creator CRUD defaults and require explicit reconciliation before either role is reactivated.',
    ],
    statements: [...new Set(statements)],
    canApply: !diagnostics.some((entry) => entry.severity === 'unsupported'),
    fingerprint: createHash('sha256')
      .update(JSON.stringify({ contract, state }))
      .digest('hex'),
  };
}

/** Read-only catalog inspection. No application records or credentials are read. */
export async function planPostgresPermissions(
  db: Executor,
  contract: PostgresPermissionContract,
): Promise<PostgresPermissionPlan> {
  return plan(db, contract);
}

/** Apply the reviewed contract atomically, rejecting stale catalog snapshots. */
export async function applyPostgresPermissions(
  db: DatabaseInterface,
  contract: PostgresPermissionContract,
  options: { expectedFingerprint: string },
): Promise<PostgresPermissionPlan> {
  const normalizedContract = validatePostgresPermissionContract(contract);
  if (!options || !/^[a-f0-9]{64}$/.test(options.expectedFingerprint))
    throw new Error(
      'An expectedFingerprint from a reviewed permission plan is required.',
    );
  if (!db.transaction)
    throw new Error(
      'PostgreSQL permissions require a transaction-capable database.',
    );
  return db.transaction(async (tx) => {
    await tx.query("SET LOCAL lock_timeout = '5s'");
    await tx.query("SET LOCAL statement_timeout = '30s'");
    // Cooperating permission writers serialize; operators must quiesce migrations.
    await tx.query(
      `SELECT pg_advisory_xact_lock(hashtext(${literal(`smrt-permissions:${normalizedContract.schema}`)}))`,
    );
    const before = await plan(tx, normalizedContract);
    if (before.fingerprint !== options.expectedFingerprint)
      throw new Error(
        'Permission plan is stale; generate and review a new plan.',
      );
    if (!before.canApply)
      throw new Error(
        'Permission plan has unsupported privilege sources or missing prerequisites; resolve its diagnostics first.',
      );
    const executor = (
      await tx.query(
        'SELECT current_user AS name, rolsuper FROM pg_roles WHERE rolname=current_user',
      )
    ).rows[0];
    if (
      !executor.rolsuper &&
      executor.name !== normalizedContract.migrationOwner
    )
      throw new Error(
        'Apply must execute as the migration owner or a PostgreSQL superuser.',
      );
    for (const statement of before.statements) await tx.query(statement);
    const after = await plan(tx, normalizedContract);
    if (!after.canApply || after.diagnostics.length)
      throw new Error(
        'Permission verification failed; all permission changes have been rolled back.',
      );
    return after;
  });
}
