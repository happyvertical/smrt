/**
 * The M5 aggregate gate's contract: what must run, where, and the one verdict
 * over what did (#2579, split into parallel parts by #5694).
 *
 * This module is deliberately import-safe: node built-ins only, no top-level
 * side effects, no `main()`. The gate runner (`gate.mjs`) executes parts and
 * calls {@link evaluateGate}; the CI aggregator job calls the same function on
 * the uploaded part results from a bare checkout with no `pnpm install`; and
 * `scripts/m5-gate-verdict.test.mjs` exercises it directly.
 *
 * The invariant, unchanged from the single-job gate: a required check must not
 * be able to pass by not running. Every rule below turns a part that is
 * missing, duplicated, empty, skipped, unknown or non-zero into a failure.
 */

import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** The files that connect to the one disposable PostgreSQL database. */
export const POSTGRES_FILES = '.postgres.optional.test.ts';

/** Bumped when the part-result shape changes, so a stale part cannot pass. */
export const SCHEMA_VERSION = 2;

/**
 * The vitest suites M5 draws cases from. `template` is this package's whole
 * suite: every file is in exactly one part. The others are the owning packages
 * of code the template used to copy (#3367): a case whose implementation moved
 * out of the template is proven where that code now lives, and is matched by
 * name exactly like the template's own.
 */
export const OWNING_PACKAGE_FILES = Object.freeze({
  cli: 'src/app/__tests__/portability-assets.test.ts',
  'app-runtime': 'src/sveltekit.test.ts',
});

/**
 * The heavy template files, named so that no shard is held by one file and each
 * shard carries about a third of the suite. `template-3` runs everything else,
 * computed by exclusion, so a new test file can never be left out of every
 * shard; {@link evaluateGate} also asserts that the shards' files are exactly
 * the files the include glob selects, each once.
 *
 * `cookbookHost` and `cookbookApply` are split into several files with the
 * same describe and test titles as the files they replace (#5694).
 */
export const TEMPLATE_SHARD_FILES = Object.freeze({
  'template-1': [
    '__tests__/cookbookHost.part1.test.ts',
    '__tests__/cookbookHost.part2.test.ts',
    '__tests__/cookbookApply.bakery.test.ts',
  ],
  'template-2': [
    '__tests__/cookbookHost.part3.test.ts',
    '__tests__/cookbookHost.part4.test.ts',
    '__tests__/cookbookApply.mechanic.test.ts',
  ],
});

/**
 * The parts, in serial order. `needs` names the CI job group that runs the
 * part, so the aggregator can require each group's result explicitly.
 */
export const PARTS = Object.freeze([
  { id: 'template-1', kind: 'vitest', needs: 'template' },
  { id: 'template-2', kind: 'vitest', needs: 'template' },
  { id: 'template-3', kind: 'vitest', needs: 'template' },
  { id: 'postgres', kind: 'vitest', needs: 'postgres' },
  { id: 'browser', kind: 'browser', needs: 'browser' },
]);

/** The three CI job groups the aggregator reads a result from. */
export const NEEDS_GROUPS = Object.freeze(['template', 'postgres', 'browser']);

/**
 * Passing-test floors for the files split out of `cookbookHost` and
 * `cookbookApply`. No `REQUIRED_VITEST_CASES` entry guards them, so without a
 * per-file floor a split file that silently ran fewer tests (or none) would
 * pass. The floors sum to the 58 + 4 tests the two files held before the
 * split; adding tests never trips them, removing one has to edit this table.
 */
export const SPLIT_FILE_MINIMUMS = Object.freeze({
  '__tests__/cookbookHost.part1.test.ts': 14,
  '__tests__/cookbookHost.part2.test.ts': 11,
  '__tests__/cookbookHost.part3.test.ts': 14,
  '__tests__/cookbookHost.part4.test.ts': 19,
  '__tests__/cookbookApply.bakery.test.ts': 1,
  '__tests__/cookbookApply.mechanic.test.ts': 1,
  '__tests__/cookbookApply.welder.test.ts': 1,
  '__tests__/cookbookApply.yoga-studio.test.ts': 1,
});

/**
 * Every M5 profile/gate case this milestone claims to cover.
 *
 * `match` is tested against the full vitest test name. `dependsOn` records
 * the prerequisite issue that lands the case, so a red gate says which
 * dependency is outstanding instead of just "missing". `suite` names the
 * vitest suite the case must come from (default `template`), so a same-named
 * test elsewhere can never satisfy it.
 */
