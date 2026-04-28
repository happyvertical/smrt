/**
 * Issue #1165 — end-to-end regression
 *
 * Reproduces the anytown.ai failure mode: a Tenant table whose live schema
 * carries the wrong index shape (`tenants_slug_context_meta_type_idx`
 * non-unique, plus a stale 2-column unique on `(slug, context)`), so
 * `Tenant.save()` fails with "no unique or exclusion constraint matching the
 * ON CONFLICT specification" on PostgreSQL.
 *
 * The fix is in the migration differ: it now detects same-name index-shape
 * drift (uniqueness flips, column changes) and orphan indexes, emitting a
 * drop+add repair plan. After applying that plan against the stale schema,
 * the STI subclass UPSERT succeeds.
 *
 * SQLite is permissive enough that the broken-shape index alone doesn't
 * surface the bug as obviously as PostgreSQL, but the *differ output* is
 * what we're really asserting — the repair plan must drop the wrong index
 * and create the right one.
 */

import type { DatabaseProvider } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getSQLFromDiff, SchemaComparer } from '../migrations/differ.js';
import type { SchemaDefinition } from '../schema/types.js';

describe('Issue #1165: tenants STI UPSERT repair via migrate', () => {
  let db: DatabaseProvider;

  beforeEach(async () => {
    db = await getDatabase({ type: 'sqlite', url: ':memory:' });

    // Materialize the broken anytown.ai shape exactly as reported in the
    // issue: 3-column index NON-unique, stale 2-column unique still around.
    await db.query(`
      CREATE TABLE tenants (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL,
        context TEXT NOT NULL DEFAULT '',
        _meta_type TEXT NOT NULL,
        _meta_data TEXT,
        name TEXT,
        status TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT current_timestamp,
        updated_at TIMESTAMP NOT NULL DEFAULT current_timestamp
      )
    `);
    await db.query('CREATE INDEX tenants_id_idx ON tenants(id)');
    await db.query('CREATE INDEX tenants_meta_type_idx ON tenants(_meta_type)');
    // Stale 2-column unique from an older schema generation.
    await db.query(
      'CREATE UNIQUE INDEX tenants_slug_context_idx ON tenants(slug, context)',
    );
    // The broken case: right name and columns, but NOT unique. PostgreSQL
    // would reject ON CONFLICT(slug, context, _meta_type) against this.
    await db.query(
      'CREATE INDEX tenants_slug_context_meta_type_idx ON tenants(slug, context, _meta_type)',
    );
  });

  afterEach(async () => {
    await db.close?.();
  });

  /** What the manifest now declares for the tenants table (STI). */
  function tenantsManifest(): Record<string, SchemaDefinition> {
    return {
      tenants: {
        tableName: 'tenants',
        ddl: '',
        columns: {
          id: { type: 'TEXT', primaryKey: true, notNull: true },
          slug: { type: 'TEXT', notNull: true },
          context: { type: 'TEXT', notNull: true, defaultValue: '' },
          _meta_type: { type: 'TEXT', notNull: true },
          _meta_data: { type: 'JSON' },
          name: { type: 'TEXT' },
          status: { type: 'TEXT' },
          created_at: {
            type: 'TIMESTAMP',
            notNull: true,
            defaultValue: 'current_timestamp',
          },
          updated_at: {
            type: 'TIMESTAMP',
            notNull: true,
            defaultValue: 'current_timestamp',
          },
        },
        indexes: [
          { name: 'tenants_id_idx', columns: ['id'], unique: false },
          {
            name: 'tenants_meta_type_idx',
            columns: ['_meta_type'],
            unique: false,
          },
          {
            name: 'tenants_slug_context_meta_type_idx',
            columns: ['slug', 'context', '_meta_type'],
            unique: true,
          },
        ],
        triggers: [],
        foreignKeys: [],
        dependencies: [],
        version: '1.0.0',
      },
    };
  }

  it('produces a drop+add repair plan for the stale index shape', async () => {
    const comparer = new SchemaComparer(db, { includeDroppedIndexes: true });
    const diff = await comparer.compare(tenantsManifest());

    const events = diff.changes
      .filter((c) => c.type === 'drop_index' || c.type === 'add_index')
      .map((c) => `${c.type}:${c.name}`);

    // The broken-shape recreate.
    expect(events).toContain('drop_index:tenants_slug_context_meta_type_idx');
    expect(events).toContain('add_index:tenants_slug_context_meta_type_idx');

    // The stale 2-column unique gets dropped.
    expect(events).toContain('drop_index:tenants_slug_context_idx');

    // Maintenance indexes that already match are left alone.
    expect(events).not.toContain('drop_index:tenants_id_idx');
    expect(events).not.toContain('drop_index:tenants_meta_type_idx');
  });

  it('after applying the repair plan, ON CONFLICT(slug, context, _meta_type) UPSERT succeeds', async () => {
    const comparer = new SchemaComparer(db, { includeDroppedIndexes: true });
    const diff = await comparer.compare(tenantsManifest());

    // Apply the repair SQL the differ produced.
    for (const sql of getSQLFromDiff(diff)) {
      await db.query(sql);
    }

    // Now the table carries a unique index matching the conflict target,
    // so the upsert plan that previously failed now binds correctly. Use
    // db.upsert directly so we exercise the same code path SmrtObject.save
    // takes for STI rows (`['slug', 'context', '_meta_type']`).
    await db.upsert('tenants', ['slug', 'context', '_meta_type'], {
      id: 't_doctor_test_1',
      slug: 'doctor-test-1',
      context: '/tenants',
      _meta_type: '@happyvertical/smrt-tenancy:Network',
      name: 'Doctor Test',
      status: 'active',
    });

    // Re-upserting the same key updates the existing row in place.
    await db.upsert('tenants', ['slug', 'context', '_meta_type'], {
      id: 't_doctor_test_1',
      slug: 'doctor-test-1',
      context: '/tenants',
      _meta_type: '@happyvertical/smrt-tenancy:Network',
      name: 'Doctor Test (renamed)',
      status: 'active',
    });

    const rowsResult = await db.query(
      'SELECT name FROM tenants WHERE slug = ? AND context = ? AND _meta_type = ?',
      ['doctor-test-1', '/tenants', '@happyvertical/smrt-tenancy:Network'],
    );
    const rows = Array.isArray(rowsResult) ? rowsResult : rowsResult.rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Doctor Test (renamed)');
  });

  it('two STI subtypes can share (slug, context) with the repaired index', async () => {
    // The whole point of including _meta_type in the conflict target.
    const comparer = new SchemaComparer(db, { includeDroppedIndexes: true });
    const diff = await comparer.compare(tenantsManifest());
    for (const sql of getSQLFromDiff(diff)) {
      await db.query(sql);
    }

    await db.upsert('tenants', ['slug', 'context', '_meta_type'], {
      id: 't_a',
      slug: 'shared',
      context: '/tenants',
      _meta_type: '@happyvertical/smrt-tenancy:Network',
      name: 'Network A',
    });
    await db.upsert('tenants', ['slug', 'context', '_meta_type'], {
      id: 't_b',
      slug: 'shared',
      context: '/tenants',
      _meta_type: '@happyvertical/smrt-tenancy:Publication',
      name: 'Publication B',
    });

    const rowsResult = await db.query(
      "SELECT _meta_type, name FROM tenants WHERE slug = 'shared' ORDER BY _meta_type",
    );
    const rows = Array.isArray(rowsResult) ? rowsResult : rowsResult.rows;
    expect(rows).toHaveLength(2);
  });
});
