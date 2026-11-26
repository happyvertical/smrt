#!/usr/bin/env node
/**
 * The M5 aggregate gate (#2579), split into parallel parts (#5694).
 *
 * Runs every completed M5 profile case and reports one verdict. Its whole
 * reason to exist is that a required check must not be able to pass by not
 * running: each case is matched against the reporter's own output by name, and
 * a case that is missing, skipped, or todo fails the gate exactly as loudly as
 * one that failed. What must run, and the verdict over what did, live in
 * `gateSpec.mjs`; this file only runs things.
 *
 * Usage:
 *   node e2e/support/gate.mjs [--skip-browser]
 *       Every part in sequence, then the verdict. This is `pnpm test:m5`.
 *   node e2e/support/gate.mjs part <id> [--skip-browser]
 *       One part (`template-1|2|3`, `postgres`, `browser`) into
 *       `m5-part-<id>.json`. CI runs the parts as parallel jobs. Never run two
 *       parts concurrently in one checkout: the vitest global setup writes and
 *       then removes `template/.svelte-kit/`.
 *   node e2e/support/gate.mjs verdict --parts-dir <dir> --expected-parts <n>
 *       --template <result> --postgres <result> --browser <result> [--out <file>]
 *       The verdict over the downloaded part results, from a bare checkout
 *       (node built-ins only, no install). `<result>` is the CI
 *       `needs.<job>.result` of that job group.
 *
 * Environment:
 *   SMRT_TEST_POSTGRES_URL  required by the `postgres` part; it cannot opt out.
 *
 * Output: a sanitized summary, written to `m5-gate-summary.json` beside this
 * package and echoed on stdout (parts write `m5-part-<id>.json`). Case ids,
 * booleans, counts and relative test file names only — no paths, no messages,
 * no payloads — so the file is safe to upload.
 *
 * Child reporters write to stderr, never stdout. Vitest and Playwright emit
 * assertion text, absolute paths, and stack frames; if that shared stdout with
 * the summary, the uploaded artifact would carry all of it.
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  evaluateBrowserCases,
  evaluateGate,
  evaluateVitestCases,
  listTemplateTestFiles,
  NEEDS_GROUPS,
  OWNING_PACKAGE_FILES,
  PARTS,
  partSuites,
  POSTGRES_FILES,
  SCHEMA_VERSION,
  templateShardFiles,
  vocabularyViolations,
} from './gateSpec.mjs';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const packagesRoot = resolve(packageRoot, '..');

/** The one file CI uploads from the aggregator. Overwritten on every run. */
const SUMMARY_PATH = join(packageRoot, 'm5-gate-summary.json');

const partPath = (id) => join(packageRoot, `m5-part-${id}.json`);

function fail(message) {
  process.stderr.write(`m5-gate: ${message}\n`);
  process.exitCode = 1;
}

