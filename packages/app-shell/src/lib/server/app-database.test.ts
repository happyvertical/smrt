// The cloud profile's app database provider and its two credential sets
// (#5188). Provisioning runs on a PGlite catalog (roles and privileges are
// real there); the runtime login is assumed with SET ROLE, which is also what
// shows the startup check refusing a login that is too powerful. Real logins on
// a server: runtime-login.postgres.test.ts.

import { importPGlite } from '@happyvertical/sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGliteClient } from '../../engine/db/index.ts';
import { cloudAppDatabase, loginOf } from './app-database.ts';

const SCHEMA = `app_${'a'.repeat(32)}`;
const URL_ADMIN = 'postgres://svc_admin:pw@db.example/apps';
const URL_RUNTIME = 'postgres://app_runtime:pw%40x@db.example/apps';

describe('the provider', () => {
  const admin = async () => ({ query: async () => ({ rows: [] }) });

  it('single-owner without a runtime login: one connection, no roles, no admin', () => {
    const p = cloudAppDatabase({ url: URL_ADMIN, admin, warn: () => {} });
    expect(p.config(SCHEMA)).toEqual({
      kind: 'postgres',
      schema: SCHEMA,
      connection: { url: URL_ADMIN, max: 2 },
    });
  });

  it('warns once at startup, loudly, when there is no split credential', () => {
    const warnings: Array<Record<string, unknown>> = [];
    const warn = (e: Record<string, unknown>) => warnings.push(e);
    cloudAppDatabase({ url: URL_ADMIN, admin, warn });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      level: 'warn',
      event: 'app-shell.database.no-role-isolation',
      env: 'SMRT_APP_SHELL_RUNTIME_DATABASE_URL',
    });
    expect(String(warnings[0].message)).toContain(
      'no database-level role isolation: set SMRT_APP_SHELL_RUNTIME_DATABASE_URL',
    );
    // the same URL twice is no split either
    cloudAppDatabase({ url: URL_ADMIN, runtimeUrl: URL_ADMIN, admin, warn });
    expect(warnings).toHaveLength(2);
    // a real split is quiet
    cloudAppDatabase({ url: URL_ADMIN, runtimeUrl: URL_RUNTIME, admin, warn });
    expect(warnings).toHaveLength(2);
  });

  it('a runtime login splits the credentials and names the app roles', () => {
    const p = cloudAppDatabase({
      url: URL_ADMIN,
      runtimeUrl: URL_RUNTIME,
      admin,
    });
    expect(p.config(SCHEMA)).toEqual({
      kind: 'postgres',
      schema: SCHEMA,
      connection: { url: URL_RUNTIME, max: 2 },
      admin: { url: URL_ADMIN, max: 2 },
      roles: { app: `${SCHEMA}_r`, owner: `${SCHEMA}_o` },
    });
    // the same URL twice is no split
    expect(
      cloudAppDatabase({ url: URL_ADMIN, runtimeUrl: URL_ADMIN, admin }).config(
        SCHEMA,
      ),
    ).not.toHaveProperty('roles');
  });

  it('reads the login out of a URL, decoded', () => {
    expect(loginOf(URL_RUNTIME)).toBe('app_runtime');
    expect(loginOf('postgres://a%2Fb@h/d')).toBe('a/b');
    expect(() => loginOf('postgres://h/d')).toThrow(/no login/);
  });

  it('refuses a schema name that is not an app schema before any statement', async () => {
    const seen: string[] = [];
    const p = cloudAppDatabase({
      url: URL_ADMIN,
      admin: async () => ({
        query: async (sql) => {
          seen.push(sql);
          return { rows: [] };
        },
      }),
    });
    await expect(p.provision('app_x"; DROP SCHEMA public; --')).rejects.toThrow(
      /not an app schema name/,
    );
    expect(seen).toEqual([]);
  });
});

describe('provisioning on a catalog', () => {
  let db: PGliteClient;
  beforeAll(async () => {
    const { PGlite } = await importPGlite();
    db = (await PGlite.create()) as PGliteClient;
    await db.exec(`CREATE ROLE app_runtime LOGIN NOSUPERUSER NOBYPASSRLS`);
  });
  afterAll(async () => {
    await db.close();
  });
  const adminOn = async () => ({
    query: async (sql: string) => db.query(sql),
  });
  /** Assume `who` for the check, as a connection of that login would be. */
  const as =
    (who: string) =>
    async (
      _url: string,
      check: (c: {
        query(sql: string): Promise<{ rows: any[] }>;
      }) => Promise<void>,
    ) => {
      await db.exec(who ? `SET ROLE "${who}"` : 'RESET ROLE');
      try {
        await check({ query: (sql) => db.query(sql) });
      } finally {
        await db.exec('RESET ROLE');
      }
    };

  it('creates the schema and both roles, and the runtime login passes the check', async () => {
    const p = cloudAppDatabase({
      url: URL_ADMIN,
      runtimeUrl: URL_RUNTIME,
      admin: adminOn,
      asRuntime: as('app_runtime'),
    });
    await p.provision(SCHEMA);
    await p.provision(SCHEMA); // idempotent
    const r = (
      await db.query(
        `SELECT rolname FROM pg_roles WHERE rolname LIKE '${SCHEMA}%' ORDER BY 1`,
      )
    ).rows.map((x: any) => x.rolname);
    expect(r).toEqual([`${SCHEMA}_o`, `${SCHEMA}_r`]);
    // the owner role went to the admin (current_user here), not to the runtime login
    const owners = (
      await db.query(
        `SELECT u.rolname AS member FROM pg_auth_members m
           JOIN pg_roles r ON r.oid = m.roleid JOIN pg_roles u ON u.oid = m.member
          WHERE r.rolname = '${SCHEMA}_o'`,
      )
    ).rows.map((x: any) => x.member);
    expect(owners).not.toContain('app_runtime');
  });

  it('refuses to start the app when the runtime login is a superuser', async () => {
    const p = cloudAppDatabase({
      url: URL_ADMIN,
      runtimeUrl: URL_RUNTIME,
      admin: adminOn,
      asRuntime: as(''), // the default PGlite role is a superuser
    });
    await expect(p.provision(SCHEMA)).rejects.toThrow(
      /refusing to run apps on this database login: .*superuser/,
    );
  });

  it('single-owner provisioning only creates the schema', async () => {
    const other = `app_${'b'.repeat(32)}`;
    const p = cloudAppDatabase({ url: URL_ADMIN, admin: adminOn });
    await p.provision(other);
    const r = (
      await db.query(
        `SELECT rolname FROM pg_roles WHERE rolname LIKE '${other}%'`,
      )
    ).rows;
    expect(r).toEqual([]);
    expect(
      (await db.query(`SELECT 1 FROM pg_namespace WHERE nspname = '${other}'`))
        .rows,
    ).toHaveLength(1);
  });
});
