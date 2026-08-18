/**
 * System-table DDL parsing (#2368).
 *
 * The `_smrt_*` tables are created from hand-written DDL and never enter the
 * manifest, so the live-schema parity check reconstructs their expected shape
 * by parsing that DDL. These tests pin the parser against the real system DDL
 * plus the syntax corners it has to survive.
 */

import { describe, expect, it } from 'vitest';
import { RETIRED_SYSTEM_TABLES } from '../system/schema.js';
import {
  getSystemTableShapes,
  parseTableShapes,
  SYSTEM_TABLE_NAMES,
} from './system-table-shapes.js';

describe('parseTableShapes', () => {
  it('parses columns, flags, indexes, and inline UNIQUE constraints', () => {
    const shapes = parseTableShapes(`
      -- a leading comment that is not a statement
      CREATE TABLE IF NOT EXISTS widgets (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL,
        context TEXT,
        score REAL DEFAULT 1.0,
        email TEXT UNIQUE,
        UNIQUE(slug, context)
      );

      CREATE INDEX IF NOT EXISTS idx_widgets_slug ON widgets(slug);
      CREATE UNIQUE INDEX IF NOT EXISTS uq_widgets_email ON widgets(email);
    `);

    const widgets = shapes.get('widgets');
    expect(widgets).toBeDefined();
    expect(widgets?.columns.map((column) => column.name)).toEqual([
      'id',
      'slug',
      'context',
      'score',
      'email',
    ]);

    const byName = new Map(
      widgets?.columns.map((column) => [column.name, column]),
    );
    expect(byName.get('id')?.primaryKey).toBe(true);
    expect(byName.get('slug')?.notNull).toBe(true);
    expect(byName.get('context')?.notNull).toBe(false);
    expect(byName.get('score')?.hasDefault).toBe(true);
    expect(byName.get('score')?.type).toBe('REAL');
    expect(byName.get('email')?.unique).toBe(true);

    expect(widgets?.uniqueConstraints).toEqual([['slug', 'context']]);
    expect(widgets?.indexes).toEqual([
      { name: 'idx_widgets_slug', columns: ['slug'], unique: false },
      { name: 'uq_widgets_email', columns: ['email'], unique: true },
    ]);
  });

  it('records a partial index predicate and a composite PRIMARY KEY', () => {
    const shapes = parseTableShapes(`
      CREATE TABLE IF NOT EXISTS links (
        left_id TEXT,
        right_id TEXT,
        state TEXT,
        PRIMARY KEY (left_id, right_id)
      );

      CREATE INDEX IF NOT EXISTS idx_links_active
        ON links(state) WHERE state = 'active';
    `);

    const links = shapes.get('links');
    expect(
      links?.columns
        .filter((column) => column.primaryKey)
        .map((column) => column.name),
    ).toEqual(['left_id', 'right_id']);
    expect(links?.indexes[0]?.where).toBe("state = 'active'");
  });

  it('ignores table constraints that carry no column shape', () => {
    const shapes = parseTableShapes(`
      CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY,
        total REAL,
        CHECK (total >= 0),
        FOREIGN KEY (id) REFERENCES carts(id)
      );
    `);

    expect(shapes.get('orders')?.columns.map((column) => column.name)).toEqual([
      'id',
      'total',
    ]);
  });
});

describe('getSystemTableShapes', () => {
  it('covers every hand-DDL system table', () => {
    const shapes = getSystemTableShapes('sqlite');

    expect([...shapes.keys()].sort()).toEqual([
      '_smrt_ai_usage',
      '_smrt_backfills',
      '_smrt_changes',
      '_smrt_contexts',
      '_smrt_dispatch',
      '_smrt_dispatch_subscriptions',
      '_smrt_embeddings',
      '_smrt_migrations',
      '_smrt_schema_migrations',
    ]);
  });

  it('publishes the same table list as SYSTEM_TABLE_NAMES', () => {
    // One list, one parse: the change-feed allowlist and the parity check must
    // never disagree about what a system table is (issue #2376).
    expect([...SYSTEM_TABLE_NAMES].sort()).toEqual(
      [...getSystemTableShapes('sqlite').keys()].sort(),
    );
    expect([...SYSTEM_TABLE_NAMES].sort()).toEqual(
      [...getSystemTableShapes('postgres').keys()].sort(),
    );
  });

  it('excludes the retired system tables', () => {
    const names = new Set(SYSTEM_TABLE_NAMES);
    for (const retired of RETIRED_SYSTEM_TABLES) {
      expect(names.has(retired)).toBe(false);
    }
  });

  it('recovers the change-feed shape the framework depends on', () => {
    const changes = getSystemTableShapes('sqlite').get('_smrt_changes');

    expect(changes?.columns.find((column) => column.name === 'seq')).toEqual({
      name: 'seq',
      type: 'BIGINT',
      primaryKey: true,
      notNull: false,
      unique: false,
      hasDefault: false,
    });
    expect(changes?.indexes.map((index) => index.name)).toEqual([
      'idx_smrt_changes_table_seq',
      'idx_smrt_changes_tenant_seq',
      'idx_smrt_changes_created_at',
    ]);
  });

  it('recovers embedding and subscription uniqueness targets', () => {
    const shapes = getSystemTableShapes('sqlite');

    expect(shapes.get('_smrt_embeddings')?.uniqueConstraints).toEqual([
      ['object_class', 'object_id', 'field_name', 'model'],
    ]);

    const subscriptions = shapes.get('_smrt_dispatch_subscriptions');
    expect(
      subscriptions?.indexes.find(
        (index) =>
          index.name === 'uq_smrt_dispatch_subs_tenant_signal_subscriber',
      ),
    ).toEqual({
      name: 'uq_smrt_dispatch_subs_tenant_signal_subscriber',
      columns: ['tenant_id', 'signal_type', 'subscriber'],
      unique: true,
    });
  });

  it('materializes PostgreSQL timestamp types', () => {
    const sqlite = getSystemTableShapes('sqlite').get('_smrt_ai_usage');
    const postgres = getSystemTableShapes('postgres').get('_smrt_ai_usage');

    const createdAt = (shape: typeof sqlite) =>
      shape?.columns.find((column) => column.name === 'created_at');

    expect(createdAt(sqlite)?.type).toBe('TIMESTAMP');
    expect(createdAt(postgres)?.type).toBe('TIMESTAMPTZ');
    expect(createdAt(postgres)?.notNull).toBe(true);
  });
});
