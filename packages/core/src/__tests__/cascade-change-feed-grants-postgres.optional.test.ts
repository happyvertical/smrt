/**
 * A delete cascade keeps working under column grants that were sufficient
 * before cascaded rows reached the change feed (#5444).
 *
 * The cascade returns each affected row's ownership columns only when the
 * role can read them (`has_column_privilege`). A role that may delete the
 * parent and null or delete its children, but not read a child's ownership
 * column, still deletes the parent; those children are left out of the feed
 * (never recorded as global). The migration owner, fully privileged, records
 * them under their owner.
 *
 * The fixture is the supported hardened deployment: a dedicated schema owned
 * by a migration owner that migrates everything (system tables with their
 * version stamp, bookkeeping, model tables), and a runtime role granted by
 * `planPostgresPermissions` / `applyPostgresPermissions`, minus SELECT on the
 * children's ownership column. The runtime role's own initialization then
 * takes the already-bootstrapped path and issues no DDL. It creates roles and
 * a database through the wrapper's superuser admin URL, so it runs only in the
 * disposable PostgreSQL shard (`pg-lane`).
 */
import { randomUUID } from 'node:crypto';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type ChangeFeedEntry,
  getChangesSince,
  registerChangeFeedWriter,
  resetChangeFeedWarnings,
} from '../change-feed';
import { resolveDatabase } from '../database';
import { foreignKey } from '../decorators/index';
import { MigrationTracker } from '../migrations/tracker';
import { SmrtObject } from '../object';
import {
  applyPostgresPermissions,
  type PostgresPermissionContract,
  planPostgresPermissions,
} from '../postgres-permissions';
import { ObjectRegistry, smrt } from '../registry';
import { getSystemTableShapes } from '../schema/system-table-shapes';
import { ensureSystemTables } from '../system/bootstrap';

const adminUrl =
  process.env.SMRT_TEST_POSTGRES_ADMIN_URL ??
  process.env.SMRT_TEST_POSTGRES_URL ??
  '';

function need<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('fixture not initialized');
  return value;
}
const pgDescribe = process.env.SMRT_TEST_POSTGRES_URL
  ? describe.sequential
  : describe.skip;

const DOCS = 'pg_cascade_grant_docs';
const PARTS = 'pg_cascade_grant_parts';
const REFS = 'pg_cascade_grant_refs';
const PASSWORD = 'smrt-test-password';

@smrt({ tableName: 'pg_cascade_grant_docs' })
class PgCascadeGrantDoc extends SmrtObject {
  title: string = '';
}

@smrt({ tableName: 'pg_cascade_grant_parts' })
class PgCascadeGrantPart extends SmrtObject {
  @foreignKey('PgCascadeGrantDoc', { onDelete: 'CASCADE' })
  docId: string = '';
  workspaceId: string = '';
}

@smrt({ tableName: 'pg_cascade_grant_refs' })
class PgCascadeGrantRef extends SmrtObject {
  @foreignKey('PgCascadeGrantDoc', { onDelete: 'SET NULL', nullable: true })
  docId: string | null = null;
  workspaceId: string = '';
}

const q = (value: string) => `"${value.replaceAll('"', '""')}"`;

function qualified(ctor: unknown): string {
  const registration = ObjectRegistry.getClassByConstructor(
    ctor as typeof SmrtObject,
  );
  return (
    registration?.qualifiedName ||
    registration?.name ||
    (ctor as { name: string }).name
  );
}

