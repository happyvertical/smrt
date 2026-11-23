// The two app roles and the runtime login's membership (#5188), on PGlite.
// What needs a real non-superuser login lives in broker-roles.postgres.test.ts.

import { importPGlite } from '@happyvertical/sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  appRoles,
  assertAppRoles,
  assertRoleName,
  provisionAppRoles,
  provisionAppRolesSql,
} from './db/roles.ts';
import type { PGliteClient } from './db/types.ts';

let db: PGliteClient;
const rows = async (sql: string, params: unknown[] = []) =>
  (await db.query(sql, params)).rows as Array<Record<string, any>>;

beforeAll(async () => {
  const { PGlite } = await importPGlite();
  db = (await PGlite.create()) as PGliteClient;
  await db.exec(`CREATE ROLE rtlogin LOGIN`);
  for (const s of ['app_one', 'app_two']) {
    await db.exec(`CREATE SCHEMA "${s}"`);
    await db.exec(`CREATE TABLE "${s}"._app_meta (key text, value text)`);
  }
  await provisionAppRoles(db, 'app_one', 'rtlogin');
  await provisionAppRoles(db, 'app_two', 'rtlogin');
});
afterAll(async () => {
  await db.close();
});

describe('role names', () => {
  it('derives <schema>_r and <schema>_o and refuses anything else', () => {
    expect(appRoles('app_one')).toEqual({
      app: 'app_one_r',
      owner: 'app_one_o',
    });
    expect(() => assertRoleName('x"; DROP ROLE y; --')).toThrow(/role name/);
    expect(() => assertAppRoles({ app: 'a', owner: 'a' })).toThrow(/differ/);
    expect(() =>
      provisionAppRolesSql('app_one', 'bad login', 17, 'db'),
    ).toThrow();
  });

  it('uses NOINHERIT on the login before PostgreSQL 16', () => {
    const old = provisionAppRolesSql('app_one', 'rtlogin', 15, 'db');
    expect(old.some((s) => s.includes('ALTER ROLE "rtlogin" NOINHERIT'))).toBe(
      true,
    );
    const now = provisionAppRolesSql('app_one', 'rtlogin', 17, 'db');
    expect(now.some((s) => s.includes('WITH INHERIT FALSE, SET TRUE'))).toBe(
      true,
    );
  });
});

describe('provisioning', () => {
  it('creates NOLOGIN roles, joins the login WITH INHERIT FALSE, and is idempotent', async () => {
    await provisionAppRoles(db, 'app_one', 'rtlogin');
    const roles = await rows(
      `SELECT rolname, rolcanlogin, rolsuper, rolbypassrls FROM pg_roles WHERE rolname IN ('app_one_r','app_one_o') ORDER BY 1`,
    );
    expect(roles).toEqual([
      {
        rolname: 'app_one_o',
        rolcanlogin: false,
        rolsuper: false,
        rolbypassrls: false,
      },
      {
        rolname: 'app_one_r',
        rolcanlogin: false,
        rolsuper: false,
        rolbypassrls: false,
      },
    ]);
    const members = await rows(
      `SELECT r.rolname AS role, m.inherit_option, m.set_option
         FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid
         JOIN pg_roles u ON u.oid = m.member
        WHERE u.rolname = 'rtlogin' AND r.rolname LIKE 'app_one_%' ORDER BY 1`,
    );
    expect(members).toEqual([
      { role: 'app_one_o', inherit_option: false, set_option: true },
      { role: 'app_one_r', inherit_option: false, set_option: true },
    ]);
  });

  it('TEMP is revoked from PUBLIC, so neither role can make a temp table', async () => {
    expect(
      (
        await rows(
          `SELECT has_database_privilege('app_one_r', current_database(), 'TEMP') AS r,
                  has_database_privilege('app_one_o', current_database(), 'TEMP') AS o`,
        )
      )[0],
    ).toEqual({ r: false, o: false });
  });

  it('the runtime role reads and writes the schema, creates nothing, and cannot reach another app', async () => {
    await db.transaction(async (tx: any) => {
      await tx.exec(`SET LOCAL ROLE "app_one_o"`);
      await tx.exec(`CREATE TABLE "app_one".item (id int, label text)`);
    });
    await db.transaction(async (tx: any) => {
      await tx.exec(`SET LOCAL ROLE "app_one_r"`);
      await tx.query(`INSERT INTO "app_one".item VALUES (1, 'x')`);
      expect(
        (await tx.query(`SELECT * FROM "app_one".item`)).rows,
      ).toHaveLength(1);
    });
    const denied = async (role: string, sql: string) => {
      let code: string | undefined;
      await db
        .transaction(async (tx: any) => {
          await tx.exec(`SET LOCAL ROLE "${role}"`);
          await tx.query(sql);
        })
        .catch((e: { code?: string }) => {
          code = e.code;
        });
      return code;
    };
    expect(
      await denied('app_one_r', `CREATE TABLE "app_one".sneak (x int)`),
    ).toBe('42501');
    expect(await denied('app_one_r', `SELECT * FROM "app_two"._app_meta`)).toBe(
      '42501',
    );
    expect(await denied('app_one_o', `SELECT * FROM "app_two"._app_meta`)).toBe(
      '42501',
    );
    expect(await denied('app_one_r', `CREATE TEMP TABLE t (x int)`)).toBe(
      '42501',
    );
  });
});

