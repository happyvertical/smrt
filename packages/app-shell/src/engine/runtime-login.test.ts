// The startup check on the runtime login (#5188): the pure rules over stubbed
// catalog rows, and the same check against a PGlite catalog (roles and
// privileges are real there; the login is assumed with SET ROLE). The server's
// own refusals with real logins are in runtime-login.postgres.test.ts.

import { importPGlite } from '@happyvertical/sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appRoles, provisionAppRoles } from './db/roles.ts';
import {
  assertRuntimeLogin,
  type RuntimeLoginFacts,
  runtimeLoginProblems,
} from './db/runtime-login.ts';
import type { PGliteClient } from './db/types.ts';
import { EngineError } from './errors.ts';

const role = (name: string, over: Record<string, unknown> = {}) => ({
  name,
  superuser: false,
  bypassRls: false,
  createRole: false,
  createDb: false,
  ownedTables: [],
  createOnSchemas: [],
  databaseCreate: false,
  databaseTemp: false,
  ...over,
});
const clean = (): RuntimeLoginFacts => ({
  login: role('rt'),
  inheritedAppRoles: [],
  bareTablePrivileges: [],
  appRoles: [role('app_x_o'), role('app_x_r')],
});

describe('runtimeLoginProblems (stubbed catalog rows)', () => {
  it('passes an unprivileged login', () => {
    expect(runtimeLoginProblems(clean())).toEqual([]);
  });

  it.each([
    ['superuser', { superuser: true }, /superuser/],
    ['BYPASSRLS', { bypassRls: true }, /BYPASSRLS/],
    ['CREATEROLE', { createRole: true }, /CREATEROLE/],
    ['CREATEDB', { createDb: true }, /CREATEDB/],
    ['owning a table', { ownedTables: ['app_x.item'] }, /owns tables/],
    [
      'CREATE on a schema',
      { createOnSchemas: ['app_x'] },
      /CREATE on schema app_x/,
    ],
    [
      'CREATE on the database',
      { databaseCreate: true },
      /CREATE on the database/,
    ],
    ['TEMP on the database', { databaseTemp: true }, /TEMP on the database/],
  ] as const)('refuses a login with %s', (_n, over, re) => {
    const f = clean();
    f.login = role('rt', over);
    expect(runtimeLoginProblems(f).join(';')).toMatch(re);
  });

  it('refuses an inherited app role and a privilege held as the bare login', () => {
    const f = clean();
    f.inheritedAppRoles = ['app_x_r'];
    f.bareTablePrivileges = ['app_x.item'];
    const p = runtimeLoginProblems(f).join(';');
    expect(p).toMatch(/inherits the app role\(s\) app_x_r/);
    expect(p).toMatch(/privileges as itself on app_x\.item/);
  });

  it('checks the app roles too, the owner role keeping its own tables and schema', () => {
    const f = clean();
    f.appRoles = [
      role('app_x_o', {
        ownedTables: ['app_x.item'],
        createOnSchemas: ['app_x'],
      }),
      role('app_x_r', { createDb: true, databaseTemp: true }),
    ];
    const p = runtimeLoginProblems(f).join(';');
    expect(p).toMatch(/app role app_x_r has CREATEDB/);
    expect(p).toMatch(/app role app_x_r holds TEMP/);
    expect(p).not.toMatch(/owner role app_x_o owns/);
    f.appRoles[0] = role('app_x_o', { bypassRls: true });
    expect(runtimeLoginProblems(f).join(';')).toMatch(
      /owner role app_x_o has BYPASSRLS/,
    );
  });
});

