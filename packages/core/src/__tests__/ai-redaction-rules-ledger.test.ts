/**
 * Core's built-in redaction rules carry a version, composed with
 * smrt-config's value rules version into the stamp a stored run event
 * envelope carries. A stored cut payload reads back as written only under the
 * same stamp, so the version must change whenever what the rules mask
 * changes.
 *
 * `redaction-rules-ledger.json` pins the rules' source (between the markers
 * in `ai-transcripts.ts`) and their output on a fixed corpus to each version.
 * The corpus runs the marked region on its own with smrt-config's value rules
 * replaced by the identity, so it measures core's rules only: a config rules
 * change bumps config's version (and so the stamp) without a core edit. A
 * change to either fails here until a row with a higher version is appended;
 * `pnpm check:redaction-ledgers` (CI: CI Control Plane Regression) refuses an
 * edit to any row the base branch already has.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  redactSecretValues,
  SECRET_VALUE_RULES_VERSION,
} from '@happyvertical/smrt-config';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  builtInRedactionStamp,
  CORE_REDACTION_RULES_VERSION,
  redactAiTranscriptMessages,
} from '../ai-transcripts';

interface LedgerRow {
  version: number;
  rulesDigest: string;
  corpusDigest: string;
}

const ledger = JSON.parse(
  readFileSync(
    new URL('../redaction-rules-ledger.json', import.meta.url),
    'utf8',
  ),
) as { rows: LedgerRow[] };

const BEGIN = '// built-in-redaction-rules:begin';
const END = '// built-in-redaction-rules:end';

function rulesRegion(source: string): string {
  const start = source.indexOf(BEGIN);
  const end = source.indexOf(END);
  if (start < 0 || end < start) throw new Error('rules markers not found');
  return source.slice(start, end + END.length);
}

const sha256 = (text: string) =>
  createHash('sha256').update(text, 'utf8').digest('hex');

const region = rulesRegion(
  readFileSync(new URL('../ai-transcripts.ts', import.meta.url), 'utf8'),
);

type Redactor = typeof redactAiTranscriptMessages;

/**
 * The marked region compiled on its own, with the given value rules in place
 * of smrt-config's: the region is self-contained apart from them, so a copy
 * with an edit shows what that edit does to the corpus.
 */
function compileRules(
  text: string,
  valueRules: (value: string) => string,
): Redactor {
  const js = ts.transpileModule(
    `${text}\nexports.rules = redactAiTranscriptMessages;`,
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    },
  ).outputText;
  const exports: { rules?: Redactor } = {};
  new Function('exports', 'redactSecretValues', js)(exports, valueRules);
  if (!exports.rules) throw new Error('rules did not compile');
  return exports.rules;
}

const identity = (value: string) => value;

const shared = { reused: true };
const cyclic: Record<string, unknown> = { name: 'loop' };
cyclic.self = cyclic;

/** Inputs covering field, structure, value and exact-value rules. */
const CORPUS: Array<{
  content: unknown;
  values?: Parameters<Redactor>[1];
}> = [
  { content: { apiKey: 'k', api_key: 'k', 'x-api-key': 'k', note: 'kept' } },
  { content: { Authorization: 'a', password: 'p', passwd: 'p', secret: 's' } },
  {
    content: {
      client_secret: 'c',
      accessToken: 't',
      refresh_token: 'r',
      privateKey: 'p',
    },
  },
  { content: { apiKey: null, password: undefined, token: 'not a field rule' } },
  { content: { outer: { inner: [{ password: 'deep' }, { ok: 1 }] } } },
  { content: { args: '{"password":"in-string","user":"u"}' } },
  { content: { args: '[{"apiKey":"in-array-string"}]' } },
  { content: { args: '{"broken": ' } },
  {
    content: {
      dsn: 'postgres://user:hunter2@db/app',
      text: 'Bearer abcdefghijklmnopqrstu',
    },
  },
  { content: { note: 'sk-abcdefghijklmnopqrstuvwxyz AKIAABCDEFGHIJKLMNOP' } },
  {
    // A 20-digit number rounds when parsed; matched as the same double.
    content: { pin: 4821, card: Number('12345678901234567890'), n: 7 },
    values: { sensitive: [{ field: 'card', value: '12345678901234567890' }] },
  },
  {
    content: { pin: 4821, n: 7 },
    values: { sensitive: [{ field: 'pin', value: '4821' }] },
  },
  {
    // At the exact-value threshold: a four-character value inside a word.
    content: { text: 'codeWXYZtail, WXYZ, and abcWXY' },
    values: { sensitive: [{ field: 'code', value: 'WXYZ' }] },
  },
  {
    content: { text: 'my code is 123 and abc123' },
    values: { secrets: ['123'] },
  },
  {
    content: { blob: { a: 1, b: [2] } },
    values: { sensitive: [{ field: 'blob', value: '{"a":1,"b":[2]}' }] },
  },
  {
    content: { long: 'contains customer-code-77 twice customer-code-77' },
    values: { sensitive: [{ field: 'code', value: 'customer-code-77' }] },
  },
  {
    content: {
      bytes: new Uint8Array([1, 2, 3]),
      shared,
      again: shared,
      cyclic,
    },
  },
  {
    content: JSON.parse(
      '{"__proto__":{"polluted":true},"constructor":"x","normal":"y"}',
    ),
  },
  { content: 'a plain string with sk-abcdefghijklmnopqrstuvwxyz' },
  { content: ['array', { secret: 'top-level array' }] },
];

