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
// The one session-level setting: the claim's own connection (`claimApp`, a
// pool of one never shared with the broker) ends a quiet session (#5486).
const CLAIM_IDLE_LIMIT =
  /await raw\.query\(`SELECT set_config\('idle_session_timeout', \?, false\)`/g;
const scanned = (s: string) => code(s).replace(CLAIM_IDLE_LIMIT, '');

describe('engine/db issues only transaction-local state', () => {
  it('no set_config(..., false)', () => {
    for (const [f, s] of sources)
      expect(scanned(s), f).not.toMatch(/set_config\([^)]*,\s*false\s*\)/);
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

  it('the claim connection sets exactly one session-level value, its idle limit', () => {
    const hits = sources.flatMap(([f, s]) =>
      code(s).match(CLAIM_IDLE_LIMIT) ? [f] : [],
    );
    expect(hits).toEqual(['postgres.ts']);
  });

  it('the broker is the one place the role is switched', () => {
    const switching = sources.filter(([, s]) => /SET LOCAL ROLE/.test(code(s)));
    expect(switching.map(([f]) => f)).toEqual(['broker.ts']);
  });
});
