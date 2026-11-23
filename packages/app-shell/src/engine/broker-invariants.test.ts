// Source invariants of the broker (#5188): everything it writes into a
// connection is transaction-local and role changes are `SET LOCAL ROLE` only,
// so nothing can outlive the operation on a pooled connection.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const dbDir = join(dirname(fileURLToPath(import.meta.url)), 'db');
const sources = readdirSync(dbDir)
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
  .map((f) => [f, readFileSync(join(dbDir, f), 'utf8')] as const);
// Strip comments so prose that names a forbidden form does not trip the scan.
const code = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('engine/db issues only transaction-local state', () => {
  it('no set_config(..., false)', () => {
    for (const [f, s] of sources)
      expect(code(s), f).not.toMatch(/set_config\([^)]*,\s*false\s*\)/);
  });

  it('no session-level SET, and ROLE only as SET LOCAL ROLE', () => {
    for (const [f, s] of sources) {
      const c = code(s);
      expect(c, f).not.toMatch(/['"`]\s*SET\s+(?!LOCAL\b)/i);
      expect(c, f).not.toMatch(/SET\s+ROLE\b/i);
      expect(c, f).not.toMatch(/SET\s+SESSION\b/i);
      expect(c, f).not.toMatch(/\bRESET\s+ROLE\b/i);
    }
  });

  it('the broker is the one place the role is switched', () => {
    const switching = sources.filter(([, s]) => /SET LOCAL ROLE/.test(code(s)));
    expect(switching.map(([f]) => f)).toEqual(['broker.ts']);
  });
});
