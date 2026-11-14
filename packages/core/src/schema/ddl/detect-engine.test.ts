import { describe, expect, it } from 'vitest';
import { detectEngine } from './index.js';

describe('detectEngine', () => {
  it.each([
    ['postgres', 'postgres'],
    ['postgresql', 'postgres'],
    ['pg', 'postgres'],
    // PGlite is PostgreSQL in process; its url is a data directory (#4934).
    ['pglite', 'postgres'],
    ['sqlite', 'sqlite'],
    ['duckdb', 'duckdb'],
  ])('reads the %s type as %s whatever the url looks like', (type, engine) => {
    expect(detectEngine('/tmp/some-dir/data', type)).toBe(engine);
  });

  it('falls back to the url without a type', () => {
    expect(detectEngine('postgresql://host/db')).toBe('postgres');
    expect(detectEngine('/tmp/data.db')).toBe('sqlite');
  });
});
