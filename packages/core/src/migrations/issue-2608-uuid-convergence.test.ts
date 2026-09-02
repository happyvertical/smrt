/**
 * #2608 — pre-R11 `text` -> `uuid` convergence.
 *
 * A database created before R11 still stores SMRT identifiers as `text`,
 * while every reference column added afterwards materializes as `uuid`.
 * PostgreSQL cannot implement a foreign key across those two physical types,
 * so the differ has to converge the columns *before* it emits any FK DDL —
 * and refuse, visibly, when it cannot do that safely.
 *
 * The fixture mirrors the willgriffin.dev dev database reported on the issue:
 * six mixed uuid/text relationships and four already-compatible ones.
 */

import { describe, expect, it } from 'vitest';
import type { SchemaDefinition } from '../schema/types.js';
import { getSQLFromDiff, SchemaComparer } from './differ.js';

type LiveColumn = {
  name: string;
  type: string;
  primaryKey?: boolean;
  defaultValue?: unknown;
};

interface LiveTable {
  columns: Record<string, LiveColumn>;
  indexes: never[];
  foreignKeys: {
    column: string;
    referencesTable: string;
    referencesColumn: string;
    onDelete?: string;
    onUpdate?: string;
  }[];
}

/** Manifest schema: a UUID primary key plus UUID references. */
function manifest(
  tableName: string,
  references: Record<string, { table: string; column?: string }> = {},
  idType: 'UUID' | 'TEXT' = 'UUID',
): SchemaDefinition {
  const columns: SchemaDefinition['columns'] = {
    id: { type: idType, primaryKey: true },
  };
  for (const [column, target] of Object.entries(references)) {
    columns[column] = {
      type: idType,
      foreignKey: {
        table: target.table,
        column: target.column ?? 'id',
        onDelete: 'NO ACTION',
        onUpdate: 'CASCADE',
      },
    };
  }
  return {
    tableName,
    columns,
    indexes: [],
    triggers: [],
    foreignKeys: Object.entries(references).map(([column, target]) => ({
      column,
      referencesTable: target.table,
      referencesColumn: target.column ?? 'id',
      onDelete: 'NO ACTION' as const,
      onUpdate: 'CASCADE' as const,
    })),
    dependencies: Object.values(references).map((target) => target.table),
    version: '2608',
  };
}

/** Live table: the physical types the legacy database actually has. */
function live(
  columnTypes: Record<string, string>,
  foreignKeys: LiveTable['foreignKeys'] = [],
): LiveTable {
  return {
    columns: Object.fromEntries(
      Object.entries(columnTypes).map(([name, type]) => [
        name,
        { name, type, primaryKey: name === 'id' },
      ]),
    ),
    indexes: [],
    foreignKeys,
  };
}

interface MockOptions {
  /** Rows the uuid-shape probe reports per `table.column`. */
  invalidUuidValues?: Record<string, { count: number; sample?: string }>;
  /** Make every uuid-shape probe throw (adapter cannot run it). */
  probeThrows?: boolean;
}

function postgresMock(
  tables: Record<string, LiveTable>,
  options: MockOptions = {},
) {
  const queries: string[] = [];
  const db = {
    url: 'postgres://fixture/issue2608',
    query: async (sql: string) => {
      queries.push(sql);
      if (sql.includes('information_schema.tables')) {
        return {
          rows: Object.keys(tables).map((table_name) => ({ table_name })),
        };
      }
      if (sql.includes('invalid_count')) {
        if (options.probeThrows) throw new Error('permission denied');
        const match = /FROM "([^"]+)"[\s\S]*WHERE "([^"]+)"/.exec(sql);
        const key = `${match?.[1]}.${match?.[2]}`;
        const dirty = options.invalidUuidValues?.[key];
        return {
          rows: [
            {
              invalid_count: dirty?.count ?? 0,
              sample_value: dirty?.sample ?? null,
            },
          ],
        };
      }
      if (sql.includes('orphan_key')) return { rows: [] };
      return { rows: [] };
    },
    getTableSchema: async (tableName: string) => tables[tableName],
  };
  return { queries, db };
}

