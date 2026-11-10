/**
 * System-table tenant ids follow the application UUID contract (#3297).
 *
 * The change feed (and its PostgreSQL staging table) and the dispatch tables
 * hold real tenant ids — a tenant UUID from the tenant context, or NULL for a
 * global row — but were declared TEXT on every engine, so joins against
 * native-uuid tenant tables needed casts. On PostgreSQL they now materialize
 * as `uuid`; the text identity encodings and caller-supplied scope keys stay
 * TEXT; and the change-feed helpers coerce a tenant id to whatever type the
 * live column has, so the same body serves a database before and after
 * `smrt db:migrate-uuid` converts it.
 */

import { describe, expect, it } from 'vitest';
import { getSystemTableShapes } from '../schema/system-table-shapes.js';
import {
  CREATE_POSTGRES_CHANGE_FEED_APPEND_BATCH_FUNCTION,
  CREATE_POSTGRES_CHANGE_FEED_APPEND_FUNCTION,
  CREATE_POSTGRES_CHANGE_FEED_DRAIN_FUNCTION,
  CREATE_POSTGRES_SMRT_CHANGES_PENDING_TABLE,
  CREATE_POSTGRES_SMRT_CHANGES_TABLE,
  POSTGRES_CHANGE_FEED_HELPER_COMPAT_MARKER,
  POSTGRES_CHANGE_FEED_HELPER_MARKER,
  SYSTEM_TABLE_TENANT_UUID_COLUMNS,
} from './schema.js';

const typeOf = (
  engine: 'postgres' | 'sqlite' | 'duckdb',
  table: string,
  column: string,
) =>
  getSystemTableShapes(engine)
    .get(table)
    ?.columns.find((candidate) => candidate.name === column)?.type;

describe('system-table tenant ids (#3297)', () => {
  it('materializes the listed tenant columns as uuid on PostgreSQL only', () => {
    for (const { table, column } of SYSTEM_TABLE_TENANT_UUID_COLUMNS) {
      if (table === '_smrt_changes_pending') continue; // PostgreSQL-only DDL
      expect(typeOf('postgres', table, column), table).toBe('UUID');
      expect(typeOf('sqlite', table, column), table).toBe('TEXT');
      expect(typeOf('duckdb', table, column), table).toBe('TEXT');
    }
    expect(CREATE_POSTGRES_SMRT_CHANGES_TABLE).toMatch(/tenant_id UUID/);
    expect(CREATE_POSTGRES_SMRT_CHANGES_PENDING_TABLE).toMatch(
      /tenant_id UUID/,
    );
  });

  it('keeps text identity encodings and caller-supplied scope keys as TEXT', () => {
    expect(typeOf('postgres', '_smrt_contexts', 'owner_id')).toBe('TEXT');
    expect(typeOf('postgres', '_smrt_run_once_claims', 'tenant_id')).toBe(
      'TEXT',
    );
    expect(typeOf('postgres', '_smrt_run_once_claims', 'actor')).toBe('TEXT');
    expect(typeOf('postgres', '_smrt_ai_usage', 'tenant_id')).toBe('TEXT');
    expect(typeOf('postgres', '_smrt_dispatch', 'processed_by')).toBe('TEXT');
    expect(typeOf('postgres', '_smrt_schema_migrations', 'applied_by')).toBe(
      'TEXT',
    );
  });

  it('coerces tenant ids to the live column type in every helper body', () => {
    for (const body of [
      CREATE_POSTGRES_CHANGE_FEED_APPEND_FUNCTION,
      CREATE_POSTGRES_CHANGE_FEED_APPEND_BATCH_FUNCTION,
      CREATE_POSTGRES_CHANGE_FEED_DRAIN_FUNCTION,
    ]) {
      expect(body).toContain('jsonb_populate_record(NULL::_smrt_changes');
      // Both markers: v5 for current probes, v4 so an older process's probe
      // keeps the type-agnostic body instead of replacing it mid-rollout.
      expect(body).toContain(POSTGRES_CHANGE_FEED_HELPER_MARKER);
      expect(body).toContain(POSTGRES_CHANGE_FEED_HELPER_COMPAT_MARKER);
    }
    // The drain returns tenant ids as text whatever the column type.
    expect(CREATE_POSTGRES_CHANGE_FEED_DRAIN_FUNCTION).toContain(
      'inserted.tenant_id::TEXT',
    );
    expect(POSTGRES_CHANGE_FEED_HELPER_MARKER).not.toBe(
      POSTGRES_CHANGE_FEED_HELPER_COMPAT_MARKER,
    );
  });
});
