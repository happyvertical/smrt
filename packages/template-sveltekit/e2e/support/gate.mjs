#!/usr/bin/env node
/**
 * The M5 aggregate gate (#2579).
 *
 * Runs every completed M5 profile case and reports one verdict. Its whole
 * reason to exist is that a required check must not be able to pass by not
 * running: each case below is matched against the reporter's own output by
 * name, and a case that is missing, skipped, or todo fails the gate exactly
 * as loudly as one that failed.
 *
 * Usage: node e2e/support/gate.mjs [--skip-browser]
 *
 * Environment:
 *   SMRT_TEST_POSTGRES_URL  required; the PostgreSQL half cannot opt out.
 *
 * Output: a sanitized summary, written to `m5-gate-summary.json` beside this
 * package and echoed on stdout. Case ids and booleans only — no paths, no
 * messages, no payloads — so the summary is safe to upload.
 *
 * Child reporters write to stderr, never stdout. Vitest and Playwright emit
 * assertion text, absolute paths, and stack frames; if that shared stdout with
 * the summary, the uploaded artifact would carry all of it.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Every M5 profile/gate case this milestone claims to cover.
 *
 * `match` is tested against the full vitest test name. `dependsOn` records
 * the prerequisite issue that lands the case, so a red gate says which
 * dependency is outstanding instead of just "missing".
 */
const REQUIRED_VITEST_CASES = [
  {
    id: 'sqlite-file-backed-workload',
    profile: 'sqlite',
    match: /seeds ordinary owner, tenant, asset, and queued-workflow state on file-backed SQLite/i,
    dependsOn: '#2575',
  },
  {
    id: 'cross-profile-source-snapshot',
    profile: 'managed-cloud',
    match: /copies and generates one unchanged source tree for all supported profiles/i,
    dependsOn: '#2575',
  },
  {
    id: 'cross-profile-agent-surface',
    profile: 'managed-cloud',
    match: /emits the same declared agent surface under every runtime profile/i,
    dependsOn: '#2575',
  },
  {
    id: 'asset-manifest-portability',
    profile: 'sqlite',
    match: /round-trips the owner, tenant, record, association, bytes, and digest/i,
    dependsOn: '#2576',
  },
  {
    id: 'diagnostics-authorization',
    profile: 'sqlite',
    match: /fails unauthenticated, unauthorized member, and cross-tenant access/i,
    dependsOn: '#2577',
  },
  {
    id: 'cross-profile-generated-surface-parity',
    profile: 'managed-cloud',
    match: /emits one identical domain surface under local, self-hosted, and cloud/i,
    dependsOn: '#2578',
  },
  {
    id: 'cross-profile-policy-parity',
    profile: 'managed-cloud',
    match: /keeps every declared policy field identical while the infrastructure composition differs/i,
    dependsOn: '#2578',
  },
  {
    id: 'operational-exception-allowlist',
    profile: 'managed-cloud',
    match: /allows exactly one documented operational exception/i,
    dependsOn: '#2578',
  },
  {
    id: 'managed-cloud-configuration-snapshot',
    profile: 'managed-cloud',
    match: /validates the managed-cloud case as configuration only/i,
    dependsOn: '#2578',
  },
  {
    id: 'embedded-job-parity',
    profile: 'sqlite',
    match: /completes the same enqueued workflow under local embedded execution/i,
    dependsOn: '#2578',
  },
  {
    id: 'postgres-schema-portability',
    profile: 'postgres',
    match: /migrates the generated fixture schema on the disposable PostgreSQL service/i,
    dependsOn: '#2575',
  },
  {
    id: 'postgres-asset-portability',
    profile: 'postgres',
    match: /imports the same record, authorization links, association, and verified blob/i,
    dependsOn: '#2576',
  },
  {
    id: 'postgres-external-worker-job-parity',
    profile: 'postgres',
    match: /completes the same enqueued workflow with the same domain result/i,
    dependsOn: '#2578',
  },
];

/**
 * The browser half, held to the same standard as the vitest half.
 *
 * Playwright exits 0 when a test is skipped, renamed out of the spec glob, or
 * disabled by a conditional `test.skip()`, so an exit code alone would let the
 * one case this issue exists to add pass by not running.
 */