export const REQUIRED_VITEST_CASES = [
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
    // `smrt app export`/`import` (#3371) own asset-aware portability.
    suite: 'cli',
    match: /round-trips the owner, tenant, record, association, bytes, and digest/i,
    dependsOn: '#2576',
  },
  {
    id: 'diagnostics-authorization',
    profile: 'sqlite',
    // The template mounts `createRuntimeDiagnosticsHandler` (#3369); the
    // browser cases below exercise that mounted route end to end.
    suite: 'app-runtime',
    match: /runtime diagnostics route authorizes before projection and returns only stable errors/i,
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
    suite: 'cli',
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
export const REQUIRED_BROWSER_CASES = [
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

const suiteOf = (required) => required.suite ?? 'template';

/** Which vitest suites a part runs. */
export function partSuites(partId) {
  if (partId === 'postgres') return ['template', 'cli', 'app-runtime'];
  if (partId.startsWith('template-')) return ['template'];
  return [];
}

/** Every `*.test.ts` under the package's `__tests__/`, as the include glob selects. */
export function listTemplateTestFiles(packageRoot) {
  const found = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.test.ts'))
        found.push(relative(packageRoot, path).split(sep).join('/'));
    }
  };
  walk(join(packageRoot, '__tests__'));
  return found.sort();
}

/** The non-PostgreSQL template files one template shard runs. */
export function templateShardFiles(partId, allFiles) {
  const nonPostgres = allFiles.filter((file) => !file.endsWith(POSTGRES_FILES));
  const named = TEMPLATE_SHARD_FILES[partId];
  if (named) return [...named];
  if (partId === 'template-3') {
    const claimed = new Set(Object.values(TEMPLATE_SHARD_FILES).flat());
    return nonPostgres.filter((file) => !claimed.has(file));
  }
  throw new Error(`m5-gate: ${partId} is not a template shard.`);
}

/**
 * Cases a part reports for the vitest suites it ran. Every required case of a
 * suite the part ran gets an entry, with `observed: 0` when none of this
 * part's files held it, so the verdict sums observations across parts and a
 * case found nowhere is distinguishable from one found and failing.
 */
export function evaluateVitestCases(observedEntries, suitesRun) {
  const cases = [];
  for (const required of REQUIRED_VITEST_CASES) {
    const suite = suiteOf(required);
    if (!suitesRun.includes(suite)) continue;
    const matches = observedEntries.filter(
      (entry) => entry.suite === suite && required.match.test(entry.name),
    );
    cases.push({
      id: required.id,
      profile: required.profile,
      suite,
      passed: matches.every((entry) => entry.status === 'passed'),
      observed: matches.length,
    });
  }
  return cases;
}

export function evaluateBrowserCases(observedEntries) {
  return REQUIRED_BROWSER_CASES.map((required) => {
    const matches = observedEntries.filter((entry) =>
      required.match.test(entry.name),
    );
    return {
      id: required.id,
      profile: 'sqlite',
      passed:
        matches.length > 0 &&
        matches.every((entry) => entry.status === 'passed'),
      observed: matches.length,
    };
  });
}

// ---------------------------------------------------------------------------
// Sanitized-vocabulary guard
// ---------------------------------------------------------------------------

const ALLOWED_KEYS = new Set([
  'schemaVersion',
  'gate',
  'part',
  'parts',
  'exits',
  'vitest',
  'playwright',
  'cases',
  'files',
  'id',
  'profile',
  'suite',
  'passed',
  'observed',
  'skipped',
  'file',
  'tests',
  'failed',
]);

const FILE_PATTERN = /^(?:__tests__|src)\/[A-Za-z0-9_./-]+\.test\.ts$/;

function allowedStrings() {
  return new Set([
    'm5',
    'postgres-service',
    'sqlite',
    'template',
    ...Object.keys(OWNING_PACKAGE_FILES),
    ...PARTS.map((part) => part.id),
    ...PARTS.map((part) => `${part.id}-exit`),
    ...REQUIRED_VITEST_CASES.flatMap((entry) => [entry.id, entry.profile]),
    ...REQUIRED_BROWSER_CASES.map((entry) => entry.id),
  ]);
}

/**
 * Structural guard, not a pattern scan: a part result or summary may only ever
 * contain the fixed vocabulary above, plus relative test file names. Anything
 * else — a message, an absolute path, a diagnostic — is a defect in the gate
 * runner, and failing here is cheaper than discovering it in an uploaded
 * artifact. Returns the violations (empty when clean).
 */
