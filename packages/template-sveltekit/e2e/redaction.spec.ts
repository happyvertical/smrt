/**
 * Redaction corpus.
 *
 * Everything this gate could publish — captured responses and whatever
 * Playwright leaves in its output directory — is scanned for the categories
 * the M5 milestone forbids. The corpus is deliberately built from *this run's*
 * real values (this app's temporary paths, this run's bootstrap token) rather
 * than from generic patterns, so a leak cannot pass by being unusual.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve, sep } from 'node:path';

import { expect, test } from './fixtures.js';
import { packageRoot } from './support/referenceApp.js';

/** The monorepo checkout root; no gate output may live under it. */
const repositoryRoot = resolve(packageRoot, '..', '..');

test.describe.configure({ mode: 'serial' });

/** Fields the diagnostics contract must never carry to a caller. */
const PROHIBITED_DIAGNOSTIC_FIELDS = [
  'databaseUrl',
  'connectionString',
  'dataDirectory',
  'stateRoot',
  'secret',
  'secrets',
  'token',
  'tokenHash',
  'passwordHash',
  'sessionId',
  'stack',
  'cookies',
  'headers',
  'env',
];

/** Shapes that must never appear anywhere, regardless of field name. */
const PROHIBITED_PATTERNS: readonly [string, RegExp][] = [
  ['a database URL', /\b(postgres(ql)?|mysql|mongodb):\/\//i],
  [
    'an absolute POSIX path',
    /(^|["'\s:])\/(Users|home|var|private|root|tmp)\//,
  ],
  ['a Windows path', /[A-Z]:(\\\\|\\)(Users|Windows)/i],
  ['a stack frame', /\n\s+at\s+\S+\s+\(/],
  ['a bearer credential', /\bBearer\s+[A-Za-z0-9._-]{8,}/],
];

/**
 * Content digests are a legitimate part of the diagnostics allowlist (the
 * tool-inventory digest is how a caller detects surface drift without being
 * told the surface). A long hex run is therefore only suspicious where a
 * digest field is not what produced it.
 */
const HEX_RUN = /\b[a-f0-9]{40,}\b/gi;

/**
 * Every candidate is scanned twice: as received, and — when it is JSON — with
 * its string values decoded. A stack frame inside a JSON string is the
 * two-character escape `\n`, which a pattern anchored on a real newline can
 * never match, so scanning only the raw body would make the stack-frame rule
 * unfireable on exactly the payloads it is pointed at.
 */
function scanTargets(text: string): string[] {
  const targets = [text];
  try {
    const decoded = JSON.parse(text) as unknown;
    const values: string[] = [];
    const walk = (value: unknown): void => {
      if (typeof value === 'string') values.push(value);
      else if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object') {
        Object.values(value).forEach(walk);
      }
    };
    walk(decoded);
    targets.push(values.join('\n'));
  } catch {
    // Not JSON; the raw scan is the whole scan.
  }
  return targets;
}

function assertClean(
  label: string,
  text: string,
  extra: string[],
  allowedDigests: readonly string[] = [],
): void {
  for (const match of text.match(HEX_RUN) ?? []) {
    expect(
      allowedDigests.includes(match),
      `${label} contains an undeclared hex secret`,
    ).toBe(true);
  }
  for (const target of scanTargets(text)) {
    for (const [description, pattern] of PROHIBITED_PATTERNS) {
      expect(pattern.test(target), `${label} contains ${description}`).toBe(
        false,
      );
    }
  }
  for (const value of extra) {
    expect(text.includes(value), `${label} contains a run-specific secret`).toBe(
      false,
    );
  }
}

test('captured diagnostics responses carry no prohibited fields', async ({
  ownerPage,
  referenceApp,
}) => {
  await ownerPage.goto('/', { waitUntil: 'networkidle' });
  const raw = await ownerPage.evaluate(() =>
    window.__m5ModelContext!.execute('smrt.runtime.diagnostics.read'),
  );

  const diagnostics = JSON.parse(raw) as Record<string, unknown>;
  const keys = new Set<string>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (value && typeof value === 'object') {
      for (const [key, nested] of Object.entries(value)) {
        keys.add(key);
        walk(nested);
      }
    }
  };
  walk(diagnostics);
  for (const field of PROHIBITED_DIAGNOSTIC_FIELDS) {
    expect([...keys], `diagnostics exposes ${field}`).not.toContain(field);
  }

  // The one long hex value the projection is allowed to carry.
  const toolDigest = (diagnostics.tools as { digest?: string } | undefined)
    ?.digest;
  expect(typeof toolDigest).toBe('string');

  assertClean(
    'the diagnostics projection',
    raw,
    [
      referenceApp.temporaryRoot,
      referenceApp.appRoot,
      referenceApp.dataRoot,
      referenceApp.stateRoot,
      referenceApp.bootstrapToken,
    ],
    [toolDigest!],
  );
});

test('runtime route failures return no server detail', async ({
  ownerPage,
  referenceApp,
}) => {
  // Scope: the runtime namespace's own JSON contract. SvelteKit's HTML
  // fallback page is deliberately excluded — under `vite dev` it embeds
  // module URLs from the app root by design, and this gate serves the app in
  // dev mode so the browser sees real, unbundled sources. What must hold is
  // that the API contract itself never turns a server failure into detail.
  for (const probe of [
    () =>
      ownerPage.request.post(
        `${referenceApp.baseURL}/api/_runtime/diagnostics`,
        { data: {}, failOnStatusCode: false },
      ),
    () =>
      ownerPage.request.get(
        `${referenceApp.baseURL}/api/_runtime/diagnostics/not-a-route`,
        { failOnStatusCode: false },
      ),
    () =>
      ownerPage.request.get(`${referenceApp.baseURL}/api/items/not-a-row`, {
        failOnStatusCode: false,
      }),
  ]) {
    const response = await probe();
    expect(response.ok()).toBe(false);
    if (!(response.headers()['content-type'] ?? '').includes('json')) continue;
    const text = await response.text();
    for (const target of scanTargets(text)) {
      for (const [description, pattern] of PROHIBITED_PATTERNS) {
        expect(
          pattern.test(target),
          `a runtime route failure exposes ${description}`,
        ).toBe(false);
      }
    }
    expect(text).not.toContain(referenceApp.temporaryRoot);
    expect(text.length).toBeLessThan(512);
  }
});

test('retained Playwright artifacts pass the redaction corpus', async ({
  referenceApp,
}) => {
  // Whatever `playwright.config.ts` resolved, not a path restated here: the
  // scan has to cover the directory Playwright actually writes to.
  const artifactRoot = test.info().project.outputDir;
  // M5 requires generated output to stay outside the checkout, and a
  // `.gitignore` entry is not custody. Assert the location, not just the
  // contents.
  expect(artifactRoot.startsWith(`${packageRoot}${sep}`)).toBe(false);
  expect(artifactRoot.startsWith(`${repositoryRoot}${sep}`)).toBe(false);
  // The harness parses and validates the token once, so no call site can
  // degrade to searching for the literal string "null".
  const token = referenceApp.bootstrapToken;
  expect(token).toBeTruthy();
  // Traces, videos and screenshots are off, so in the steady state Playwright
  // writes nothing here and the scan below would never execute. Plant one
  // known-clean file so the scanner — its JSON decoding, its path and stack
  // patterns, its binary-extension rule — is exercised on every run rather
  // than only on the runs where something already went wrong.
  mkdirSync(artifactRoot, { recursive: true });
  writeFileSync(
    join(artifactRoot, 'redaction-corpus-sentinel.json'),
    `${JSON.stringify({ schemaVersion: 1, gate: 'm5', sentinel: true })}\n`,
  );
  const entries = readdirSync(artifactRoot, {
    recursive: true,
    encoding: 'utf8',
  });
  // The sentinel guarantees the loop body runs at least once.
  expect(entries).toContain('redaction-corpus-sentinel.json');
  for (const entry of entries) {
    const path = join(artifactRoot, entry);
    if (!statSync(path).isFile()) continue;
    // A binary artifact (video, zip) cannot be scanned and must not be
    // retained by this gate at all.
    expect(
      /\.(zip|webm|png|jpeg|jpg|db|sqlite)$/i.test(entry),
      'this gate retains no binary artifacts',
    ).toBe(false);
    assertClean(`artifact ${entry}`, readFileSync(path, 'utf8'), [
      token,
      referenceApp.temporaryRoot,
    ]);
  }
});