/** The willgriffin.dev shape: six drifted pairs, four compatible ones. */
function willgriffinFixture() {
  const schemas: Record<string, SchemaDefinition> = {
    tags: manifest('tags', { parent_id: { table: 'tags' } }),
    folders: manifest('folders'),
    assets: manifest('assets', {
      source_asset_id: { table: 'assets' },
      folder_id: { table: 'folders' },
    }),
    profiles: manifest('profiles'),
    oidc_profile_email_reservations: manifest(
      'oidc_profile_email_reservations',
      { profile_id: { table: 'profiles' } },
    ),
    users: manifest('users'),
    users_cli_auth_approve_limits: manifest('users_cli_auth_approve_limits', {
      user_id: { table: 'users' },
    }),
    facts: manifest('facts', { previous_fact_id: { table: 'facts' } }),
    // Four already-compatible relationships.
    authors: manifest('authors'),
    posts: manifest('posts', { author_id: { table: 'authors' } }),
    comments: manifest('comments', { post_id: { table: 'posts' } }),
    media: manifest('media', { owner_id: { table: 'authors' } }),
    legacy_notes: manifest('legacy_notes', {}, 'TEXT'),
    legacy_note_links: manifest(
      'legacy_note_links',
      { note_id: { table: 'legacy_notes' } },
      'TEXT',
    ),
  };

  const tables: Record<string, LiveTable> = {
    tags: live({ id: 'text', parent_id: 'uuid' }),
    folders: live({ id: 'uuid' }),
    assets: live({ id: 'text', source_asset_id: 'uuid', folder_id: 'text' }),
    profiles: live({ id: 'text' }),
    oidc_profile_email_reservations: live({ id: 'uuid', profile_id: 'uuid' }),
    users: live({ id: 'text' }),
    users_cli_auth_approve_limits: live({ id: 'uuid', user_id: 'uuid' }),
    facts: live({ id: 'text', previous_fact_id: 'uuid' }),
    authors: live({ id: 'uuid' }),
    posts: live({ id: 'uuid', author_id: 'uuid' }),
    comments: live({ id: 'uuid', post_id: 'uuid' }),
    media: live({ id: 'uuid', owner_id: 'uuid' }),
    legacy_notes: live({ id: 'text' }),
    legacy_note_links: live({ id: 'text', note_id: 'text' }),
  };

  return { schemas, tables };
}

function conversionTargets(sql: string[]): string[] {
  return sql
    .filter((statement) => statement.includes('TYPE uuid USING'))
    .map((statement) => {
      const match = /ALTER TABLE "([^"]+)" ALTER COLUMN "([^"]+)"/.exec(
        statement,
      );
      return `${match?.[1]}.${match?.[2]}`;
    });
}

