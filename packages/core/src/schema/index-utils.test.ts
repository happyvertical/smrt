/**
 * Identifier length guard (#2374, epic #2382, finding C5).
 *
 * PostgreSQL truncates every identifier at 63 bytes and says nothing. SQLite
 * and DuckDB do not, so the whole test suite is blind to it — the shipped
 * 66-byte `content_contribution_revisions_contribution_id_revision_number_idx`
 * reached production that way.
 *
 * These tests pin the three properties the guard has to have:
 *
 * 1. **Stability** — the same input always yields the same output, across
 *    processes and releases. A shortened name that drifted between versions
 *    would make every deployment drop and recreate the index.
 * 2. **Distinctness** — two names that share a 63-byte prefix, the pair
 *    PostgreSQL would collapse into one, come out different. That collapse is
 *    the actual bug: `CREATE INDEX IF NOT EXISTS` silently no-ops against the
 *    wrong index and the differ then emits `add_index` on every run, forever.
 * 3. **Non-interference** — a name that already fits is returned byte-for-byte
 *    unchanged, so no existing database sees churn.
 */

import { describe, expect, it } from 'vitest';
import {
  assertIdentifierFits,
  enforceIdentifierLimits,
  identifierByteLength,
  MAX_IDENTIFIER_BYTES,
  shortenIdentifier,
} from './index-utils.js';

/** The 66-byte index that shipped — the concrete case from finding C5. */
const SHIPPED_OVERLONG =
  'content_contribution_revisions_contribution_id_revision_number_idx';

describe('identifierByteLength', () => {
  it('counts ASCII as one byte per character', () => {
    expect(identifierByteLength('contents_slug_context_idx')).toBe(25);
    expect(identifierByteLength(SHIPPED_OVERLONG)).toBe(66);
  });

  it('counts UTF-8 bytes, not characters — the unit PostgreSQL limits', () => {
    // A name of 32 two-byte characters is 64 bytes: under the character count
    // one would naively check, over the limit PostgreSQL actually enforces.
    expect(identifierByteLength('é'.repeat(32))).toBe(64);
    expect(identifierByteLength('日本語')).toBe(9);
    // Astral plane: one code point, one surrogate pair, four bytes.
    expect(identifierByteLength('𝄞')).toBe(4);
  });
});

describe('shortenIdentifier', () => {
  it('returns a name that already fits unchanged', () => {
    for (const name of [
      'contents_slug_context_idx',
      'parity_events_booking_ref_parity_meeting_unique_idx',
      'a'.repeat(MAX_IDENTIFIER_BYTES),
    ]) {
      expect(shortenIdentifier(name)).toBe(name);
    }
  });

  it('shortens the 66-byte index that shipped to exactly the limit', () => {
    const shortened = shortenIdentifier(SHIPPED_OVERLONG);
    expect(identifierByteLength(shortened)).toBeLessThanOrEqual(
      MAX_IDENTIFIER_BYTES,
    );
    expect(shortened).not.toBe(SHIPPED_OVERLONG);
    // Still recognisable: the table name leads and the `_idx` token survives.
    expect(shortened.startsWith('content_contribution_revisions_')).toBe(true);
    expect(shortened.endsWith('_idx')).toBe(true);
  });

  it('is stable — the same input always produces the same output', () => {
    // Pinned literal, not a recomputation: a change here means every deployed
    // database would drop and recreate the index on the next migrate.
    expect(shortenIdentifier(SHIPPED_OVERLONG)).toBe(
      'content_contribution_revisions_contribution_id_r_af43e6d599_idx',
    );
  });

  it('keeps two names apart when only their first 63 bytes match (the bug)', () => {
    const prefix = 'a'.repeat(60);
    const first = shortenIdentifier(`${prefix}_contribution_id_idx`);
    const second = shortenIdentifier(`${prefix}_revision_number_idx`);

    // PostgreSQL truncation would make these the same identifier, and the
    // second CREATE INDEX IF NOT EXISTS would silently no-op.
    expect(first).not.toBe(second);
    expect(identifierByteLength(first)).toBeLessThanOrEqual(
      MAX_IDENTIFIER_BYTES,
    );
    expect(identifierByteLength(second)).toBeLessThanOrEqual(
      MAX_IDENTIFIER_BYTES,
    );
  });

  it('preserves the longest recognised suffix', () => {
    const unique = shortenIdentifier(`${'x'.repeat(70)}_unique_idx`);
    expect(unique.endsWith('_unique_idx')).toBe(true);
    expect(identifierByteLength(unique)).toBeLessThanOrEqual(
      MAX_IDENTIFIER_BYTES,
    );
  });

  it('never splits a multi-byte character when truncating the head', () => {
    // 40 three-byte characters = 120 bytes, all in the head.
    const shortened = shortenIdentifier(`${'日'.repeat(40)}_idx`);
    expect(identifierByteLength(shortened)).toBeLessThanOrEqual(
      MAX_IDENTIFIER_BYTES,
    );
    // A split code point would surface as U+FFFD or a lone surrogate.
    expect(shortened).not.toContain('�');
    expect([...shortened].every((ch) => ch.codePointAt(0) !== undefined)).toBe(
      true,
    );
    expect(encodeURIComponent(shortened)).toBeTruthy();
  });

  it('never splits a surrogate pair when truncating the head', () => {
    // 20 astral characters = 80 bytes.
    const shortened = shortenIdentifier(`${'𝄞'.repeat(20)}_idx`);
    expect(identifierByteLength(shortened)).toBeLessThanOrEqual(
      MAX_IDENTIFIER_BYTES,
    );
    // A lone surrogate cannot be URI-encoded; this throws if one survived.
    expect(() => encodeURIComponent(shortened)).not.toThrow();
  });

  it('refuses a limit too small to hold even the digest', () => {
    expect(() => shortenIdentifier('some_long_index_name_idx', 8)).toThrow(
      /Cannot shorten identifier/,
    );
  });
});

