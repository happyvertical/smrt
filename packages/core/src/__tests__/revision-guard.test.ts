/**
 * Revision predicate rendering contract (#2620).
 *
 * These are pure-function cases: the live PostgreSQL behaviour they protect is
 * covered by `issue-2620-revision-guard-precision-postgres.optional.test.ts`.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  isEmbeddedDatabase,
  isPostgresDatabase,
} from '../embedded-write-queue';
import {
  POSTGRES_REVISION_GUARD_EXPRESSION,
  postgresRevisionCandidates,
  postgresRevisionCondition,
} from '../revision-guard';

const originalTz = process.env.TZ;

afterEach(() => {
  if (originalTz === undefined) {
    delete process.env.TZ;
  } else {
    process.env.TZ = originalTz;
  }
});

describe('postgresRevisionCandidates', () => {
  it('renders a single millisecond wall clock under UTC', () => {
    process.env.TZ = 'UTC';
    if (new Date().getTimezoneOffset() !== 0) return;
    expect(
      postgresRevisionCandidates(new Date('2026-09-02T08:11:28.939Z')),
    ).toEqual(['2026-09-02 08:11:28.939+00']);
  });

  it('renders both the process-zone and UTC wall clocks off UTC', () => {
    process.env.TZ = 'America/Vancouver';
    if (new Date().getTimezoneOffset() === 0) return;
    expect(
      postgresRevisionCandidates(new Date('2026-09-02T08:11:28.939Z')),
    ).toEqual(['2026-09-02 01:11:28.939+00', '2026-09-02 08:11:28.939+00']);
  });

  it('truncates nothing a Date can represent and pads every field', () => {
    process.env.TZ = 'UTC';
    if (new Date().getTimezoneOffset() !== 0) return;
    expect(postgresRevisionCandidates('2026-01-02T03:04:05.006Z')).toEqual([
      '2026-01-02 03:04:05.006+00',
    ]);
  });

  it('accepts an ISO string revision', () => {
    expect(postgresRevisionCandidates('2026-09-02T08:11:28.939Z')).toEqual(
      postgresRevisionCandidates(new Date('2026-09-02T08:11:28.939Z')),
    );
  });

  it('rejects an unparseable revision rather than guarding on NaN', () => {
    expect(() => postgresRevisionCandidates('not-a-timestamp')).toThrow(
      RangeError,
    );
  });
});

describe('postgresRevisionCondition', () => {
  it('keys the condition on a millisecond-truncating IN expression', () => {
    const condition = postgresRevisionCondition(
      new Date('2026-09-02T08:11:28.939Z'),
    );
    const [key] = Object.keys(condition);
    expect(key).toContain(`${POSTGRES_REVISION_GUARD_EXPRESSION} in`);
    expect(Object.values(condition)[0]).toEqual(
      postgresRevisionCandidates(new Date('2026-09-02T08:11:28.939Z')),
    );
  });
});

describe('isPostgresDatabase', () => {
  it.each([
    ['postgres://user@host/db', true],
    ['postgresql://user@host/db', true],
    ['file:./local.db', false],
    ['libsql://example.turso.io', false],
    ['', false],
  ])('classifies %s', (url, expected) => {
    expect(isPostgresDatabase({ url })).toBe(expected);
    expect(isEmbeddedDatabase({ url })).toBe(!expected);
  });
});