describe('uuid convergence for pre-R11 databases (#2608)', () => {
  it('converts every legacy text side of a drifted relationship and leaves compatible ones alone', async () => {
    const { schemas, tables } = willgriffinFixture();
    const mock = postgresMock(tables);
    const diff = await new SchemaComparer(mock.db as never, {
      engineHint: 'postgres',
    }).compare(schemas);

    const sql = getSQLFromDiff(diff);
    expect(conversionTargets(sql).sort()).toEqual([
      'assets.folder_id',
      'assets.id',
      'facts.id',
      'profiles.id',
      'tags.id',
      'users.id',
    ]);
    // The tolerated all-text deployment is untouched, and so is every
    // relationship that is already native uuid on both sides.
    expect(sql.join('\n')).not.toContain('ALTER COLUMN "note_id"');
    expect(sql.join('\n')).not.toContain('"legacy_notes" ALTER COLUMN');
    expect(sql.join('\n')).not.toContain('"posts" ALTER COLUMN');
    expect(diff.has_changes).toBe(true);
  });

  it('orders every conversion before every foreign-key statement', async () => {
    const { schemas, tables } = willgriffinFixture();
    const mock = postgresMock(tables);
    const diff = await new SchemaComparer(mock.db as never, {
      engineHint: 'postgres',
    }).compare(schemas);

    const sql = getSQLFromDiff(diff);
    const lastConversion = sql.findLastIndex((statement) =>
      statement.includes('TYPE uuid USING'),
    );
    const firstForeignKey = sql.findIndex((statement) =>
      statement.includes('ADD CONSTRAINT'),
    );
    expect(lastConversion).toBeGreaterThanOrEqual(0);
    expect(firstForeignKey).toBeGreaterThan(lastConversion);

    // The orchestrator interleaves deferred constraints for newly created
    // tables, so it partitions on this marker rather than on array order.
    for (const change of diff.changes) {
      if (change.sqlStatements?.some((s) => s.includes('TYPE uuid USING'))) {
        expect(change.phase).toBe('pre_foreign_key');
      }
    }
  });

  it('converts a self-referential parent id before its own child reference', async () => {
    const schemas = {
      tags: manifest('tags', { parent_id: { table: 'tags' } }),
    };
    const mock = postgresMock({
      tags: live({ id: 'text', parent_id: 'uuid' }),
    });
    const diff = await new SchemaComparer(mock.db as never, {
      engineHint: 'postgres',
    }).compare(schemas);

    expect(conversionTargets(getSQLFromDiff(diff))).toEqual(['tags.id']);
  });

  it('drops a live default before rewriting the column type', async () => {
    const schemas = {
      tags: manifest('tags', { parent_id: { table: 'tags' } }),
    };
    const tables = { tags: live({ id: 'text', parent_id: 'uuid' }) };
    tables.tags.columns.id.defaultValue = "''::text";
    const mock = postgresMock(tables);
    const diff = await new SchemaComparer(mock.db as never, {
      engineHint: 'postgres',
    }).compare(schemas);

    expect(getSQLFromDiff(diff).slice(0, 2)).toEqual([
      'ALTER TABLE "tags" ALTER COLUMN "id" DROP DEFAULT',
      'ALTER TABLE "tags" ALTER COLUMN "id" TYPE uuid USING "id"::uuid',
    ]);
  });

  it('refuses to coerce values that are not uuid-shaped and blocks the dependent foreign key', async () => {
    const schemas = {
      tags: manifest('tags', { parent_id: { table: 'tags' } }),
    };
    const mock = postgresMock(
      { tags: live({ id: 'text', parent_id: 'uuid' }) },
      { invalidUuidValues: { 'tags.id': { count: 3, sample: 'root' } } },
    );
    const diff = await new SchemaComparer(mock.db as never, {
      engineHint: 'postgres',
    }).compare(schemas);

    expect(getSQLFromDiff(diff)).toEqual([]);
    const blocked = diff.changes.find(
      (change) =>
        change.type === 'type_upgrade' && change.phase === 'pre_foreign_key',
    );
    expect(blocked?.advisory?.severity).toBe('warning');
    expect(blocked?.advisory?.message).toContain('blocked:');
    expect(blocked?.advisory?.message).toContain(
      'tags.id holds 3 values that are not uuid-shaped',
    );
    expect(blocked?.advisory?.message).toContain('"root"');
    expect(blocked?.advisory?.suggestedSql?.join('\n')).toContain(
      'TYPE uuid USING',
    );

    const foreignKey = diff.changes.find(
      (change) => change.type === 'add_foreign_key',
    );
    expect(foreignKey?.sqlStatements).toBeUndefined();
    expect(foreignKey?.advisory?.message).toContain(
      'blocked: incompatible column types',
    );
    expect(foreignKey?.advisory?.message).toContain('SQLSTATE 42804');
  });

  it('blocks when the uuid-shape probe cannot run at all', async () => {
    const schemas = {
      tags: manifest('tags', { parent_id: { table: 'tags' } }),
    };
    const mock = postgresMock(
      { tags: live({ id: 'text', parent_id: 'uuid' }) },
      { probeThrows: true },
    );
    const diff = await new SchemaComparer(mock.db as never, {
      engineHint: 'postgres',
    }).compare(schemas);

    expect(getSQLFromDiff(diff)).toEqual([]);
    expect(
      diff.changes.some((change) =>
        change.advisory?.message.includes('could not be probed'),
      ),
    ).toBe(true);
  });

  it('blocks when a live foreign key still depends on a column that must change', async () => {
    const schemas = {
      tags: manifest('tags', { parent_id: { table: 'tags' } }),
      tag_links: manifest('tag_links', { tag_id: { table: 'tags' } }),
    };
    const mock = postgresMock({
      tags: live({ id: 'text', parent_id: 'uuid' }),
      tag_links: live({ id: 'text', tag_id: 'text' }, [
        {
          column: 'tag_id',
          referencesTable: 'tags',
          referencesColumn: 'id',
          onDelete: 'NO ACTION',
          onUpdate: 'CASCADE',
        },
      ]),
    });
    const diff = await new SchemaComparer(mock.db as never, {
      engineHint: 'postgres',
    }).compare(schemas);

    expect(getSQLFromDiff(diff)).toEqual([]);
    const blocked = diff.changes.find((change) =>
      change.advisory?.message.includes('live foreign keys still depend'),
    );
    expect(blocked?.advisory?.message).toContain('tag_links.tag_id -> tags.id');
  });

  it('leaves a consistently-text pre-R11 deployment untouched', async () => {
    const schemas = {
      legacy_notes: manifest('legacy_notes'),
      legacy_note_links: manifest('legacy_note_links', {
        note_id: { table: 'legacy_notes' },
      }),
    };
    const mock = postgresMock({
      legacy_notes: live({ id: 'text' }),
      legacy_note_links: live({ id: 'text', note_id: 'text' }),
    });
    const diff = await new SchemaComparer(mock.db as never, {
      engineHint: 'postgres',
    }).compare(schemas);

    expect(conversionTargets(getSQLFromDiff(diff))).toEqual([]);
    expect(
      diff.changes.some((change) => change.phase === 'pre_foreign_key'),
    ).toBe(false);
    expect(mock.queries.some((sql) => sql.includes('invalid_count'))).toBe(
      false,
    );
  });

  it('treats a table this migration creates as authoritative uuid evidence', async () => {
    // `parents` does not exist yet, so it materializes as native uuid from
    // the manifest — the legacy text child reference must still converge.
    // `children.id` is referenced by nothing, so the R11 text tolerance keeps
    // it as-is: convergence is driven by relationships, not by every id.
    const schemas = {
      parents: manifest('parents'),
      children: manifest('children', { parent_id: { table: 'parents' } }),
    };
    const mock = postgresMock({
      children: live({ id: 'text', parent_id: 'text' }),
    });
    const diff = await new SchemaComparer(mock.db as never, {
      engineHint: 'postgres',
    }).compare(schemas);

    expect(conversionTargets(getSQLFromDiff(diff))).toEqual([
      'children.parent_id',
    ]);
  });

  for (const engineHint of ['sqlite', 'duckdb'] as const) {
    it(`emits nothing for uuid/text drift on ${engineHint}`, async () => {
      const { schemas, tables } = willgriffinFixture();
      const mock = postgresMock(tables);
      const query = mock.db.query;
      mock.db.query = async (sql: string) => {
        if (sql.includes('sqlite_master')) {
          mock.queries.push(sql);
          return {
            rows: Object.keys(tables).map((name) => ({ name })),
          } as never;
        }
        return query(sql);
      };

      const diff = await new SchemaComparer(mock.db as never, {
        engineHint,
      }).compare(schemas);

      expect(conversionTargets(getSQLFromDiff(diff))).toEqual([]);
      expect(
        diff.changes.some((change) => change.phase === 'pre_foreign_key'),
      ).toBe(false);
      expect(mock.queries.some((sql) => sql.includes('invalid_count'))).toBe(
        false,
      );
    });
  }
});