const REQUIRED_BROWSER_CASES = [
  {
    id: 'browser-startup-and-onboarding',
    match: /completes owner onboarding without exposing the bootstrap token/i,
  },
  {
    id: 'browser-process-identity',
    match: /proves process identity before the browser drives it/i,
  },
  {
    id: 'browser-clean-state-root',
    match: /starts from a clean temporary checkout copy and state root/i,
  },
  {
    id: 'browser-discovery-inventory',
    match: /registers the bounded domain inventory plus exactly one diagnostic tool/i,
  },
  {
    id: 'browser-boundary-isolation',
    match: /exposes the WebMCP boundary and nothing else to the page/i,
  },
  {
    id: 'browser-permitted-execution',
    match: /executes a permitted read as the page user and sees persisted state/i,
  },
  {
    id: 'browser-authenticated-diagnostics',
    match: /reads authenticated runtime diagnostics through the real route/i,
  },
  {
    id: 'browser-consent-boundary',
    match: /keeps non-read effects behind their declared consent boundary/i,
  },
  {
    id: 'browser-no-self-confirmation',
    match: /the harness never self-confirms on the user's behalf/i,
  },
  {
    id: 'browser-anonymous-fails-closed',
    match: /an anonymous context cannot read diagnostics or protected domain data/i,
  },
  {
    id: 'browser-forged-session-fails-closed',
    match: /a forged session fails closed at both boundaries and leaks nothing/i,
  },
  {
    id: 'browser-no-duplicate-registrations',
    match: /mount, navigation, and unmount leave no duplicate live registrations/i,
  },
  {
    id: 'browser-reload-resets-context',
    match: /a full page reload starts from an empty model context/i,
  },
  {
    id: 'browser-diagnostics-redaction',
    match: /captured diagnostics responses carry no prohibited fields/i,
  },
  {
    id: 'browser-failure-redaction',
    match: /runtime route failures return no server detail/i,
  },
  {
    id: 'browser-artifact-redaction',
    match: /retained Playwright artifacts pass the redaction corpus/i,
  },
];

/**
 * Each child's exit status.
 *
 * The named case tables cover 13 of the package's vitest tests and all 16
 * browser tests, but `test:m5` runs the package's whole suite. A failure
 * outside the named set — an unrelated test, a global teardown, an unhandled
 * rejection after results were reported — must not be swallowed by a verdict
 * computed only from the named cases.
 */
const exitStatuses = { vitest: null, playwright: null };

/** The one file CI uploads. Overwritten on every run. */
const SUMMARY_PATH = join(packageRoot, 'm5-gate-summary.json');

function fail(message) {
  process.stderr.write(`m5-gate: ${message}\n`);
  process.exitCode = 1;
}

/**
 * Emit the summary. Written to disk for the CI artifact and echoed on stdout,
 * which by construction has carried nothing else.
 */
function emit(summary) {
  // Structural guard, not a pattern scan: the summary may only ever contain
  // the fixed vocabulary below. Anything else — a message, a path, a
  // diagnostic — is a defect in this script, and failing here is cheaper than
  // discovering it in an uploaded artifact.
  const allowedStrings = new Set([
    'm5',
    ...REQUIRED_VITEST_CASES.map((entry) => entry.id),
    ...REQUIRED_VITEST_CASES.map((entry) => entry.profile),
    ...REQUIRED_BROWSER_CASES.map((entry) => entry.id),
    'postgres-service',
    'vitest-suite-exit',
    'browser-suite-exit',
    'sqlite',
  ]);
  for (const value of JSON.stringify(summary)
    .match(/"[^"]*"/g)
    ?.map((quoted) => quoted.slice(1, -1)) ?? []) {
    if (
      typeof value === 'string' &&
      !allowedStrings.has(value) &&
      !['schemaVersion', 'gate', 'cases', 'id', 'profile', 'passed', 'observed', 'skipped'].includes(
        value,
      )
    ) {
      throw new Error('m5-gate summary contains an unexpected value.');
    }
  }
  const text = `${JSON.stringify(summary, null, 2)}\n`;
  writeFileSync(SUMMARY_PATH, text, { mode: 0o600 });
  process.stdout.write(text);
}

function collectVitestCases() {
  const outputDirectory = mkdtempSync(join(tmpdir(), 'm5-gate-'));
  const outputFile = join(outputDirectory, 'vitest.json');
  try {
    const run = spawnSync(
      'pnpm',
      [
        'exec',
        'vitest',
        'run',
        // The PostgreSQL suites share one disposable database, so they must
        // not run beside each other or beside the SQLite suites.
        '--no-file-parallelism',
        // Human-readable failures go to stderr, which by design never reaches
        // the uploaded artifact — that is the file `emit()` writes. A gate
        // that reported only a case id would make a red merge group
        // undiagnosable without local reproduction.
        '--reporter=default',
        '--reporter=json',
        `--outputFile=${outputFile}`,
      ],
      // stdout to fd 2: the reporter is for a human reading the log, and
      // this process's stdout carries only the sanitized summary.
      { cwd: packageRoot, stdio: ['ignore', 2, 2] },
    );
    if (run.error) {
      throw new Error(`vitest could not be started: ${run.error.code ?? 'unknown'}`);
    }
    exitStatuses.vitest = run.status;
    const report = JSON.parse(readFileSync(outputFile, 'utf8'));
    return report.testResults.flatMap((file) =>
      file.assertionResults.map((assertion) => ({
        name: [...(assertion.ancestorTitles ?? []), assertion.title].join(' '),
        status: assertion.status,
      })),
    );
  } finally {
    rmSync(outputDirectory, { recursive: true, force: true });
  }
}

/**
 * Run the browser half and read its own reporter output, so a skipped or
 * renamed spec is observable rather than merely a zero exit code.
 */