describe('assertRuntimeLogin (a PGlite catalog)', () => {
  const SCHEMA = 'app_login';
  const { app, owner } = appRoles(SCHEMA);
  let db: PGliteClient;
  const asLogin = async (name = 'rt_login') => {
    await db.exec(`SET ROLE "${name}"`);
    try {
      await assertRuntimeLogin(db, [SCHEMA]);
    } finally {
      await db.exec('RESET ROLE');
    }
  };
  const refusal = async (sql: string, undo: string, re: RegExp) => {
    await db.exec(sql);
    try {
      const err = await asLogin().catch((e) => e);
      expect(err).toBeInstanceOf(EngineError);
      expect((err as Error).message).toMatch(re);
    } finally {
      await db.exec(undo);
    }
    await asLogin(); // and the undo left a fit login
  };

  beforeAll(async () => {
    const { PGlite } = await importPGlite();
    db = (await PGlite.create()) as PGliteClient;
    await db.exec(
      `CREATE ROLE rt_login LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB`,
    );
    await db.exec(`CREATE SCHEMA "${SCHEMA}"`);
    await db.exec(`CREATE TABLE "${SCHEMA}"._app_meta (key text, value text)`);
    await provisionAppRoles(db, SCHEMA, 'rt_login');
    await db.exec(`CREATE TABLE "${SCHEMA}".item (id int)`);
    await db.exec(
      `GRANT SELECT ON "${SCHEMA}".item TO "${app}"; ALTER TABLE "${SCHEMA}".item OWNER TO "${owner}"`,
    );
  });
  afterAll(async () => {
    await db.close();
  });

  it('accepts the login provisioning made', async () => {
    await asLogin();
  });

  it('refuses a superuser (the default PGlite role)', async () => {
    const err = await assertRuntimeLogin(db, [SCHEMA]).catch((e) => e);
    expect(err).toBeInstanceOf(EngineError);
    expect(err.message).toMatch(/superuser/);
  });

  it('refuses BYPASSRLS, CREATEROLE, CREATEDB', async () => {
    await refusal(
      'ALTER ROLE rt_login BYPASSRLS',
      'ALTER ROLE rt_login NOBYPASSRLS',
      /BYPASSRLS/,
    );
    await refusal(
      'ALTER ROLE rt_login CREATEROLE',
      'ALTER ROLE rt_login NOCREATEROLE',
      /CREATEROLE/,
    );
    await refusal(
      'ALTER ROLE rt_login CREATEDB',
      'ALTER ROLE rt_login NOCREATEDB',
      /CREATEDB/,
    );
  });

  it('refuses owning an app table, CREATE on an app schema, and CREATE or TEMP on the database', async () => {
    await refusal(
      `ALTER TABLE "${SCHEMA}".item OWNER TO rt_login`,
      `ALTER TABLE "${SCHEMA}".item OWNER TO "${owner}"`,
      /owns tables \(app_login\.item\)/,
    );
    await refusal(
      `GRANT CREATE ON SCHEMA "${SCHEMA}" TO rt_login`,
      `REVOKE CREATE ON SCHEMA "${SCHEMA}" FROM rt_login`,
      /CREATE on schema app_login/,
    );
    await refusal(
      `GRANT CREATE ON DATABASE postgres TO rt_login`,
      `REVOKE CREATE ON DATABASE postgres FROM rt_login`,
      /CREATE on the database/,
    );
    await refusal(
      `GRANT TEMP ON DATABASE postgres TO rt_login`,
      `REVOKE TEMP ON DATABASE postgres FROM rt_login`,
      /TEMP on the database/,
    );
  });

  it('refuses a login that inherits an app role, or holds a table privilege as itself', async () => {
    await refusal(
      `GRANT "${app}" TO rt_login WITH INHERIT TRUE`,
      `GRANT "${app}" TO rt_login WITH INHERIT FALSE`,
      /inherits the app role\(s\) app_login_r/,
    );
    await refusal(
      `GRANT SELECT ON "${SCHEMA}".item TO rt_login`,
      `REVOKE SELECT ON "${SCHEMA}".item FROM rt_login`,
      /privileges as itself on app_login\.item/,
    );
  });

  it('refuses an app role that is privileged', async () => {
    await refusal(
      `ALTER ROLE "${app}" BYPASSRLS`,
      `ALTER ROLE "${app}" NOBYPASSRLS`,
      /app role app_login_r has BYPASSRLS/,
    );
    await refusal(
      `GRANT TEMP ON DATABASE postgres TO "${app}"`,
      `REVOKE TEMP ON DATABASE postgres FROM "${app}"`,
      /app role app_login_r holds TEMP/,
    );
  });
});
