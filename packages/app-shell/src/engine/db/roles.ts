// The two NOLOGIN roles of one app and how a host provisions them (#5188).
//
//   <schema>_o  the owner: runs boot, migrations, snapshots and copies, and
//               owns the tables it creates. Reached only with `SET LOCAL ROLE`.
//   <schema>_r  the runtime: select/insert/update/delete on the schema's
//               tables and nothing else. Every user operation runs as it.
//
// The runtime LOGIN is made a member of `_r` WITH INHERIT FALSE (PostgreSQL 16+;
// `NOINHERIT` on the login before that), so the bare login holds none of the
// app roles' privileges and can reach them only through the broker's
// `SET LOCAL ROLE`. Names are derived, never taken from input: a schema name
// is validated first and a role name is always double-quoted.

import { EngineError } from '../errors.ts';
import { assertSchemaName } from './schema-name.ts';

export interface AppRoles {
  /** The runtime role `SET LOCAL ROLE` switches to for a user operation. */
  app: string;
  /** The owner role for boot, migration and snapshot work. */
  owner: string;
}

const ROLE = /^[a-z_][a-z0-9_]{0,62}$/;

/** A role name this module may put in a statement (quoted there as well). */
export function assertRoleName(name: unknown): string {
  if (typeof name !== 'string' || !ROLE.test(name))
    throw new EngineError('not a valid role name', 'refused');
  return name;
}

/** `<schema>_r` / `<schema>_o`. A schema name up to 61 bytes leaves room for the suffix. */
export function appRoles(schema: string): AppRoles {
  assertSchemaName(schema);
  return assertAppRoles({ app: `${schema}_r`, owner: `${schema}_o` });
}

export function assertAppRoles(roles: unknown): AppRoles {
  const r = roles as Partial<AppRoles> | null;
  if (!r || typeof r !== 'object')
    throw new EngineError(
      'roles must name an app and an owner role',
      'refused',
    );
  const out = { app: assertRoleName(r.app), owner: assertRoleName(r.owner) };
  if (out.app === out.owner)
    throw new EngineError('the app and owner roles must differ', 'refused');
  return out;
}

const q = (s: string) => `"${s.replace(/"/g, '""')}"`;

export interface ProvisionOptions {
  /**
   * The admin login that owns the app schemas, when it is not the runtime
   * login (the hosted profile's split credentials). The owner role is then
   * granted to IT (with inheritance, so the admin's copies, swaps and
   * snapshots can read the tables the owner role owns) and taken away from
   * the runtime login, which can reach only `<schema>_r`. Absent: the single
   * login gets both, neither inheriting (the self-hosted single-owner profile).
   */
  ownerLogin?: string;
}

/**
 * One statement that makes `owner` the owner of every table, view, materialized
 * view and free-standing sequence in `schema` and in the side schemas (draft,
 * rehearsal, aside, restore) the engine made of it. Idempotent. `schema` and
 * `owner` are validated names, so they are safe inside the literals.
 */
function transferOwnershipSql(schema: string, owner: string): string {
  const sch = assertSchemaName(schema);
  const own = assertRoleName(owner);
  return `DO $$ DECLARE r record; BEGIN FOR r IN SELECT c.relkind, n.nspname, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE (n.nspname = '${sch}' OR (n.nspname ~ '__[dron][a-z0-9]{16}$' AND obj_description(n.oid, 'pg_namespace') = 'smrt-side:${sch}')) AND c.relkind IN ('r', 'p', 'v', 'm', 'S') AND NOT c.relispartition AND c.relowner <> (SELECT oid FROM pg_roles WHERE rolname = '${own}') AND NOT (c.relkind = 'S' AND EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype IN ('a', 'i'))) LOOP EXECUTE format('ALTER %s %I.%I OWNER TO %I', CASE r.relkind WHEN 'S' THEN 'SEQUENCE' WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' ELSE 'TABLE' END, r.nspname, r.relname, '${own}'); END LOOP; END $$`;
}

/**
 * Grants `owner` USAGE and CREATE on the side schemas of `schema`, which
 * `ALTER ... OWNER TO` needs before it can hand the owner their tables.
 */
function grantSideSchemasSql(schema: string, owner: string): string {
  const sch = assertSchemaName(schema);
  const own = assertRoleName(owner);
  return `DO $$ DECLARE r record; BEGIN FOR r IN SELECT n.nspname FROM pg_namespace n WHERE n.nspname ~ '__[dron][a-z0-9]{16}$' AND obj_description(n.oid, 'pg_namespace') = 'smrt-side:${sch}' LOOP EXECUTE format('GRANT USAGE, CREATE ON SCHEMA %I TO %I', r.nspname, '${own}'); END LOOP; END $$`;
}

/**
 * The statements a host runs, as a role that may create roles and own the
 * schema, to provision the app roles of `schema` for the runtime login
 * `login`. Idempotent. `serverMajor` selects the INHERIT syntax.
 */