export function vocabularyViolations(value) {
  const strings = allowedStrings();
  const problems = [];
  const walk = (node) => {
    if (typeof node === 'string') {
      if (!strings.has(node) && !FILE_PATTERN.test(node))
        problems.push('an unexpected string value');
    } else if (Array.isArray(node)) {
      for (const item of node) walk(item);
    } else if (node && typeof node === 'object') {
      for (const [key, child] of Object.entries(node)) {
        if (!ALLOWED_KEYS.has(key)) problems.push('an unexpected key');
        walk(child);
      }
    } else if (
      node !== null &&
      typeof node !== 'number' &&
      typeof node !== 'boolean'
    ) {
      problems.push('an unexpected value type');
    }
  };
  walk(value);
  return problems;
}

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

const asArray = (value) => (Array.isArray(value) ? value : []);

/**
 * One verdict over every part's result.
 *
 * @param {object}   input
 * @param {object[]} input.parts           Parsed part results, as uploaded.
 * @param {string[]} [input.loadProblems]  Problems reading them (empty folder, bad JSON).
 * @param {Record<string,string>} input.needs
 *   `needs.<group>.result` of each CI job group, passed in explicitly so a
 *   skipped or cancelled job cannot read as a pass.
 * @param {string[]} input.expectedFiles   Every template test file the include glob selects.
 * @param {number}   [input.expectedPartCount]  The CI matrix size + the single jobs.
 * @returns {{ passed: boolean, failures: string[], summary: object }}
 */