pgDescribe('delete cascade under column grants (#5444)', () => {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const database = `cascade5444_${suffix}`;
  const migrator = `cascade5444_mig_${suffix}`;
  const runtime = `cascade5444_run_${suffix}`;
  /** May read and delete the parent, but has no UPDATE on its table. */
  const deleterRole = `cascade5444_del_${suffix}`;
  const SCHEMA = 'app';
  let deleter: DatabaseInterface | undefined;
  let admin: DatabaseInterface | undefined;
  /** Superuser connection to the test database (plan/apply, fixture grants). */
  let adminDb: DatabaseInterface | undefined;
  /** The migration owner: creates every object, fully privileged. */
  let owner: DatabaseInterface | undefined;
  /** The runtime role, granted by the permission plan minus one column read. */
  let limited: DatabaseInterface | undefined;
  let unregister: (() => void) | undefined;
  const createdRoles: string[] = [];
  let databaseCreated = false;

  function urlFor(user?: string): string {
    const url = new URL(adminUrl);
    url.pathname = `/${database}`;
    if (user) {
      url.username = user;
      url.password = PASSWORD;
    }
    return url.toString();
  }

  beforeAll(async () => {
    registerChangeFeedWriter();
    resetChangeFeedWarnings();
    admin = await resolveDatabase(
      { type: 'postgres', url: adminUrl },
      { dbid: `admin-${suffix}` },
    );
    // The supported hardened deployment (docs/content/postgres-permissions.md):
    // a dedicated schema owned by the migration owner, which migrates
    // everything; a runtime role granted exactly what the permission plan
    // grants.
    for (const role of [migrator, runtime, deleterRole]) {
      await admin.query(
        `CREATE ROLE ${q(role)} LOGIN PASSWORD '${PASSWORD}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`,
      );
      createdRoles.push(role);
    }
    await admin.query(`CREATE DATABASE ${q(database)} OWNER ${q(migrator)}`);
    databaseCreated = true;
    for (const role of [migrator, runtime, deleterRole]) {
      await admin.query(
        `ALTER ROLE ${q(role)} IN DATABASE ${q(database)} SET search_path = ${q(SCHEMA)}`,
      );
    }
    adminDb = await resolveDatabase(
      { type: 'postgres', url: urlFor() },
      { dbid: `admin-db-${suffix}` },
    );
    await adminDb.query(
      `REVOKE TEMPORARY ON DATABASE ${q(database)} FROM PUBLIC`,
    );
    await adminDb.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
    await adminDb.query(
      `CREATE SCHEMA ${q(SCHEMA)} AUTHORIZATION ${q(migrator)}`,
    );

    // Migrate as the owner: framework system tables (with the version
    // stamp), the migration bookkeeping, and the model tables.
    owner = await resolveDatabase(
      { type: 'postgres', url: urlFor(migrator) },
      { dbid: `owner-${suffix}` },
    );
    await ensureSystemTables(owner, 'postgres');
    await new MigrationTracker({
      db: owner,
      engineHint: 'postgres',
    }).initialize();
    const modelTables: string[] = [];
    for (const ctor of [
      PgCascadeGrantDoc,
      PgCascadeGrantPart,
      PgCascadeGrantRef,
    ]) {
      const className = qualified(ctor);
      const ddl = ObjectRegistry.getSchemaDDL(className, 'postgres');
      if (!ddl) throw new Error(`Missing schema DDL for ${className}`);
      await owner.query(ddl);
      const table = ObjectRegistry.getTableName(className) as string;
      modelTables.push(table);
      await owner.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS ${q(`${table}_natural_uq`)} ON ${q(table)} (slug, context)`,
      );
    }

    // Grant the runtime role what the permission plan grants (as the CLI's
    // `db:permissions` builds the contract: model tables plus present system
    // tables), then withhold only SELECT on the children's ownership column.
    const present = new Set(
      (
        await adminDb.query(
          'SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = $1',
          SCHEMA,
        )
      ).rows.map((row) => String(row.tablename)),
    );
    const contract: PostgresPermissionContract = {
      schema: SCHEMA,
      schemaExclusive: true,
      migrationOwner: migrator,
      runtimeRole: runtime,
      managedTables: [
        ...new Set([
          ...modelTables,
          ...[...getSystemTableShapes('postgres').keys()].filter((table) =>
            present.has(table),
          ),
        ]),
      ].sort(),
    };
    const plan = await planPostgresPermissions(adminDb, contract);
    expect(plan.canApply, JSON.stringify(plan.diagnostics)).toBe(true);
    const applied = await applyPostgresPermissions(adminDb, contract, {
      expectedFingerprint: plan.fingerprint,
    });
    expect(applied.diagnostics).toEqual([]);
    for (const table of [PARTS, REFS]) {
      const columns = await adminDb.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = $2
            AND column_name <> 'workspace_id'`,
        SCHEMA,
        table,
      );
      await adminDb.query(
        `REVOKE SELECT ON ${q(SCHEMA)}.${q(table)} FROM ${q(runtime)}`,
      );
      await adminDb.query(
        `GRANT SELECT (${columns.rows
          .map((row) => q(String(row.column_name)))
          .join(', ')}) ON ${q(SCHEMA)}.${q(table)} TO ${q(runtime)}`,
      );
    }

    // A custom grant set that sufficed to delete a parent and cascade to its
    // children before #5444: everything except UPDATE on the parent's table
    // (so `SELECT … FOR UPDATE` on the parent is not available to it).
    await adminDb.query(
      `GRANT USAGE ON SCHEMA ${q(SCHEMA)} TO ${q(deleterRole)}`,
    );
    await adminDb.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${q(SCHEMA)} TO ${q(deleterRole)}`,
    );
    await adminDb.query(
      `GRANT USAGE ON ALL SEQUENCES IN SCHEMA ${q(SCHEMA)} TO ${q(deleterRole)}`,
    );
    await adminDb.query(
      `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${q(SCHEMA)} TO ${q(deleterRole)}`,
    );
    await adminDb.query(
      `REVOKE UPDATE ON ${q(SCHEMA)}.${q(DOCS)} FROM ${q(deleterRole)}`,
    );

    limited = await resolveDatabase(
      { type: 'postgres', url: urlFor(runtime) },
      { dbid: `limited-${suffix}` },
    );
    deleter = await resolveDatabase(
      { type: 'postgres', url: urlFor(deleterRole) },
      { dbid: `deleter-${suffix}` },
    );
    const owned = new Set([
      qualified(PgCascadeGrantPart),
      qualified(PgCascadeGrantRef),
    ]);
    unregister = ObjectRegistry.registerOwnershipColumnSource((name) =>
      owned.has(name) ? ['workspace_id'] : undefined,
    );
  }, 180_000);

  afterAll(async () => {
    unregister?.();
    await limited?.close?.();
    await deleter?.close?.();
    await owner?.close?.();
    await adminDb?.close?.();
    if (admin) {
      try {
        if (databaseCreated) {
          await admin.query(
            `DROP DATABASE IF EXISTS ${q(database)} WITH (FORCE)`,
          );
        }
      } finally {
        try {
          for (const role of createdRoles) {
            await admin.query(`DROP ROLE IF EXISTS ${q(role)}`);
          }
        } finally {
          await admin.close?.();
        }
      }
    }
  }, 120_000);

  async function make<T extends SmrtObject>(
    Ctor: new (options: { db: DatabaseInterface }) => T,
    db: DatabaseInterface,
    values: Record<string, unknown>,
  ): Promise<T> {
    const instance = await new Ctor({ db }).initialize();
    Object.assign(instance, values);
    await instance.save();
    return instance;
  }

  /** A parent with one CASCADE and one SET NULL child, children written by the owner. */
  async function seed(parentDb: DatabaseInterface) {
    const workspace = randomUUID();
    const doc = await make(PgCascadeGrantDoc, parentDb, { title: 'd' });
    const part = await make(PgCascadeGrantPart, need(owner), {
      docId: doc.id,
      workspaceId: workspace,
    });
    const ref = await make(PgCascadeGrantRef, need(owner), {
      docId: doc.id,
      workspaceId: workspace,
    });
    return { workspace, doc, part, ref };
  }

  async function entriesFor(ids: unknown[]): Promise<ChangeFeedEntry[]> {
    const { changes } = await getChangesSince(need(owner), {
      since: 0,
      limit: 5_000,
    });
    return changes.filter((change) => ids.includes(change.rowId));
  }

  async function state(docId: unknown, partId: unknown, refId: unknown) {
    const doc = await need(owner).query(
      `SELECT COUNT(*) AS n FROM ${q(DOCS)} WHERE id = $1`,
      docId,
    );
    const part = await need(owner).query(
      `SELECT COUNT(*) AS n FROM ${q(PARTS)} WHERE id = $1`,
      partId,
    );
    const ref = await need(owner).query(
      `SELECT CAST(doc_id AS VARCHAR) AS doc_id FROM ${q(REFS)} WHERE id = $1`,
      refId,
    );
    return {
      doc: Number(doc.rows[0]?.n),
      part: Number(part.rows[0]?.n),
      refDocId: ref.rows[0]?.doc_id ?? null,
    };
  }

  it('deletes the parent without SELECT on the children’s owner column and leaves them out of the feed', async () => {
    const { doc, part, ref } = await seed(need(limited));

    await doc.delete();

    expect(await state(doc.id, part.id, ref.id)).toEqual({
      doc: 0,
      part: 0,
      refDocId: null,
    });
    const entries = await entriesFor([part.id, ref.id]);
    // Neither an owned entry nor a global one: nothing for these rows except
    // the creates the owner's saves recorded.
    expect(entries.filter((entry) => entry.operation !== 'create')).toEqual([]);
  });

  it('deletes the parent without UPDATE on its table (no row lock) and still records the children', async () => {
    // Written by the owner: an upsert would need UPDATE the deleter lacks.
    const { workspace, doc: written, part, ref } = await seed(need(owner));
    const doc = await new PgCascadeGrantDoc({
      db: need(deleter),
      id: written.id,
    } as never).initialize();

    await doc.delete();

    expect(await state(written.id, part.id, ref.id)).toEqual({
      doc: 0,
      part: 0,
      refDocId: null,
    });
    const entries = (await entriesFor([part.id, ref.id])).filter(
      (entry) => entry.operation !== 'create',
    );
    expect(
      entries
        .map((entry) => [entry.rowId, entry.operation, entry.tenantId])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    ).toEqual(
      [
        [part.id, 'delete', workspace],
        [ref.id, 'update', workspace],
      ].sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    );
  });

  it('records the children under their owner for a fully privileged role', async () => {
    const { workspace, doc, part, ref } = await seed(need(owner));

    await doc.delete();

    expect(await state(doc.id, part.id, ref.id)).toEqual({
      doc: 0,
      part: 0,
      refDocId: null,
    });
    const entries = (await entriesFor([part.id, ref.id])).filter(
      (entry) => entry.operation !== 'create',
    );
    expect(
      entries
        .map((entry) => [entry.rowId, entry.operation, entry.tenantId])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    ).toEqual(
      [
        [part.id, 'delete', workspace],
        [ref.id, 'update', workspace],
      ].sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    );
  });
});