export function provisionAppRolesSql(
  schema: string,
  login: string,
  serverMajor: number,
  database: string,
  roles: AppRoles = appRoles(schema),
  options: ProvisionOptions = {},
): string[] {
  const s = q(assertSchemaName(schema));
  const { app, owner } = assertAppRoles(roles);
  const l = q(assertRoleName(login));
  const { ownerLogin } = options;
  const a = q(app);
  const o = q(owner);
  const create = (name: string, quoted: string) =>
    `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${name}') THEN CREATE ROLE ${quoted} NOLOGIN NOINHERIT; END IF; END $$`;
  return [
    create(owner, o),
    create(app, a),
    // The login runs user operations as the runtime role and, when it is the
    // only login, switches to the owner for the host's own boot work. Neither
    // membership inherits.
    serverMajor >= 16
      ? `GRANT ${a} TO ${l} WITH INHERIT FALSE, SET TRUE`
      : `GRANT ${a} TO ${l}`,
    ...(ownerLogin === undefined || ownerLogin === login
      ? [
          serverMajor >= 16
            ? `GRANT ${o} TO ${l} WITH INHERIT FALSE, SET TRUE`
            : `GRANT ${o} TO ${l}`,
        ]
      : [
          // Split credentials: the runtime login never reaches the owner role.
          `REVOKE ${o} FROM ${l}`,
          serverMajor >= 16
            ? `GRANT ${o} TO ${q(assertRoleName(ownerLogin))} WITH INHERIT TRUE, SET TRUE`
            : `GRANT ${o} TO ${q(assertRoleName(ownerLogin))}`,
        ]),
    ...(serverMajor >= 16 ? [] : [`ALTER ROLE ${l} NOINHERIT`]),
    // The provisioning identity must be able to SET ROLE to the owner role and
    // to inherit its privileges: `ALTER DEFAULT PRIVILEGES FOR ROLE` needs
    // privileges of the role (INHERIT) and `ALTER ... OWNER TO` needs SET. A
    // non-superuser admin with CREATEROLE holds only ADMIN OPTION on the roles
    // it creates (16+: neither INHERIT nor SET unless `createrole_self_grant`
    // says so), so it grants both to itself when it lacks them. Skipped when
    // it has them (a superuser, or the split-credentials admin granted the
    // owner role above), which leaves that grant alone.
    `DO $$ BEGIN IF NOT (pg_has_role(current_user, '${owner}', 'USAGE')${
      serverMajor >= 16
        ? ` AND pg_has_role(current_user, '${owner}', 'SET')`
        : ''
    }) THEN ${
      serverMajor >= 16
        ? `GRANT ${o} TO CURRENT_USER WITH INHERIT TRUE, SET TRUE`
        : `GRANT ${o} TO CURRENT_USER`
    }; END IF; END $$`,
    `GRANT USAGE, CREATE ON SCHEMA ${s} TO ${o}`,
    // Split credentials: tables, sequences and views that already exist (an
    // app made before it was provisioned, or by the admin lane) belong to the
    // admin. Boot and migrations run as the owner role, which can ALTER only
    // what it owns, so ownership moves to it (the admin keeps access through
    // its inheriting membership). Sequences a column owns follow their table.
    // ALTER ... OWNER TO needs the new owner to hold CREATE on the object's
    // schema, so this runs after the schema grants, and the side schemas get
    // theirs first.
    ...(ownerLogin === undefined || ownerLogin === login
      ? []
      : [
          grantSideSchemasSql(schema, owner),
          transferOwnershipSql(schema, owner),
        ]),
    `GRANT USAGE ON SCHEMA ${s} TO ${a}`,
    // Whatever the owner role creates from here on is reachable by the runtime.
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${o} IN SCHEMA ${s} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${a}`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${o} IN SCHEMA ${s} GRANT USAGE, SELECT ON SEQUENCES TO ${a}`,
    // Objects the provisioning identity itself creates in the schema (the
    // engine's `_app_meta`, made by the host's ownership step) reach both roles.
    `ALTER DEFAULT PRIVILEGES IN SCHEMA ${s} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${a}, ${o}`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA ${s} GRANT USAGE, SELECT ON SEQUENCES TO ${a}, ${o}`,
    // Tables that already exist (an app provisioned after it was created).
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${s} TO ${a}, ${o}`,
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${s} TO ${a}, ${o}`,
    // No temporary tables for anyone but the superuser: a temp table could
    // shadow an app table for the next statement on a pooled connection.
    `REVOKE TEMP ON DATABASE ${q(database)} FROM PUBLIC`,
  ];
}

/**
 * Provision the app roles of `schema` on `db` (anything with `query(sql)`),
 * for the runtime login `login`. The caller must be allowed to create roles and
 * to grant on the schema (the deployment's provisioning identity).
 */
export async function provisionAppRoles(
  db: { query(sql: string, params?: unknown[]): Promise<any> },
  schema: string,
  login: string,
  roles?: AppRoles,
  options?: ProvisionOptions,
): Promise<AppRoles> {
  const resolved = roles ?? appRoles(schema);
  const info = (
    await db.query(
      `SELECT current_database() AS name, current_setting('server_version_num')::int AS num`,
    )
  ).rows[0] as { name: string; num: number };
  for (const sql of provisionAppRolesSql(
    schema,
    login,
    Math.floor(info.num / 10000),
    info.name,
    resolved,
    options,
  ))
    await db.query(sql);
  return resolved;
}
