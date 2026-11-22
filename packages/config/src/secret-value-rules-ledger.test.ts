/**
 * The value rules behind `redactSecretValues()` carry a version
 * (`SECRET_VALUE_RULES_VERSION`). Core stamps what it stored with it and reads
 * stored text back as written only under the same version, so the version
 * must change whenever what the rules mask changes.
 *
 * `secret-value-rules-ledger.json` pins the rules' source (between the
 * markers in `export.ts`) and their output on a fixed corpus to each version.
 * A change to either fails here until a row with a higher version is
 * appended; `pnpm check:redaction-ledgers` (CI: CI Control Plane Regression)
 * refuses an edit to any row the base branch already has.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { redactSecretValues, SECRET_VALUE_RULES_VERSION } from './index.js';

interface LedgerRow {
  version: number;
  rulesDigest: string;
  corpusDigest: string;
}

const ledger = JSON.parse(
  readFileSync(
    new URL('./secret-value-rules-ledger.json', import.meta.url),
    'utf8',
  ),
) as { rows: LedgerRow[] };

const BEGIN = '// secret-value-rules:begin';
const END = '// secret-value-rules:end';

function rulesRegion(source: string): string {
  const start = source.indexOf(BEGIN);
  const end = source.indexOf(END);
  if (start < 0 || end < start) throw new Error('rules markers not found');
  return source.slice(start, end + END.length);
}

const sha256 = (text: string) =>
  createHash('sha256').update(text, 'utf8').digest('hex');

const region = rulesRegion(
  readFileSync(new URL('./export.ts', import.meta.url), 'utf8'),
);

/**
 * The marked region compiled on its own: the rules are self-contained, so a
 * copy of the region with an edit shows what that edit does to the corpus.
 */
function compileRules(text: string): (value: string) => string {
  const js = ts.transpileModule(
    `${text}\nexports.rules = redactValueSecrets;`,
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    },
  ).outputText;
  const exports: { rules?: (value: string) => string } = {};
  new Function('exports', js)(exports);
  if (!exports.rules) throw new Error('rules did not compile');
  return exports.rules;
}

/** Inputs covering every rule at its edges, and text no rule may touch. */
const CORPUS = [
  'postgres://user:hunter2@db.example:5432/app',
  'git+ssh://deploy:token@git.example/repo',
  'see https://a:b@x.example and ftp://c:d@y.example/path',
  'https://example.com/no-credentials',
  `-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----`,
  '-----BEGIN PRIVATE KEY----- unterminated',
  'key sk-abcdefghijklmnopqrstuvwxyz and sk-proj-ABCDEFGHIJKLMNOP1234',
  'exactly sixteen sk-abcdefghijklmnop and fifteen sk-abcdefghijklmno',
  'sk-ant-api03-abcdefghijklmnop',
  'sk_live_abcdefghijklmnop1234 rk_test_ABCDEFGHIJKLMNOP',
  'ghp_abcdefghijklmnopqrstuvwxyz gho_ABCDEFGHIJKLMNOPQRST1234',
  'github_pat_abcdefghijklmnopqrstuv_wxyz',
  'xoxb-1234567890-abcdef',
  'AIzaSyA-abcdefghijklmnopqrstuvwxyz012345',
  'AKIAABCDEFGHIJKLMNOP and ASIA1234567890ABCDEF',
  'Authorization: Bearer abcdefghijklmnop.qrstuvwxyz',
  'bearer abcdefghijklmnopqrst',
  'short sk-abc ghp_short AKIA123',
  'plain prose with no secrets, 1234 5678',
  '',
];

const corpusDigest = (rules: (value: string) => string) =>
  sha256(JSON.stringify(CORPUS.map(rules)));

describe('secret value rules version', () => {
  it('is a safe integer core can compose into its stamp', () => {
    expect(Number.isSafeInteger(SECRET_VALUE_RULES_VERSION)).toBe(true);
    expect(SECRET_VALUE_RULES_VERSION).toBeGreaterThanOrEqual(1);
    expect(SECRET_VALUE_RULES_VERSION).toBeLessThanOrEqual(999);
  });

  it('compiles the marked region to the exported rules', () => {
    expect(CORPUS.map(compileRules(region))).toEqual(
      CORPUS.map(redactSecretValues),
    );
  });

  it('matches the last ledger row, whose version is the current one', () => {
    const versions = ledger.rows.map((row) => row.version);
    for (let i = 1; i < versions.length; i++) {
      expect(versions[i]).toBeGreaterThan(versions[i - 1] as number);
    }
    const last = ledger.rows.at(-1) as LedgerRow;
    expect(last.version).toBe(SECRET_VALUE_RULES_VERSION);
    expect({
      rulesDigest: sha256(region),
      corpusDigest: corpusDigest(redactSecretValues),
    }).toEqual({
      rulesDigest: last.rulesDigest,
      corpusDigest: last.corpusDigest,
    });
  });

  it('changes the corpus output when a rule changes', () => {
    const current = corpusDigest(redactSecretValues);
    const edits: Array<[string, string]> = [
      [
        'sk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}',
        'sk-(?:proj-|ant-)?[A-Za-z0-9_-]{17,}',
      ],
      ['[^/?#@\\s]+@', '[^/?#@\\s:]+@'],
      ['[A-Za-z0-9._~+/=-]{16,}/gi', '[A-Za-z0-9._~+/=-]{16,}/g'],
    ];
    for (const [from, to] of edits) {
      expect(region).toContain(from);
      const edited = compileRules(region.replace(from, to));
      expect(corpusDigest(edited)).not.toBe(current);
    }
  });
});
