/**
 * The PostgreSQL append helpers stage an entry instead of dropping it when
 * the direct allocation fails on contention (#5438).
 *
 * Only `55P03`, `40P01` and a `23505` naming the feed's own primary key are
 * eligible; `57014` and everything else are returned as before. Before
 * staging, the tenant id is converted to the feed table's live column type,
 * so nothing is staged that the drain could never insert, and the staging
 * table's insert lock is taken without waiting. The batch helper stages only
 * when its direct path failed before returning any row, and returns one row
 * per entry. Text-level checks; PGlite and the PostgreSQL lane prove the
 * behaviour.
 */
import { describe, expect, it } from 'vitest';
import {
  CREATE_POSTGRES_CHANGE_FEED_APPEND_BATCH_FUNCTION,
  CREATE_POSTGRES_CHANGE_FEED_APPEND_FUNCTION,
} from './schema.js';

const BODIES = [
  CREATE_POSTGRES_CHANGE_FEED_APPEND_FUNCTION,
  CREATE_POSTGRES_CHANGE_FEED_APPEND_BATCH_FUNCTION,
];

/** The fallback: from the eligibility test to the original-error return. */
function fallback(body: string): string {
  const start = body.indexOf('IF v_error_code IN');
  expect(start).toBeGreaterThan(0);
  const end = body.indexOf('v_error_code, v_error_message;', start);
  expect(end).toBeGreaterThan(start);
  return body.slice(start, end);
}

describe('change-feed append fallback bodies (#5438)', () => {
  it('stages only on a lock timeout, a deadlock, or a duplicate on the feed sequence key', () => {
    for (const body of BODIES) {
      const text = fallback(body);
      expect(text).toMatch(/v_error_code IN \('55P03', '40P01'\)/);
      expect(text).toMatch(
        /v_error_code = '23505'\s+AND v_constraint = \(\s+SELECT c\.conname\s+FROM pg_constraint AS c\s+WHERE c\.conrelid = to_regclass\('_smrt_changes'\)\s+AND c\.contype = 'p'/,
      );
      expect(body).toContain('v_constraint = CONSTRAINT_NAME');
      expect(text).not.toContain('57014');
    }
  });

  it('converts the tenant id to the feed table’s column type, then locks the staging table without waiting, before staging', () => {
    for (const body of BODIES) {
      const text = fallback(body);
      const convert = text.indexOf(
        '(jsonb_populate_record(NULL::_smrt_changes,',
      );
      const lock = text.indexOf(
        'LOCK TABLE _smrt_changes_pending IN ROW EXCLUSIVE MODE NOWAIT;',
      );
      const insert = text.indexOf('INSERT INTO _smrt_changes_pending');
      expect(convert).toBeGreaterThan(0);
      expect(lock).toBeGreaterThan(convert);
      expect(insert).toBeGreaterThan(lock);
      // A role without a table-level privilege for the lock gets a 1 ms
      // lock_timeout instead, restored after the insert.
      expect(text).toContain(
        "PERFORM set_config('lock_timeout', '1ms', true);",
      );
      // Any failure while staging returns the original error.
      expect(text).toMatch(
        /EXCEPTION WHEN query_canceled OR assert_failure OR OTHERS THEN\s+NULL;/,
      );
    }
  });

  it('notes the original SQLSTATE in error_message and leaves error_code NULL', () => {
    expect(fallback(CREATE_POSTGRES_CHANGE_FEED_APPEND_FUNCTION)).toMatch(
      /RETURN QUERY SELECT NULL::BIGINT, NULL::TEXT, v_note;/,
    );
    expect(fallback(CREATE_POSTGRES_CHANGE_FEED_APPEND_BATCH_FUNCTION)).toMatch(
      /SELECT input\.entry_index, NULL::BIGINT, NULL::TEXT, v_note/,
    );
  });

  it('stages a batch only from the direct path, which returns rows only after its insert succeeded', () => {
    const body = CREATE_POSTGRES_CHANGE_FEED_APPEND_BATCH_FUNCTION;
    const stagedEnd = body.indexOf(
      'END IF;',
      body.indexOf('IF v_deferred THEN'),
    );
    const insert = body.indexOf('INSERT INTO _smrt_changes (', stagedEnd);
    const directRows = body.indexOf('RETURN QUERY', stagedEnd);
    expect(insert).toBeGreaterThan(stagedEnd);
    expect(directRows).toBeGreaterThan(insert);
    // The insert is a statement of its own, not a CTE of the returned query.
    expect(body.slice(insert, directRows)).not.toContain('RETURN QUERY');
    expect(body.slice(stagedEnd, directRows)).not.toMatch(
      /\bWITH\s+\w+\s+AS\s*\(/,
    );
    expect(fallback(body)).toContain('v_deferred IS FALSE');
  });
});