export function evaluateGate({
  parts,
  loadProblems = [],
  needs = {},
  expectedFiles,
  expectedPartCount = PARTS.length,
}) {
  const failures = [...loadProblems];
  const fail = (message) => failures.push(message);

  for (const group of NEEDS_GROUPS) {
    const result = needs[group];
    if (result !== 'success')
      fail(
        `the ${group} job group ended ${result === undefined || result === '' ? 'absent' : JSON.stringify(result)}, not success`,
      );
  }
  if (expectedPartCount !== PARTS.length)
    fail(
      `the workflow expects ${expectedPartCount} parts but the gate defines ${PARTS.length}`,
    );
  if (asArray(parts).length !== expectedPartCount)
    fail(
      `expected ${expectedPartCount} part results, found ${asArray(parts).length}`,
    );

  // Identify each part exactly once.
  const byId = new Map();
  for (const part of asArray(parts)) {
    if (
      !part ||
      typeof part !== 'object' ||
      part.schemaVersion !== SCHEMA_VERSION ||
      part.gate !== 'm5'
    ) {
      fail('a part result has an unrecognized shape or schema version');
      continue;
    }
    if (vocabularyViolations(part).length > 0) {
      fail('a part result carries content outside the sanitized vocabulary');
      continue;
    }
    const definition = PARTS.find((entry) => entry.id === part.part);
    if (!definition) {
      fail('a part result names an unknown part');
      continue;
    }
    if (byId.has(definition.id)) {
      fail(`part ${definition.id} reported more than once`);
      continue;
    }
    byId.set(definition.id, part);
  }
  for (const definition of PARTS) {
    if (!byId.has(definition.id)) fail(`part ${definition.id} is missing`);
  }

  // Per-part health: exit status, content, and every file's own tests.
  const seenFiles = new Map(); // `${suite}:${file}` -> part ids
  const caseEntries = []; // { part, ...case }
  for (const definition of PARTS) {
    const part = byId.get(definition.id);
    if (!part) continue;
    const id = definition.id;
    const cases = asArray(part.cases);
    const files = asArray(part.files);
    const exits =
      part.exits && typeof part.exits === 'object' ? part.exits : {};
    if (cases.length === 0 && files.length === 0)
      fail(`part ${id} reported nothing`);
    const exitKeys = Object.keys(exits);
    if (exitKeys.length === 0) fail(`part ${id} carries no exit status`);
    for (const key of exitKeys) {
      if (exits[key] !== 0)
        fail(`part ${id}: the ${key} run exited ${JSON.stringify(exits[key])}`);
    }
    const allowedSuites = partSuites(id);
    if (definition.kind === 'vitest' && files.length === 0)
      fail(`part ${id} ran no test files`);
    if (definition.kind === 'browser' && files.length > 0)
      fail(`part ${id} reported vitest files`);
    for (const file of files) {
      if (!allowedSuites.includes(file.suite)) {
        fail(`part ${id} reported a file from a suite it does not run`);
        continue;
      }
      const key = `${file.suite}:${file.file}`;
      seenFiles.set(key, [...(seenFiles.get(key) ?? []), id]);
      if (!(file.passed > 0)) fail(`part ${id}: ${file.file} ran no passing tests`);
      if (file.failed > 0) fail(`part ${id}: ${file.file} has failing tests`);
    }
    for (const entry of cases) caseEntries.push({ ...entry, part: id });
  }

  // Files: the union of every part's files is the include glob, each once.
  const expectedKeys = new Map();
  for (const file of expectedFiles) expectedKeys.set(`template:${file}`, file);
  for (const [suite, file] of Object.entries(OWNING_PACKAGE_FILES))
    expectedKeys.set(`${suite}:${file}`, file);
  for (const [key, partIds] of seenFiles) {
    const name = key.slice(key.indexOf(':') + 1);
    if (!expectedKeys.has(key)) fail(`${name} ran but is not a selected test file`);
    if (partIds.length > 1)
      fail(`${name} ran in more than one part (${partIds.join(', ')})`);
    if (key.startsWith('template:')) {
      const expectedPart = name.endsWith(POSTGRES_FILES)
        ? 'postgres'
        : null;
      const inPostgres = partIds.includes('postgres');
      if (expectedPart === 'postgres' && !inPostgres)
        fail(`${name} must run in the postgres part`);
      if (expectedPart === null && inPostgres)
        fail(`${name} must not run in the postgres part`);
    } else if (!partIds.every((partId) => partId === 'postgres')) {
      fail(`${name} must run in the postgres part`);
    }
  }
  for (const [key, name] of expectedKeys) {
    if (!seenFiles.has(key)) fail(`${name} ran in no part`);
  }

  // Per-file floors for the split files no required case guards.
  for (const [file, minimum] of Object.entries(SPLIT_FILE_MINIMUMS)) {
    const entry = [...byId.values()]
      .flatMap((part) => asArray(part.files))
      .find((candidate) => candidate.file === file && candidate.suite === 'template');
    if (!entry) continue; // reported above as "ran in no part"
    if (!(entry.passed >= minimum && entry.passed > 0))
      fail(`${file} ran ${entry.passed} passing tests, expected at least ${Math.max(minimum, 1)}`);
  }

  // Required cases: observed somewhere, in the right suite, and never failing.
  const cases = [];
  for (const required of REQUIRED_VITEST_CASES) {
    const suite = suiteOf(required);
    const entries = caseEntries.filter(
      (entry) => entry.id === required.id && entry.suite === suite,
    );
    const observed = entries.reduce((sum, entry) => sum + (entry.observed ?? 0), 0);
    const passed = observed > 0 && entries.every((entry) => entry.passed === true);
    cases.push({ id: required.id, profile: required.profile, passed, observed });
    if (!passed)
      fail(
        observed === 0
          ? `required case ${required.id} did not run (landed by ${required.dependsOn})`
          : `required case ${required.id} did not pass`,
      );
  }
  for (const required of REQUIRED_BROWSER_CASES) {
    const entries = caseEntries.filter(
      (entry) => entry.id === required.id && entry.part === 'browser',
    );
    const skipped = entries.some((entry) => entry.skipped === true);
    const observed = entries.reduce((sum, entry) => sum + (entry.observed ?? 0), 0);
    const passed =
      !skipped && observed > 0 && entries.every((entry) => entry.passed === true);
    cases.push({
      id: required.id,
      profile: 'sqlite',
      passed,
      observed,
      ...(skipped ? { skipped: true } : {}),
    });
    if (!passed)
      fail(
        skipped
          ? `the browser cases were skipped explicitly; this is not a passing gate`
          : observed === 0
            ? `required browser case ${required.id} did not run`
            : `required browser case ${required.id} did not pass`,
      );
  }

  // The PostgreSQL service is owned by exactly one part, `postgres`.
  const service = caseEntries.filter((entry) => entry.id === 'postgres-service');
  const serviceOk =
    service.length === 1 &&
    service[0].part === 'postgres' &&
    service[0].passed === true;
  if (!serviceOk)
    fail(
      'the postgres-service case must be reported passing by exactly one part, postgres',
    );
  cases.unshift({ id: 'postgres-service', passed: serviceOk });

  for (const definition of PARTS) {
    const part = byId.get(definition.id);
    const exits = part?.exits && typeof part.exits === 'object' ? part.exits : {};
    const keys = Object.keys(exits);
    cases.push({
      id: `${definition.id}-exit`,
      passed: keys.length > 0 && keys.every((key) => exits[key] === 0),
    });
  }

  const summary = {
    schemaVersion: SCHEMA_VERSION,
    gate: 'm5',
    cases,
    passed: failures.length === 0,
  };
  const leaked = vocabularyViolations(summary);
  if (leaked.length > 0) throw new Error('m5-gate summary contains an unexpected value.');
  return { passed: failures.length === 0, failures, summary };
}