describe('split credentials: the owner role goes to the admin, never the runtime login', () => {
  it('writes REVOKE for the login and an inheriting GRANT for the admin (16+), a plain one before', () => {
    const modern = provisionAppRolesSql(
      'app_one',
      'rtlogin',
      17,
      'db',
      undefined,
      {
        ownerLogin: 'svc_admin',
      },
    );
    expect(modern).toContain('REVOKE "app_one_o" FROM "rtlogin"');
    expect(modern).toContain(
      'GRANT "app_one_o" TO "svc_admin" WITH INHERIT TRUE, SET TRUE',
    );
    expect(
      modern.some((s) => s.startsWith('GRANT "app_one_o" TO "rtlogin"')),
    ).toBe(false);
    // the runtime role still joins the login without inheriting
    expect(modern).toContain(
      'GRANT "app_one_r" TO "rtlogin" WITH INHERIT FALSE, SET TRUE',
    );
    const old = provisionAppRolesSql(
      'app_one',
      'rtlogin',
      15,
      'db',
      undefined,
      {
        ownerLogin: 'svc_admin',
      },
    );
    expect(old).toContain('GRANT "app_one_o" TO "svc_admin"');
    expect(() =>
      provisionAppRolesSql('app_one', 'rtlogin', 17, 'db', undefined, {
        ownerLogin: 'bad name',
      }),
    ).toThrow(/role name/);
  });

  it('on a catalog: the admin reads what the owner role owns, the runtime login cannot even switch to it', async () => {
    await db.exec(`CREATE ROLE svc_admin LOGIN`);
    await db.exec(`CREATE SCHEMA "app_split"`);
    await db.exec(`CREATE TABLE "app_split"._app_meta (key text, value text)`);
    // An earlier single-login provisioning gave the runtime login the owner role.
    await provisionAppRoles(db, 'app_split', 'rtlogin');
    await provisionAppRoles(db, 'app_split', 'rtlogin', undefined, {
      ownerLogin: 'svc_admin',
    });
    const member = async (who: string, role: string) =>
      (
        await rows(
          `SELECT m.inherit_option, m.set_option FROM pg_auth_members m
             JOIN pg_roles r ON r.oid = m.roleid JOIN pg_roles u ON u.oid = m.member
            WHERE u.rolname = '${who}' AND r.rolname = '${role}'`,
        )
      )[0];
    expect(await member('rtlogin', 'app_split_o')).toBeUndefined();
    expect(await member('rtlogin', 'app_split_r')).toEqual({
      inherit_option: false,
      set_option: true,
    });
    expect(await member('svc_admin', 'app_split_o')).toEqual({
      inherit_option: true,
      set_option: true,
    });
    // What the owner role owns is readable by the admin (inherited) and not by the login.
    await db.exec(`CREATE TABLE "app_split".item (id int)`);
    await db.exec(`ALTER TABLE "app_split".item OWNER TO app_split_o`);
    const can = async (who: string) =>
      (
        await rows(
          `SELECT has_table_privilege('${who}', 'app_split.item', 'SELECT') AS ok`,
        )
      )[0].ok;
    expect(await can('svc_admin')).toBe(true);
    expect(await can('rtlogin')).toBe(false);
  });

  it('a non-superuser admin that owns the tables moves them to the owner role, side schemas included', async () => {
    // The admin is no superuser: it may ALTER ... OWNER TO a role only when it
    // is a member of that role and the role holds CREATE on the schema.
    await db.exec(`CREATE ROLE svc_dba LOGIN CREATEROLE`);
    await db.exec(`GRANT CREATE ON DATABASE postgres TO svc_dba`);
    await db.exec(`SET ROLE svc_dba`);
    try {
      await db.exec(`CREATE SCHEMA "app_existing"`);
      await db.exec(
        `CREATE TABLE "app_existing"._app_meta (key text, value text)`,
      );
      await db.exec(
        `CREATE TABLE "app_existing".item (id serial PRIMARY KEY, label text)`,
      );
      await db.exec(`CREATE SEQUENCE "app_existing".free_seq`);
      await db.exec(
        `CREATE VIEW "app_existing".item_v AS SELECT id FROM "app_existing".item`,
      );
      await db.exec(`CREATE SCHEMA "app_existing__d0123456789abcdef"`);
      await db.exec(
        `COMMENT ON SCHEMA "app_existing__d0123456789abcdef" IS 'smrt-side:app_existing'`,
      );
      await db.exec(
        `CREATE TABLE "app_existing__d0123456789abcdef".item (id int)`,
      );
      expect(
        (
          await rows(
            `SELECT rolsuper FROM pg_roles WHERE rolname = current_user`,
          )
        )[0].rolsuper,
      ).toBe(false);
      await provisionAppRoles(db, 'app_existing', 'rtlogin', undefined, {
        ownerLogin: 'svc_dba',
      });
    } finally {
      await db.exec(`RESET ROLE`);
    }
    const owners = await rows(
      `SELECT n.nspname, c.relname, pg_get_userbyid(c.relowner) AS owner FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname LIKE 'app_existing%' AND c.relkind IN ('r', 'v', 'S')`,
    );
    expect(owners.length).toBeGreaterThanOrEqual(6);
    for (const o of owners) expect(o.owner).toBe('app_existing_o');
    // Boot and migrations run as the owner role: it can now ALTER what was there.
    await db.transaction(async (tx: any) => {
      await tx.exec(`SET LOCAL ROLE "app_existing_o"`);
      await tx.exec(`ALTER TABLE "app_existing".item ADD COLUMN extra text`);
      await tx.exec(`ALTER SEQUENCE "app_existing".free_seq RESTART 5`);
    });
    // Idempotent, run as the same non-superuser admin.
    await db.exec(`SET ROLE svc_dba`);
    try {
      await provisionAppRoles(db, 'app_existing', 'rtlogin', undefined, {
        ownerLogin: 'svc_dba',
      });
    } finally {
      await db.exec(`RESET ROLE`);
    }
  });

  it('a CREATEROLE admin that made the roles itself provisions the single-login profile (#5188)', async () => {
    // PostgreSQL 16+: a non-superuser CREATEROLE role holds only ADMIN OPTION
    // on the roles it creates, with neither SET nor INHERIT, and ALTER DEFAULT
    // PRIVILEGES FOR ROLE needs INHERIT ("permission denied to change default
    // privileges"). Provisioning must grant the admin both on the owner role.
    await db.exec(`CREATE ROLE svc_single LOGIN CREATEROLE`);
    await db.exec(`GRANT CREATE ON DATABASE postgres TO svc_single`);
    await db.exec(`SET ROLE svc_single`);
    try {
      await db.exec(`CREATE SCHEMA "app_single"`);
      await db.exec(
        `CREATE TABLE "app_single"._app_meta (key text, value text)`,
      );
      await provisionAppRoles(db, 'app_single', 'rtlogin');
      await provisionAppRoles(db, 'app_single', 'rtlogin'); // idempotent
    } finally {
      await db.exec(`RESET ROLE`);
    }
    const m = await rows(
      `SELECT set_option, inherit_option FROM pg_auth_members
        WHERE roleid = 'app_single_o'::regrole AND member = 'svc_single'::regrole`,
    );
    expect(m.some((r) => r.set_option === true)).toBe(true);
    expect(m.some((r) => r.inherit_option === true)).toBe(true);
  });
});
