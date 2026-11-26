// The startup check on the runtime login (#5188). The data lane's connection
// is a login that must hold NO power of its own: everything an operation may do
// comes from `SET LOCAL ROLE <schema>_r`, which the broker (trusted main-thread
// code) alone issues. If the login were a superuser, bypassed row-level
// security, owned the tables, could create objects or temp tables, inherited an
// app role, or held table privileges as itself, then a mistake anywhere would
// silently run with that power. So the host refuses to start the app instead.
//
// `runtimeLoginProblems` is a pure function over catalog facts (unit-tested on
// stubbed rows); `assertRuntimeLogin` reads the facts as the login and applies it.

import { EngineError } from '../errors.ts';
import { appRoles } from './roles.ts';
import { assertSchemaName } from './schema-name.ts';

/** What the catalog says about one role. */
export interface RoleFacts {
  name: string;
  superuser: boolean;
  bypassRls: boolean;
  createRole: boolean;
  createDb: boolean;
  /** Tables of the checked schemas this role owns. */
  ownedTables: string[];
  /** Checked schemas this role may CREATE in. */
  createOnSchemas: string[];
  /** CREATE on the database. */
  databaseCreate: boolean;
  /** TEMP on the database (a temp table could shadow an app table on a pooled connection). */
  databaseTemp: boolean;
}

export interface RuntimeLoginFacts {
  login: RoleFacts;
  /** Of the app roles named, those the login inherits (`pg_has_role(login, role, 'USAGE')`). */
  inheritedAppRoles: string[];
  /** Tables of the checked schemas the bare login holds a privilege on. */
  bareTablePrivileges: string[];
  /** The `<schema>_r` / `<schema>_o` roles of the checked schemas. */
  appRoles: RoleFacts[];
}

const roleProblems = (r: RoleFacts, who: string): string[] => {
  const out: string[] = [];
  if (r.superuser) out.push(`${who} is a superuser`);
  if (r.bypassRls) out.push(`${who} has BYPASSRLS`);
  if (r.createRole) out.push(`${who} has CREATEROLE`);
  if (r.createDb) out.push(`${who} has CREATEDB`);
  if (r.ownedTables.length)
    out.push(`${who} owns tables (${r.ownedTables.slice(0, 3).join(', ')})`);
  if (r.createOnSchemas.length)
    out.push(
      `${who} has CREATE on schema ${r.createOnSchemas.slice(0, 3).join(', ')}`,
    );
  if (r.databaseCreate) out.push(`${who} has CREATE on the database`);
  if (r.databaseTemp) out.push(`${who} holds TEMP on the database`);
  return out;
};

/**
 * Everything that makes the login (or a runtime role) too powerful, as
 * human-readable problems; empty when it is fit to run user operations.
 *
 * The owner roles (`<schema>_o`) own the tables and may CREATE in their schema
 * by design, so only the attributes that bypass the model apply to them.
 */
export function runtimeLoginProblems(f: RuntimeLoginFacts): string[] {
  const out = roleProblems(f.login, `the runtime login ${f.login.name}`);
  if (f.inheritedAppRoles.length)
    out.push(
      `the runtime login inherits the app role(s) ${f.inheritedAppRoles.join(', ')} (membership must be INHERIT FALSE)`,
    );
  if (f.bareTablePrivileges.length)
    out.push(
      `the runtime login holds privileges as itself on ${f.bareTablePrivileges.slice(0, 3).join(', ')}`,
    );
  for (const r of f.appRoles) {
    const isOwner = r.name.endsWith('_o');
    if (isOwner) {
      // The owner role owns tables and creates in its schema; the rest is the same rule.
      const probs = roleProblems(
        { ...r, ownedTables: [], createOnSchemas: [] },
        `the owner role ${r.name}`,
      );
      out.push(...probs);
    } else out.push(...roleProblems(r, `the app role ${r.name}`));
  }
  return out;
}

/** Anything with `query(sql)` that runs as the login being checked. */
export interface LoginQuery {
  query(sql: string): Promise<{ rows: any[] }>;
}

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** Read the facts as the connected login, for the app schemas `schemas`. */
export async function gatherRuntimeLoginFacts(
  db: LoginQuery,
  schemas: string[],
): Promise<RuntimeLoginFacts> {
  const checked = schemas.map(assertSchemaName);
  const roleNames = checked.flatMap((s) => {
    const r = appRoles(s);
    return [r.app, r.owner];
  });
  // An empty list is `('')`: no schema or role has an empty name.
  const schemaList = checked.length ? checked.map(lit).join(', ') : "''";
  const roleList = roleNames.length ? roleNames.map(lit).join(', ') : "''";
  const q = async (sql: string) => (await db.query(sql)).rows;

  const roleFacts = async (who: string): Promise<RoleFacts[]> => {
    // `who` is `current_user` (a keyword) or a literal list of names.
    const filter =
      who === 'current_user'
        ? 'r.rolname = current_user'
        : `r.rolname IN (${roleList})`;
    const rows = await q(
      `SELECT r.rolname AS name, r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb,
        coalesce((SELECT json_agg(n.nspname || '.' || c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                   WHERE n.nspname IN (${schemaList}) AND c.relkind IN ('r','p') AND c.relowner = r.oid), '[]'::json) AS owned,
        coalesce((SELECT json_agg(n.nspname) FROM pg_namespace n
                   WHERE n.nspname IN (${schemaList}) AND has_schema_privilege(r.oid, n.oid, 'CREATE')), '[]'::json) AS create_on,
        has_database_privilege(r.oid, current_database(), 'CREATE') AS db_create,
        has_database_privilege(r.oid, current_database(), 'TEMP') AS db_temp
       FROM pg_roles r WHERE ${filter} ORDER BY r.rolname`,
    );
    const list = (v: unknown): string[] =>
      (typeof v === 'string' ? JSON.parse(v) : v) as string[];
    return rows.map((r) => ({
      name: String(r.name),
      superuser: r.rolsuper === true,
      bypassRls: r.rolbypassrls === true,
      createRole: r.rolcreaterole === true,
      createDb: r.rolcreatedb === true,
      ownedTables: list(r.owned),
      createOnSchemas: list(r.create_on),
      databaseCreate: r.db_create === true,
      databaseTemp: r.db_temp === true,
    }));
  };

  const [login] = await roleFacts('current_user');
  if (!login)
    throw new EngineError('the runtime login is not in the catalog', 'refused');
  const inherited = await q(
    `SELECT r.rolname AS name FROM pg_roles r WHERE r.rolname IN (${roleList}) AND pg_has_role(current_user, r.oid, 'USAGE')`,
  );
  const bare = await q(
    `SELECT n.nspname || '.' || c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname IN (${schemaList}) AND c.relkind IN ('r','p')
        AND has_table_privilege(current_user, c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
      ORDER BY 1`,
  );
  return {
    login,
    inheritedAppRoles: inherited.map((r) => String(r.name)),
    bareTablePrivileges: bare.map((r) => String(r.name)),
    appRoles: roleNames.length ? await roleFacts('roles') : [],
  };
}

/**
 * Refuse (an `EngineError`, naming every problem) unless the connected login is
 * unprivileged and the app roles of `schemas` are what `provisionAppRoles`
 * makes them. Run as the runtime login, at startup and after provisioning.
 */
export async function assertRuntimeLogin(
  db: LoginQuery,
  schemas: string[],
): Promise<void> {
  const problems = runtimeLoginProblems(
    await gatherRuntimeLoginFacts(db, schemas),
  );
  if (problems.length)
    throw new EngineError(
      `refusing to run apps on this database login: ${problems.join('; ')}`,
      'refused',
    );
}
