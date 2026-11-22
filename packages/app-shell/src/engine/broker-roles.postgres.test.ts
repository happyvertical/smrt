// What only a real PostgreSQL server shows about the runtime login and the app
// roles (#5188): the `test:postgres` lane, gated on SMRT_TEST_POSTGRES_URL
// exactly like postgres-server.test.ts (set by CI's "Registered PostgreSQL
// Suites" lane; skipped everywhere else, never started by a test). The URL
// must be a role that may create roles and databases' schemas.

import { getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appRoles, provisionAppRoles } from './db/roles.ts';
import { sqlstate } from './pg-test-support.ts';

const serverUrl = process.env.SMRT_TEST_POSTGRES_URL;

describe.skipIf(!serverUrl)('app roles on a PostgreSQL server', () => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const schemaA = `app_rl_a_${suffix}`;
  const schemaB = `app_rl_b_${suffix}`;
  const login = `rt_login_${suffix}`;
  const password = `pw_${suffix}`;
  let admin: any;
  let bare: any;

  beforeAll(async () => {
    admin = await getDatabase({
      type: 'postgres',
      url: serverUrl,
      max: 1,
      cache: false,
      // A plain connection: the vitest setup would otherwise sync every SMRT table into `public`.
      __smrtSkipVitestSchemaPreparation: true,
    } as any);
    await admin.query(
      `CREATE ROLE "${login}" LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB`,
    );
    for (const s of [schemaA, schemaB]) {
      await admin.query(`CREATE SCHEMA "${s}"`);
      await admin.query(`CREATE TABLE "${s}"._app_meta (key text, value text)`);
      await provisionAppRoles(admin, s, login);
    }
    const url = new URL(serverUrl as string);
    url.username = login;
    url.password = password;
    bare = await getDatabase({
      type: 'postgres',
      url: url.toString(),
      max: 1,
      cache: false,
      // A plain connection: the vitest setup would otherwise sync every SMRT table into `public`.
      __smrtSkipVitestSchemaPreparation: true,
    } as any);
  });
  afterAll(async () => {
    await bare?.close?.();
    for (const s of [schemaA, schemaB])
      await admin.query(`DROP SCHEMA IF EXISTS "${s}" CASCADE`);
    for (const s of [schemaA, schemaB]) {
      const r = appRoles(s);
      await admin.query(`DROP ROLE IF EXISTS "${r.app}"`);
      await admin.query(`DROP ROLE IF EXISTS "${r.owner}"`);
    }
    await admin.query(`DROP ROLE IF EXISTS "${login}"`);
    await admin.close?.();
  });

  const code = sqlstate;

  it('the bare login holds no privilege on any app schema (42501)', async () => {
    expect(
      await code(() => bare.query(`SELECT * FROM "${schemaA}"._app_meta`)),
    ).toBe('42501');
    expect(
      await code(() => bare.query(`SELECT * FROM "${schemaB}"._app_meta`)),
    ).toBe('42501');
  });

  it("role A gets 42501 on app B's tables, and the login can switch only with SET LOCAL ROLE", async () => {
    const asRole = (role: string, sql: string) =>
      code(() =>
        bare.transaction(async (tx: any) => {
          await tx.query(`SET LOCAL ROLE "${role}"`);
          await tx.query(sql);
        }),
      );
    const a = appRoles(schemaA);
    expect(await asRole(a.app, `SELECT * FROM "${schemaA}"._app_meta`)).toBe(
      undefined,
    );
    expect(await asRole(a.app, `SELECT * FROM "${schemaB}"._app_meta`)).toBe(
      '42501',
    );
    expect(await asRole(a.owner, `SELECT * FROM "${schemaB}"._app_meta`)).toBe(
      '42501',
    );
  });

  it('the runtime login is not privileged', async () => {
    const [row] = (
      await admin.query(
        `SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = '${login}'`,
      )
    ).rows;
    expect(row).toEqual({
      rolsuper: false,
      rolbypassrls: false,
      rolcreaterole: false,
      rolcreatedb: false,
    });
    expect(
      (
        await admin.query(
          `SELECT has_database_privilege('${login}', current_database(), 'TEMP') AS t`,
        )
      ).rows[0].t,
    ).toBe(false);
    // no inherited app privilege: every membership is INHERIT FALSE (16+) or the login is NOINHERIT
    const inherited = (
      await admin.query(
        `SELECT count(*)::int AS n FROM pg_auth_members m
           JOIN pg_roles u ON u.oid = m.member
          WHERE u.rolname = '${login}' AND u.rolinherit AND coalesce(
            (SELECT bool_or(inherit_option) FROM pg_auth_members x WHERE x.oid = m.oid), true)`,
      )
    ).rows[0].n;
    expect(inherited).toBe(0);
  });
});