const corpusOutput = (redact: Redactor) =>
  CORPUS.map(({ content, values }) =>
    redact([{ role: 'event', content }], values),
  );

const corpusDigest = (redact: Redactor) =>
  sha256(JSON.stringify(corpusOutput(redact)));

describe('built-in redaction rules version', () => {
  it('composes the stamp from core and config rules versions', () => {
    expect(Number.isSafeInteger(CORE_REDACTION_RULES_VERSION)).toBe(true);
    expect(SECRET_VALUE_RULES_VERSION).toBeGreaterThanOrEqual(1);
    expect(SECRET_VALUE_RULES_VERSION).toBeLessThanOrEqual(999);
    expect(builtInRedactionStamp()).toBe(
      CORE_REDACTION_RULES_VERSION * 1000 + SECRET_VALUE_RULES_VERSION,
    );
  });

  it('compiles the marked region to the built-in redactor', () => {
    expect(corpusOutput(compileRules(region, redactSecretValues))).toEqual(
      corpusOutput(redactAiTranscriptMessages),
    );
  });

  it('matches the last ledger row, whose version is the current one', () => {
    const versions = ledger.rows.map((row) => row.version);
    for (let i = 1; i < versions.length; i++) {
      expect(versions[i]).toBeGreaterThan(versions[i - 1] as number);
    }
    const last = ledger.rows.at(-1) as LedgerRow;
    expect(last.version).toBe(CORE_REDACTION_RULES_VERSION);
    expect({
      rulesDigest: sha256(region),
      corpusDigest: corpusDigest(compileRules(region, identity)),
    }).toEqual({
      rulesDigest: last.rulesDigest,
      corpusDigest: last.corpusDigest,
    });
  });

  it('changes the corpus output when a rule changes, patterns included or not', () => {
    const current = corpusDigest(compileRules(region, identity));
    const edits: Array<[string, string]> = [
      // Structure: a credential-named field holding null.
      [
        'SECRET_FIELD.test(key) && item !== null && item !== undefined',
        'SECRET_FIELD.test(key) && item !== undefined',
      ],
      // The exact-value threshold.
      ['MIN_SENSITIVE_VALUE_LENGTH = 4', 'MIN_SENSITIVE_VALUE_LENGTH = 5'],
      // A field name.
      ['password|passwd|', 'password|'],
      // Embedded JSON.
      [
        "if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return undefined;",
        "if (!trimmed.startsWith('{')) return undefined;",
      ],
    ];
    for (const [from, to] of edits) {
      expect(region).toContain(from);
      const edited = compileRules(region.replace(from, to), identity);
      expect(corpusDigest(edited)).not.toBe(current);
    }
  });

  it('keeps smrt-config value rules out of the core corpus digest', () => {
    // The corpus does reach the value rules (their output differs), but the
    // ledger digest runs the identity in their place, so a config-only rule
    // change bumps config's version and the stamp, not core's ledger.
    expect(corpusDigest(compileRules(region, redactSecretValues))).not.toBe(
      corpusDigest(compileRules(region, identity)),
    );
  });
});