/** Write one sanitized JSON document, after the vocabulary guard. */
function emit(path, document) {
  if (vocabularyViolations(document).length > 0) {
    throw new Error('m5-gate output contains an unexpected value.');
  }
  const text = `${JSON.stringify(document, null, 2)}\n`;
  writeFileSync(path, text, { mode: 0o600 });
  process.stdout.write(text);
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

/**
 * Where vitest cases run, per part. Template files named
 * `*.postgres.optional.test.ts` share one disposable database, so they run one
 * at a time, in the `postgres` part. Every other template file opens its own
 * SQLite database and runs two at a time: one at a time took 18 of the old
 * single job's 25 minutes (#5045). Two workers alone on a runner is the shape
 * the package's dedicated `test` shard already runs; more starves the SQLite
 * onboarding cases into SQLITE_PROTOCOL (#4990). A test that connects to the
 * PostgreSQL database must carry the `.postgres.optional` name.
 */
function vitestRuns(partId) {
  if (partId === 'postgres') {
    return [
      {
        id: 'template',
        cwd: packageRoot,
        args: ['--no-file-parallelism', POSTGRES_FILES],
      },
      {
        id: 'cli',
        cwd: join(packagesRoot, 'cli'),
        args: ['--no-file-parallelism', OWNING_PACKAGE_FILES.cli],
      },
      {
        id: 'app-runtime',
        cwd: join(packagesRoot, 'app-runtime'),
        args: ['--no-file-parallelism', OWNING_PACKAGE_FILES['app-runtime']],
      },
    ];
  }
  const all = listTemplateTestFiles(packageRoot);
  const mine = templateShardFiles(partId, all);
  const named = partId !== 'template-3';
  return [
    {
      id: 'template',
      cwd: packageRoot,
      args: [
        '--file-parallelism',
        '--maxWorkers=2',
        // Positional filters are substring matches; every named file is
        // unique, and the verdict proves the union against the include glob.
        ...(named
          ? mine
          : [
              `--exclude=**/*${POSTGRES_FILES}`,
              ...all
                .filter((file) => !file.endsWith(POSTGRES_FILES))
                .filter((file) => !mine.includes(file))
                .map((file) => `--exclude=**/${file}`),
            ]),
      ],
    },
  ];
}

/** Run one vitest invocation; its names and statuses stay in memory. */
function runVitest(run, exits) {
  const outputDirectory = mkdtempSync(join(tmpdir(), 'm5-gate-'));
  const outputFile = join(outputDirectory, 'vitest.json');
  try {
    const result = spawnSync(
      'pnpm',
      [
        'exec',
        'vitest',
        'run',
        // Human-readable failures go to stderr, which by design never reaches
        // the uploaded artifact. A gate that reported only a case id would make
        // a red merge group undiagnosable without local reproduction.
        '--reporter=default',
        '--reporter=json',
        `--outputFile=${outputFile}`,
        ...run.args,
      ],
      // stdout to fd 2: the reporter is for a human reading the log, and this
      // process's stdout carries only the sanitized summary.
      { cwd: run.cwd, stdio: ['ignore', 2, 2] },
    );
    if (result.error) {
      throw new Error(
        `vitest could not be started: ${result.error.code ?? 'unknown'}`,
      );
    }
    if (exits.vitest === undefined || exits.vitest === 0) {
      exits.vitest = result.status;
    }
    const report = JSON.parse(readFileSync(outputFile, 'utf8'));
    return report.testResults.map((file) => {
      const assertions = file.assertionResults ?? [];
      const name = relative(run.cwd, file.name).split(sep).join('/');
      return {
        file: name,
        suite: run.id,
        passed: assertions.filter((entry) => entry.status === 'passed').length,
        failed: assertions.filter((entry) => entry.status === 'failed').length,
        tests: assertions.map((assertion) => ({
          name: [...(assertion.ancestorTitles ?? []), assertion.title].join(' '),
          status: assertion.status,
          suite: run.id,
        })),
      };
    });
  } finally {
    rmSync(outputDirectory, { recursive: true, force: true });
  }
}

/**
 * The part's fresh Playwright output root, so two runs on one machine never
 * share (or empty) each other's directory. Matches `playwright.config.ts`.
 */
function runPlaywright(partId, exits) {
  const outputDirectory = mkdtempSync(join(tmpdir(), 'm5-gate-browser-'));
  const outputFile = join(outputDirectory, 'playwright.json');
  try {
    const result = spawnSync(
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
        env: {
          ...process.env,
          PLAYWRIGHT_JSON_OUTPUT_NAME: outputFile,
          SMRT_M5_PART: partId,
        },
        stdio: ['ignore', 2, 2],
      },
    );
    if (result.error) {
      throw new Error(
        `playwright could not be started: ${result.error.code ?? 'unknown'}`,
      );
    }
    exits.playwright = result.status;
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

/**
 * `run-with-ci-postgres.mjs` creates and drops a uniquely named database only
 * when it was given a managed base URL. Its unmanaged fallback hands through a
 * developer's own `DATABASE_URL`, and the gate would then migrate the M5
 * fixture schema into a real database and never drop it. Refuse.
 *
 * The wrapper stamps its own verdict into `CI_POSTGRES_MANAGED`. Do not
 * re-derive it here: `CI_POSTGRES_BASE_URL_FILE` pointing at a missing or
 * empty file is unmanaged to the wrapper, and any local reimplementation of
 * that rule is one refactor away from disagreeing with the component that
 * actually creates and drops the database.
 */
function postgresServiceProblem() {
  if (
    process.env.SMRT_TEST_POSTGRES_URL &&
    process.env.CI_POSTGRES_MANAGED !== '1'
  ) {
    return 'Refusing an unmanaged PostgreSQL target. Set CI_POSTGRES_BASE_URL so a disposable database is created and dropped; DATABASE_URL alone would be migrated in place.';
  }
  if (!process.env.SMRT_TEST_POSTGRES_URL) {
    return 'SMRT_TEST_POSTGRES_URL is required. The PostgreSQL profile is part of the gate and cannot be skipped.';
  }
  return null;
}

/** Run one part and return its sanitized result. */
function runPart(partId, { skipBrowser = false } = {}) {
  const definition = PARTS.find((entry) => entry.id === partId);
  if (!definition) {
    throw new Error(
      `unknown part ${JSON.stringify(partId)}; expected one of ${PARTS.map((entry) => entry.id).join(', ')}`,
    );
  }
  const result = {
    schemaVersion: SCHEMA_VERSION,
    gate: 'm5',
    part: partId,
    exits: {},
    cases: [],
    files: [],
  };

  if (definition.kind === 'browser') {
    if (skipBrowser) {
      for (const entry of evaluateBrowserCases([])) {
        result.cases.push({ id: entry.id, passed: false, skipped: true });
      }
      fail('the browser cases were skipped explicitly; this is not a passing gate');
      result.exits.playwright = 1;
      return result;
    }
    result.cases.push(...evaluateBrowserCases(runPlaywright(partId, result.exits)));
    return result;
  }

  if (partId === 'postgres') {
    const problem = postgresServiceProblem();
    if (problem) {
      fail(problem);
      result.cases.push({ id: 'postgres-service', passed: false });
      result.exits.vitest = 1;
      return result;
    }
    result.cases.push({ id: 'postgres-service', passed: true });
  }

  const observed = [];
  for (const run of vitestRuns(partId)) {
    for (const file of runVitest(run, result.exits)) {
      observed.push(...file.tests);
      result.files.push({
        file: file.file,
        suite: file.suite,
        tests: file.tests.length,
        passed: file.passed,
        failed: file.failed,
      });
    }
  }
  result.cases.push(...evaluateVitestCases(observed, partSuites(partId)));
  return result;
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

function finish(partResults, loadProblems, needs, expectedPartCount, out = SUMMARY_PATH) {
  const verdict = evaluateGate({
    parts: partResults,
    loadProblems,
    needs,
    expectedFiles: listTemplateTestFiles(packageRoot),
    expectedPartCount,
  });
  for (const message of verdict.failures) fail(message);
  emit(out, verdict.summary);
  if (!verdict.passed) process.exitCode = 1;
}

/** Every `m5-part-*.json` below `directory`, one per downloaded artifact. */
function loadPartResults(directory) {
  const parts = [];
  const problems = [];
  if (!existsSync(directory) || !statSync(directory).isDirectory()) {
    return { parts, problems: ['the part results directory does not exist'] };
  }
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (/^m5-part-.*\.json$/.test(entry.name)) {
        try {
          const text = readFileSync(path, 'utf8');
          if (text.trim() === '') {
            problems.push('a part result file is empty');
            continue;
          }
          parts.push(JSON.parse(text));
        } catch {
          problems.push('a part result file is not valid JSON');
        }
      }
    }
  };
  walk(directory);
  return { parts, problems };
}

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function main() {
  const [command, argument] = process.argv.slice(2);
  const skipBrowser = process.argv.includes('--skip-browser');

  if (command === 'part') {
    const result = runPart(argument, { skipBrowser });
    emit(partPath(argument), result);
    const failed =
      Object.values(result.exits).some((status) => status !== 0) ||
      result.cases.some((entry) => entry.passed === false);
    if (failed) process.exitCode = 1;
    return;
  }

  if (command === 'verdict') {
    const { parts, problems } = loadPartResults(
      resolve(option('parts-dir') ?? ''),
    );
    const needs = Object.fromEntries(
      NEEDS_GROUPS.map((group) => [group, option(group)]),
    );
    finish(
      parts,
      problems,
      needs,
      Number(option('expected-parts')),
      option('out') ? resolve(option('out')) : SUMMARY_PATH,
    );
    return;
  }

  // Serial: the local `pnpm test:m5`. The PostgreSQL requirement is checked
  // before anything slow runs, as it always was.
  const problem = postgresServiceProblem();
  if (problem) {
    finish([], [problem], {}, PARTS.length);
    return;
  }
  const results = PARTS.map((definition) => {
    const result = runPart(definition.id, { skipBrowser });
    writeFileSync(partPath(definition.id), `${JSON.stringify(result)}\n`, {
      mode: 0o600,
    });
    return result;
  });
  finish(
    results,
    [],
    Object.fromEntries(NEEDS_GROUPS.map((group) => [group, 'success'])),
    PARTS.length,
  );
}

main();