function collectPlaywrightCases() {
  const outputDirectory = mkdtempSync(join(tmpdir(), 'm5-gate-browser-'));
  const outputFile = join(outputDirectory, 'playwright.json');
  try {
    const run = spawnSync(
      'pnpm',
      [
        'exec',
        'playwright',
        'test',
        '--config',
        'playwright.config.ts',
        // As above: `list` for the log, `json` for the machine verdict.
        '--reporter=list,json',
      ],
      {
        cwd: packageRoot,
        env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: outputFile },
        stdio: ['ignore', 2, 2],
      },
    );
    if (run.error) {
      throw new Error(
        `playwright could not be started: ${run.error.code ?? 'unknown'}`,
      );
    }
    exitStatuses.playwright = run.status;
    const report = JSON.parse(readFileSync(outputFile, 'utf8'));
    const cases = [];
    const walk = (suite) => {
      for (const spec of suite.specs ?? []) {
        for (const test of spec.tests ?? []) {
          cases.push({
            name: spec.title,
            // A spec with no result at all is a skip; Playwright records
            // `status: 'skipped'` on the result when it ran the decision.
            status: test.results?.at(-1)?.status ?? 'skipped',
          });
        }
      }
      for (const child of suite.suites ?? []) walk(child);
    };
    for (const suite of report.suites ?? []) walk(suite);
    return cases;
  } finally {
    rmSync(outputDirectory, { recursive: true, force: true });
  }
}

function main() {
  const skipBrowser = process.argv.includes('--skip-browser');
  const summary = { schemaVersion: 1, gate: 'm5', cases: [] };

  // `run-with-ci-postgres.mjs` creates and drops a uniquely named database
  // only when it was given a managed base URL. Its unmanaged fallback hands
  // through a developer's own `DATABASE_URL`, and the gate would then migrate
  // the M5 fixture schema into a real database and never drop it. Refuse.
  //
  // The wrapper stamps its own verdict into `CI_POSTGRES_MANAGED`. Do not
  // re-derive it here: `CI_POSTGRES_BASE_URL_FILE` pointing at a missing or
  // empty file is unmanaged to the wrapper, and any local reimplementation of
  // that rule is one refactor away from disagreeing with the component that
  // actually creates and drops the database.
  if (
    process.env.SMRT_TEST_POSTGRES_URL &&
    process.env.CI_POSTGRES_MANAGED !== '1'
  ) {
    fail(
      'Refusing an unmanaged PostgreSQL target. Set CI_POSTGRES_BASE_URL so a disposable database is created and dropped; DATABASE_URL alone would be migrated in place.',
    );
    summary.cases.push({ id: 'postgres-service', passed: false });
    summary.passed = false;
    emit(summary);
    return;
  }

  if (!process.env.SMRT_TEST_POSTGRES_URL) {
    fail(
      'SMRT_TEST_POSTGRES_URL is required. The PostgreSQL profile is part of the gate and cannot be skipped.',
    );
    summary.cases.push({ id: 'postgres-service', passed: false });
    summary.passed = false;
    emit(summary);
    return;
  }
  summary.cases.push({ id: 'postgres-service', passed: true });

  const observed = collectVitestCases();
  for (const required of REQUIRED_VITEST_CASES) {
    const matches = observed.filter((entry) => required.match.test(entry.name));
    const passed =
      matches.length > 0 && matches.every((entry) => entry.status === 'passed');
    summary.cases.push({
      id: required.id,
      profile: required.profile,
      passed,
      // Distinguishes "ran and failed" from "never ran", without echoing
      // any test output.
      observed: matches.length,
    });
    if (!passed) {
      fail(
        matches.length === 0
          ? `required case ${required.id} did not run (landed by ${required.dependsOn})`
          : `required case ${required.id} did not pass`,
      );
    }
  }

  if (skipBrowser) {
    for (const required of REQUIRED_BROWSER_CASES) {
      summary.cases.push({ id: required.id, passed: false, skipped: true });
    }
    fail('the browser cases were skipped explicitly; this is not a passing gate');
  } else {
    const observed = collectPlaywrightCases();
    for (const required of REQUIRED_BROWSER_CASES) {
      const matches = observed.filter((entry) => required.match.test(entry.name));
      const passed =
        matches.length > 0 &&
        matches.every((entry) => entry.status === 'passed');
      summary.cases.push({
        id: required.id,
        profile: 'sqlite',
        passed,
        observed: matches.length,
      });
      if (!passed) {
        fail(
          matches.length === 0
            ? `required browser case ${required.id} did not run`
            : `required browser case ${required.id} did not pass`,
        );
      }
    }
  }

  for (const [id, status] of [
    ['vitest-suite-exit', exitStatuses.vitest],
    ['browser-suite-exit', exitStatuses.playwright],
  ]) {
    if (status === null) continue;
    const passed = status === 0;
    summary.cases.push({ id, passed });
    if (!passed) {
      fail(`the ${id.replace('-exit', '')} run exited non-zero`);
    }
  }

  summary.passed = summary.cases.every((entry) => entry.passed);
  emit(summary);
}

main();