describe('assertIdentifierFits', () => {
  it('accepts a name at the limit', () => {
    expect(() =>
      assertIdentifierFits('a'.repeat(63), 'Table', 'test'),
    ).not.toThrow();
  });

  it('rejects a name one byte over, naming the fix', () => {
    expect(() =>
      assertIdentifierFits('a'.repeat(64), 'Declared index', 'table "widgets"'),
    ).toThrow(/is 64 bytes; PostgreSQL truncates identifiers at 63 bytes/);
  });

  it('measures bytes, so a 32-character name can still be rejected', () => {
    expect(() =>
      assertIdentifierFits('é'.repeat(32), 'Column', 'test'),
    ).toThrow(/is 64 bytes/);
  });
});

describe('enforceIdentifierLimits', () => {
  it('shortens index names in place and leaves short ones alone', () => {
    const indexes = [
      { name: 'widgets_slug_context_idx' },
      { name: SHIPPED_OVERLONG },
    ];
    enforceIdentifierLimits('widgets', { id: {}, slug: {} }, indexes);

    expect(indexes[0].name).toBe('widgets_slug_context_idx');
    expect(indexes[1].name).toBe(shortenIdentifier(SHIPPED_OVERLONG));
  });

  it('rejects an over-long table name rather than renaming the table', () => {
    // Shortening here is not an option: the runtime resolves the table by the
    // name it derives from the class, so a schema-only rename would point the
    // data path at a table that does not exist.
    expect(() => enforceIdentifierLimits('t'.repeat(64), {}, [])).toThrow(
      /^\[smrt\] Table name/,
    );
  });

  it('rejects an over-long column name', () => {
    expect(() =>
      enforceIdentifierLimits('widgets', { ['c'.repeat(64)]: {} }, []),
    ).toThrow(/^\[smrt\] Column name/);
  });

  it('tolerates two entries that started from the same name', () => {
    // A duplicate is not a collision — the upstream passes already dedupe by
    // name, and an identical re-declaration is harmless. Only two DIFFERENT
    // originals landing on one shortened name is an error (a residual digest
    // collision, which the throw turns into a build failure instead of a
    // silently missing index).
    const indexes = [{ name: SHIPPED_OVERLONG }, { name: SHIPPED_OVERLONG }];
    expect(() => enforceIdentifierLimits('widgets', {}, indexes)).not.toThrow();
    expect(indexes[0].name).toBe(indexes[1].name);
  });

  it('keeps two long sibling index names distinct instead of collapsing them', () => {
    // The end-to-end shape of the bug: two indexes on one table whose names
    // agree for the first 63 bytes. Untouched, PostgreSQL stores one and
    // silently drops the other.
    const table = `w${'i'.repeat(50)}`;
    const indexes = [
      { name: `${table}_contribution_id_idx` },
      { name: `${table}_revision_number_idx` },
    ];
    enforceIdentifierLimits(table, {}, indexes);

    expect(indexes[0].name).not.toBe(indexes[1].name);
    for (const index of indexes) {
      expect(identifierByteLength(index.name)).toBeLessThanOrEqual(
        MAX_IDENTIFIER_BYTES,
      );
    }
  });
});
