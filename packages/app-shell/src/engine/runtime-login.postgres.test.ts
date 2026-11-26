// The startup check on the runtime login, with real logins on a server (#5188):
// the `test:postgres` lane, gated on SMRT_TEST_POSTGRES_URL like
// broker-roles.postgres.test.ts. An ordinary login passes; each way of being
// too powerful is refused, by the catalog the server really keeps (PGlite is
// one superuser and cannot show that).
//
// Attributes only a superuser may give (SUPERUSER, BYPASSRLS) are made through
// SMRT_TEST_POSTGRES_ADMIN_URL when the lane exports one (it does: the suites'
// own role is deliberately not a superuser there), and skipped otherwise.

import { getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appRoles, provisionAppRoles } from './db/roles.ts';
import { assertRuntimeLogin } from './db/runtime-login.ts';
import { EngineError } from './errors.ts';
import { urlAs } from './pg-test-support.ts';

const serverUrl = process.env.SMRT_TEST_POSTGRES_URL;
const superUrl = process.env.SMRT_TEST_POSTGRES_ADMIN_URL ?? serverUrl;

describe.skipIf(!serverUrl)('runtime login startup check on a server', () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const schema = `app_rl_${suffix}`;
  const roles = appRoles(schema);
  const password = `pw_${suffix}`;
  const made: string[] = [];
  const handles: any[] = [];
  let admin: any; // the suites' role: owns the schema and database objects
  let superuser: any; // may forge superuser-only attributes
  let isSuper = false;
  let adminLogin = '';
  let dbName = '';
  let serverMajor = 0;

  /** A login named `label`, provisioned for the schema, with `attrs`. */
  const mkLogin = async (label: string, attrs = '', via = admin) => {
    const name = `rl_${label}_${suffix}`;
    // A retried test finds the role a failed attempt left behind.
    await via.query(`DROP ROLE IF EXISTS "${name}"`).catch(() => {});
    await via.query(
      `CREATE ROLE "${name}" LOGIN PASSWORD '${password}' ${attrs || 'NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB'}`,
    );
    made.push(name);
    await provisionAppRoles(admin, schema, name, undefined, {
      ownerLogin: adminLogin,
    });
    return name;
  };
  const check = async (name: string) => {
    const h: any = await getDatabase({
      type: 'postgres',
      url: urlAs(serverUrl as string, name, password),
      max: 1,
      cache: false,
      // A plain connection: the vitest setup would otherwise sync every SMRT table into `public`.
      __smrtSkipVitestSchemaPreparation: true,
    } as any);
    handles.push(h);
    try {
      await assertRuntimeLogin({ query: (sql) => h.query(sql) }, [schema]);
    } finally {
      await h.close?.();
      handles.splice(handles.indexOf(h), 1);
    }
  };
  const refused = async (name: string, re: RegExp) => {
    const err = await check(name).catch((e) => e);
    expect(err).toBeInstanceOf(EngineError);
    expect((err as Error).message).toMatch(re);
  };

  beforeAll(async () => {
    admin = await getDatabase({
      type: 'postgres',
      url: serverUrl,
      max: 1,
      cache: false,
      // A plain connection: the vitest setup would otherwise sync every SMRT table into `public`.
      __smrtSkipVitestSchemaPreparation: true,
    } as any);
    adminLogin = (await admin.query('SELECT current_user AS u')).rows[0].u;
    dbName = (await admin.query('SELECT current_database() AS d')).rows[0].d;
    serverMajor = Math.floor(
      Number(
        (await admin.query(`SELECT current_setting('server_version_num') AS v`))
          .rows[0].v,
      ) / 10000,
    );
    superuser =
      superUrl === serverUrl
        ? admin
        : await getDatabase({
            type: 'postgres',
            url: superUrl,
            max: 1,
            cache: false,
            // A plain connection: the vitest setup would otherwise sync every SMRT table into `public`.
            __smrtSkipVitestSchemaPreparation: true,
          } as any);
    isSuper =
      (
        await superuser.query(
          'SELECT rolsuper FROM pg_roles WHERE rolname = current_user',
        )
      ).rows[0].rolsuper === true;
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(
      `CREATE TABLE "${schema}"._app_meta (key text, value text)`,
    );
    await admin.query(`CREATE TABLE "${schema}".item (id int)`);
  });
  afterAll(async () => {
    for (const h of handles) await h.close?.().catch(() => {});
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    for (const r of [roles.app, roles.owner, ...made])
      await (isSuper ? superuser : admin)
        .query(`DROP ROLE IF EXISTS "${r}"`)
        .catch(() => {});
    if (superuser !== admin) await superuser.close?.();
    await admin.close?.();
  });

  it('accepts an ordinary login provisioned the way the host does it', async () => {
    await check(await mkLogin('ok'));
  });

  it('refuses CREATEROLE and CREATEDB', async () => {
    const r = await mkLogin('crole', 'NOSUPERUSER CREATEROLE').catch(
      () => null,
    );
    if (r) await refused(r, /CREATEROLE/);
    const d = await mkLogin('cdb', 'NOSUPERUSER CREATEDB').catch(() => null);
    if (d) await refused(d, /CREATEDB/);
    // The suites' role may be unable to hand those attributes out: then there is nothing to show.
    if (!r && !d) return;
  });

  it('refuses a superuser and BYPASSRLS login', async () => {
    if (!isSuper) return; // the lane's admin URL is not a superuser here
    await refused(await mkLogin('su', 'SUPERUSER', superuser), /superuser/);
    await refused(
      await mkLogin('byp', 'NOSUPERUSER BYPASSRLS', superuser),
      /BYPASSRLS/,
    );
  });

  it('refuses a login that owns an app table or may create in the schema', async () => {
    const owner = await mkLogin('own');
    // ALTER ... OWNER TO needs SET on the new owner; a role the admin created
    // gives it ADMIN only (16+).
    await admin.query(
      serverMajor >= 16
        ? `GRANT "${owner}" TO "${adminLogin}" WITH SET TRUE, INHERIT FALSE`
        : `GRANT "${owner}" TO "${adminLogin}"`,
    );
    // ... and the new owner needs CREATE on the table's schema, only for the move.
    await admin.query(`GRANT CREATE ON SCHEMA "${schema}" TO "${owner}"`);
    await admin.query(
      `CREATE TABLE "${schema}".mine (id int); ALTER TABLE "${schema}".mine OWNER TO "${owner}"`,
    );
    await admin.query(`REVOKE CREATE ON SCHEMA "${schema}" FROM "${owner}"`);
    await refused(owner, /owns tables \(.*mine\)/);
    await admin.query(`DROP TABLE "${schema}".mine`);
    const maker = await mkLogin('mk');
    await admin.query(`GRANT CREATE ON SCHEMA "${schema}" TO "${maker}"`);
    await refused(maker, new RegExp(`CREATE on schema ${schema}`));
  });

  it('refuses TEMP or CREATE on the database', async () => {
    const t = await mkLogin('tmp');
    await admin.query(`GRANT TEMP ON DATABASE "${dbName}" TO "${t}"`);
    await refused(t, /TEMP on the database/);
    const c = await mkLogin('cdbp');
    await admin.query(`GRANT CREATE ON DATABASE "${dbName}" TO "${c}"`);
    await refused(c, /CREATE on the database/);
  });

  it('refuses a login that holds a table privilege as itself', async () => {
    const n = await mkLogin('bare');
    await admin.query(`GRANT SELECT ON "${schema}".item TO "${n}"`);
    await refused(n, /privileges as itself on .*item/);
  });

  it('refuses a login that inherits an app role', async () => {
    const n = await mkLogin('inh');
    if (serverMajor >= 16)
      await admin.query(
        `GRANT "${roles.app}" TO "${n}" WITH INHERIT TRUE, SET TRUE`,
      );
    else await admin.query(`ALTER ROLE "${n}" INHERIT`);
    await refused(n, /inherits the app role/);
  });
});
