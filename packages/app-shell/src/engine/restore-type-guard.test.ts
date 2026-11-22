// restoreDump interpolates each dumped column type into `CAST(? AS <type>)`
// (#5188): only a plain `format_type` result may pass.

import { describe, expect, it } from 'vitest';
import { assertColumnType } from './db/postgres-copy.ts';

describe('restore replay column type guard', () => {
  it.each([
    'text',
    'integer',
    'bigint',
    'character varying(255)',
    'numeric(10,2)',
    'numeric(10, 2)',
    'timestamp with time zone',
    'timestamp(3) with time zone',
    'text[]',
    'integer[3]',
    '"char"',
    'public.citext',
    '"MySchema"."Kind"',
    'double precision',
  ])('accepts %s', (t) => {
    expect(assertColumnType(t)).toBe(t);
  });

  it.each([
    'text) ; DROP SCHEMA app CASCADE; --',
    "text'",
    'text; select 1',
    'integer) , (SELECT 1',
    'text -- x',
    'text /* x */',
    '',
    'a'.repeat(200),
    'text\n)',
  ])('refuses %j', (t) => {
    expect(() => assertColumnType(t)).toThrow(/column type/);
  });

  it('refuses a non-string', () => {
    expect(() => assertColumnType(undefined)).toThrow(/column type/);
    expect(() => assertColumnType({ toString: () => 'text' })).toThrow(
      /column type/,
    );
  });
});
