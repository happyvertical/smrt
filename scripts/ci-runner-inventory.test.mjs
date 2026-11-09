import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { isAlias, isMap, isScalar, isSeq, LineCounter, parseDocument, visit } from 'yaml';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflowsDir = path.join(repoRoot, '.github', 'workflows');
const workflowFiles = readdirSync(workflowsDir).filter((file) => file.match(/\.ya?ml$/));

/**
 * Every job's `runs-on` of one workflow, read from the parsed document (never
 * from lines: a job header such as `evil: # c`, a flow-style job or an odd
 * indent is not something a line reader places, and its `runs-on` would be
 * credited to the job before it). A job with no `runs-on` and no `uses` (a
 * reusable workflow call) is reported with `value: undefined`, so it cannot
 * pass unnoticed. `text` defaults to the file on disk.
 */
function runnerDeclarations(file, text = readFileSync(path.join(workflowsDir, file), 'utf8')) {
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter, uniqueKeys: true, merge: false });
  const problems = [...doc.errors, ...doc.warnings].map(
    (error) => `${file}: not plain YAML: ${error.message.split('\n')[0]}`,
  );
  const jobs = doc.get('jobs', true);
  const declarations = [];
  if (!isMap(jobs)) {
    return { declarations, problems: [...problems, `${file}: no jobs mapping`] };
  }
  for (const pair of jobs.items) {
    const job = String(pair.key?.value);
    const line = pair.key?.range ? lineCounter.linePos(pair.key.range[0]).line : 0;
    if (!isMap(pair.value)) {
      problems.push(`${file}:${line}:${job}: the job is not a mapping`);
      continue;
    }
    const runsOn = pair.value.items.find((item) => item.key?.value === 'runs-on');
    if (!runsOn) {
      if (!pair.value.has('uses')) {
        problems.push(`${file}:${line}:${job}: the job has no runs-on and no uses`);
      }
      continue;
    }
    const node = runsOn.value;
    const value = isScalar(node) ? String(node.value) : JSON.stringify(node?.toJSON?.() ?? null);
    declarations.push({
      file,
      job,
      line: runsOn.key?.range ? lineCounter.linePos(runsOn.key.range[0]).line : line,
      value,
    });
  }
  return { declarations, problems };
}

// desktop-release.yml jobs whose runner comes from a matrix. The expression in
// `runs-on` is matched exactly, and the matrix values are checked against an
// explicit list (below), so a self-hosted label cannot hide behind
// `${{ matrix.runner }}`.
const DESKTOP_MATRIX_RUNS_ON = '${{ matrix.runner }}';
const DESKTOP_SIGNING_RUNS_ON =
  "${{ fromJSON(startsWith(matrix.runner, '[') && matrix.runner || format('[\"{0}\"]', matrix.runner)) }}";
const DESKTOP_HOSTED_RUNNERS = Object.freeze([
  'macos-15',
  'macos-15-intel',
  'windows-latest',
  'ubuntu-latest',
]);
// The signing runner variable: documented to name a DEDICATED, EPHEMERAL runner
// in its own runner group. Allowed on the macOS legs of the signing job only.
const DESKTOP_SIGNING_RUNNER_EXPRESSION =
  "${{ vars.DESKTOP_MACOS_SIGNING_RUNNER || 'macos-15' }}";

// Exactly these jobs, each with exactly this runs-on. The matrix-driven ones
// are checked value by value in desktopRunnerViolations.
const DESKTOP_EXPECTED_RUNS_ON = Object.freeze({
  'verify-build': DESKTOP_MATRIX_RUNS_ON,
  'release-preflight': 'ubuntu-latest',
  'release-bundle': 'ubuntu-latest',
  'release-build': DESKTOP_MATRIX_RUNS_ON,
  release: DESKTOP_SIGNING_RUNS_ON,
  'release-publish': 'ubuntu-latest',
});

/** Job ids and runs-on of desktop-release.yml against the expected table. */
function desktopJobViolations(text) {
  const violations = [];
  const { doc, problems } = parseDesktopWorkflow(text);
  violations.push(...problems);
  const jobs = doc.toJS({ maxAliasCount: -1 })?.jobs;
  if (jobs === null || typeof jobs !== 'object' || Array.isArray(jobs)) {
    return [...violations, 'desktop-release.yml has no jobs mapping'];
  }
  const expected = Object.keys(DESKTOP_EXPECTED_RUNS_ON);
  for (const id of Object.keys(jobs)) {
    if (!expected.includes(id)) violations.push(`desktop-release.yml: unexpected job ${id}`);
  }
  for (const id of expected) {
    if (!(id in jobs)) {
      violations.push(`desktop-release.yml: job ${id} is missing`);
    } else if (jobs[id]?.['runs-on'] !== DESKTOP_EXPECTED_RUNS_ON[id]) {
      violations.push(
        `desktop-release.yml: job ${id} runs-on is ${JSON.stringify(jobs[id]?.['runs-on'])}, expected ${DESKTOP_EXPECTED_RUNS_ON[id]}`,
      );
    }
  }
  return violations;
}

function jobBlock(lines, job) {
  const start = lines.findIndex((line) => line.match(new RegExp(`^  ${job}:\\s*$`)));
  assert.notEqual(start, -1, `${job} must declare a job block`);

  const end = lines.findIndex(
    (line, index) => index > start && /^  [A-Za-z][\w-]*:\s*$/.test(line),
  );
  return lines.slice(start, end === -1 ? lines.length : end);
}

const expectedMacosJobs = new Set(['mobile.yml:gradle-macos', 'mobile.yml:xcode-ios']);

/**
 * Violations of the runner rules over every workflow. `overrides` maps a
 * workflow file name to replacement text (for the negative tests); every other
 * file is read from disk. Problems reading a file (invalid YAML, a job that is
 * not a mapping, a job with no runs-on) are violations too.
 */
function inventoryViolations(overrides = {}) {
  const unexpectedRunners = [];
  // Native-OS jobs that cannot run on Ubuntu (smrt#4663, assumed decision
  // pending owner confirmation): the Windows custody tests, and the desktop
  // build/release legs, whose runner comes from the target matrix
  // (macOS arm64/x64, Windows, Linux) or the signing-runner variable. Each
  // exception is a single named job with an exact runner rule; nothing else
  // may leave ubuntu-latest.
  const expectedNativeJobs = new Map([
    ['app-runtime-windows.yml:custody', (value) => value === 'windows-latest'],
    // The matrix values behind these expressions are checked, one by one, in
    // the desktop-release matrix test below.
    ['desktop-release.yml:verify-build', (value) => value === DESKTOP_MATRIX_RUNS_ON],
    ['desktop-release.yml:release-build', (value) => value === DESKTOP_MATRIX_RUNS_ON],
    ['desktop-release.yml:release', (value) => value === DESKTOP_SIGNING_RUNS_ON],
    // desktop-launch.yml (smrt#4835): the launch smoke runs the wrapper on
    // each OS; its `bundle` job is a plain ubuntu-latest job. The matrix values
    // are checked in the desktop-launch test below.
    ['desktop-launch.yml:launch', (value) => value === DESKTOP_MATRIX_RUNS_ON],
  ]);
  const results = workflowFiles.map((file) => runnerDeclarations(file, overrides[file]));
  const declarations = results.flatMap((result) => result.declarations);
  unexpectedRunners.push(...results.flatMap((result) => result.problems));

  for (const declaration of declarations) {
    const key = `${declaration.file}:${declaration.job}`;
    const nativeRule = expectedNativeJobs.get(key);
    if (nativeRule) {
      if (!nativeRule(declaration.value)) {
        unexpectedRunners.push(
          `${declaration.file}:${declaration.line}:${declaration.job}: native job runner rule failed, got ${declaration.value}`,
        );
      }
      continue;
    }
    const expectedRunner = expectedMacosJobs.has(key) ? 'macos-latest' : 'ubuntu-latest';
    if (declaration.value !== expectedRunner) {
      unexpectedRunners.push(
        `${declaration.file}:${declaration.line}:${declaration.job}: expected ${expectedRunner}, got ${declaration.value || '<multiline>'}`,
      );
    }
  }

  const macosJobs = declarations
    .filter(({ value }) => value === 'macos-latest')
    .map(({ file, job }) => `${file}:${job}`)
    .sort();
  if (macosJobs.join() !== [...expectedMacosJobs].sort().join()) {
    unexpectedRunners.push(
      `only Kotlin/Native and Xcode jobs may use macos-latest, got ${macosJobs.join(', ')}`,
    );
  }
  // desktop-release.yml: exactly the expected jobs, each with the expected
  // runs-on, read from the parsed document (a job the line reader of an older
  // version of this test could not place is still a job here).
  const desktopText = overrides['desktop-release.yml'] ?? desktopWorkflow();
  unexpectedRunners.push(...desktopJobViolations(desktopText));
  return { violations: unexpectedRunners, declarations };
}

test('workflow runner inventory permits only explicit Ubuntu and native macOS jobs', () => {
  const { violations, declarations } = inventoryViolations();
  assert.ok(declarations.length > 0, 'workflow inventory must find runner declarations');
  assert.deepEqual(violations, []);
});

const DESKTOP_MATRIX_JOBS = Object.freeze({
  // job -> keys a matrix entry may have (the first is its id, `runner` required)
  'verify-build': ['label', 'runner', 'binary'],
  'release-build': ['target', 'runner', 'bundles', 'artifact_path'],
  release: ['target', 'runner', 'installer_dir'],
});

/**
 * The workflow as the `yaml` package reads it. Anchors, aliases, merge keys
 * and tags are reported (GitHub Actions accepts all four, and each can put a
 * runner label somewhere this test does not look), as is anything that is not
 * one YAML document.
 */
function parseDesktopWorkflow(text) {
  const problems = [];
  const doc = parseDocument(text, { uniqueKeys: true, merge: false });
  for (const error of [...doc.errors, ...doc.warnings]) {
    problems.push(`desktop-release.yml is not plain YAML: ${error.message.split('\n')[0]}`);
  }
  visit(doc, {
    Node(_key, node) {
      if (isAlias(node)) problems.push('desktop-release.yml uses a YAML alias');
      else if (node.anchor) problems.push('desktop-release.yml uses a YAML anchor');
      if (node.tag) problems.push(`desktop-release.yml uses a YAML tag (${node.tag})`);
    },
    Pair(_key, pair) {
      if (pair.key?.value === '<<') problems.push('desktop-release.yml uses a YAML merge key');
    },
  });
  return { doc, problems };
}

/**
 * Every matrix entry of one desktop-release.yml job. The matrix must be
 * exactly `include:` (no axis, no `exclude`) of block-style mappings that have
 * only the expected keys, and every `runner` must be a plain scalar. Anything
 * else is reported as a problem rather than guessed at.
 */
function desktopMatrixRunners(text, job) {
  const { doc, problems } = parseDesktopWorkflow(text);
  const entries = [];
  const allowed = DESKTOP_MATRIX_JOBS[job];
  const matrix = doc.getIn(['jobs', job, 'strategy', 'matrix'], true);
  if (!isMap(matrix) || matrix.flow) {
    return { entries, problems: [...problems, `${job}: the matrix must be a block mapping`] };
  }
  const strategy = doc.getIn(['jobs', job, 'strategy']);
  if (Object.keys(strategy.toJSON()).sort().join() !== 'fail-fast,matrix') {
    problems.push(`${job}: strategy may only have fail-fast and matrix`);
  }
  if (matrix.items.map((pair) => pair.key?.value).join() !== 'include') {
    problems.push(`${job}: the matrix must be exactly an include list (no axis, exclude or other key)`);
  }
  const include = matrix.get('include', true);
  if (!isSeq(include) || include.flow) {
    return { entries, problems: [...problems, `${job}: include must be a block list`] };
  }
  for (const item of include.items) {
    if (!isMap(item) || item.flow) {
      problems.push(`${job}: a matrix entry is not a block mapping`);
      continue;
    }
    const entry = {};
    for (const pair of item.items) {
      const key = pair.key?.value;
      if (typeof key !== 'string' || !allowed.includes(key)) {
        problems.push(`${job}: a matrix entry has the unexpected key ${String(key)}`);
        continue;
      }
      if (!isScalar(pair.value) || pair.value.type !== 'PLAIN') {
        problems.push(`${job}: ${key} of a matrix entry is not a plain scalar`);
        continue;
      }
      entry[key] = String(pair.value.value);
    }
    if (entry.runner === undefined || entry.runner === '') {
      problems.push(`${job}: a matrix entry has no scalar runner`);
    }
    entries.push(entry);
  }
  if (entries.length === 0) problems.push(`${job}: the matrix has no entries`);
  return { entries, problems };
}

/** Violations of the runner rules for the three desktop-release matrix jobs. */
function desktopRunnerViolations(text) {
  const violations = [];
  for (const job of Object.keys(DESKTOP_MATRIX_JOBS)) {
    const result = desktopMatrixRunners(text, job);
    violations.push(...result.problems);
    for (const entry of result.entries) {
      const runner = entry.runner;
      const id = entry.target ?? entry.label ?? '?';
      if (DESKTOP_HOSTED_RUNNERS.includes(runner)) continue;
      const isSigningMac =
        job === 'release' &&
        runner === DESKTOP_SIGNING_RUNNER_EXPRESSION &&
        String(entry.target ?? '').endsWith('-apple-darwin');
      if (!isSigningMac) {
        violations.push(`${job}: runner ${runner} for ${id} is not allowed`);
      }
    }
  }
  // The variable names a signing runner and nothing else may read it: every
  // use in the document is the runner of a darwin leg of the release matrix.
  const { doc } = parseDesktopWorkflow(text);
  const variable = 'DESKTOP_MACOS_SIGNING_RUNNER';
  const uses = (JSON.stringify(doc.toJS({ maxAliasCount: -1 })).match(new RegExp(variable, 'g')) ?? []).length;
  const allowedUses = desktopMatrixRunners(text, 'release').entries.filter(
    (entry) =>
      entry.runner === DESKTOP_SIGNING_RUNNER_EXPRESSION &&
      String(entry.target ?? '').endsWith('-apple-darwin'),
  ).length;
  if (uses !== allowedUses) {
    violations.push(`${variable} is read outside the macOS legs of the release matrix`);
  }
  if (/self-hosted/i.test(JSON.stringify(doc.toJS({ maxAliasCount: -1 })))) {
    violations.push('desktop-release.yml names a self-hosted runner');
  }
  return violations;
}

const desktopWorkflow = () =>
  readFileSync(path.join(workflowsDir, 'desktop-release.yml'), 'utf8');

const DESKTOP_LAUNCH_JOBS = Object.freeze({
  bundle: 'ubuntu-latest',
  launch: DESKTOP_MATRIX_RUNS_ON,
});
const DESKTOP_LAUNCH_MATRIX_KEYS = ['label', 'runner', 'target', 'binary', 'experimental'];

/** Violations of the rules for desktop-launch.yml (exact jobs, hosted runners only). */
function desktopLaunchViolations(text) {
  const violations = [];
  const doc = parseDocument(text, { uniqueKeys: true, merge: false });
  for (const error of [...doc.errors, ...doc.warnings]) {
    violations.push(`desktop-launch.yml is not plain YAML: ${error.message.split('\n')[0]}`);
  }
  visit(doc, {
    Node(_key, node) {
      if (isAlias(node) || node.anchor || node.tag) {
        violations.push('desktop-launch.yml uses an alias, anchor or tag');
      }
    },
  });
  const jobs = doc.toJS({ maxAliasCount: -1 })?.jobs ?? {};
  for (const id of Object.keys(jobs)) {
    if (!(id in DESKTOP_LAUNCH_JOBS)) violations.push(`desktop-launch.yml: unexpected job ${id}`);
  }
  for (const [id, expected] of Object.entries(DESKTOP_LAUNCH_JOBS)) {
    if (jobs[id]?.['runs-on'] !== expected) {
      violations.push(`desktop-launch.yml: job ${id} runs-on is ${JSON.stringify(jobs[id]?.['runs-on'])}`);
    }
  }
  const matrix = doc.getIn(['jobs', 'launch', 'strategy', 'matrix'], true);
  if (!isMap(matrix) || matrix.flow || matrix.items.map((pair) => pair.key?.value).join() !== 'include') {
    return [...violations, 'launch: the matrix must be a block mapping that is exactly an include list'];
  }
  const include = matrix.get('include', true);
  if (!isSeq(include) || include.flow) return [...violations, 'launch: include must be a block list'];
  const runners = [];
  for (const item of include.items) {
    if (!isMap(item) || item.flow) {
      violations.push('launch: a matrix entry is not a block mapping');
      continue;
    }
    for (const pair of item.items) {
      const key = pair.key?.value;
      if (!DESKTOP_LAUNCH_MATRIX_KEYS.includes(key)) {
        violations.push(`launch: a matrix entry has the unexpected key ${String(key)}`);
      } else if (key === 'runner') {
        if (!isScalar(pair.value) || pair.value.type !== 'PLAIN') {
          violations.push('launch: runner of a matrix entry is not a plain scalar');
        } else if (!DESKTOP_HOSTED_RUNNERS.includes(String(pair.value.value))) {
          violations.push(`launch: runner ${pair.value.value} is not allowed`);
        } else {
          runners.push(String(pair.value.value));
        }
      }
    }
  }
  if (runners.length < 3) violations.push('launch: the matrix needs its three runners');
  if (/self-hosted|DESKTOP_MACOS_SIGNING_RUNNER/i.test(JSON.stringify(doc.toJS({ maxAliasCount: -1 })))) {
    violations.push('desktop-launch.yml names a self-hosted runner or the signing-runner variable');
  }
  return violations;
}

test('desktop-launch jobs and matrix runners come from the explicit list', () => {
  const text = readFileSync(path.join(workflowsDir, 'desktop-launch.yml'), 'utf8');
  assert.deepEqual(desktopLaunchViolations(text), []);
  const mutate = (from, to) => {
    assert.equal(text.split(from).length, 2, `anchor must occur once: ${from}`);
    return text.replace(from, to);
  };
  for (const runner of ['self-hosted', 'macos-latest', '[self-hosted, macOS]']) {
    assert.ok(
      desktopLaunchViolations(mutate('runner: macos-15\n', `runner: ${runner}\n`)).length > 0,
      runner,
    );
  }
  assert.ok(
    desktopLaunchViolations(
      mutate('    runs-on: ${{ matrix.runner }}\n', '    runs-on: [self-hosted, macOS]\n'),
    ).length > 0,
  );
  assert.ok(
    desktopLaunchViolations(mutate('  bundle:\n    name: Bundle generic app\n    runs-on: ubuntu-latest', '  bundle:\n    name: Bundle generic app\n    runs-on: macos-15')).length > 0,
  );
  assert.ok(
    desktopLaunchViolations(`${text}\n  extra:\n    runs-on: ubuntu-latest\n    steps: []\n`).some((v) =>
      v.includes('unexpected job extra'),
    ),
  );
});

test('desktop-release matrix runners come from the explicit list', () => {
  assert.deepEqual(desktopRunnerViolations(desktopWorkflow()), []);
  for (const job of Object.keys(DESKTOP_MATRIX_JOBS)) {
    assert.ok(
      desktopMatrixRunners(desktopWorkflow(), job).entries.length >= 4,
      `${job} must have its four matrix entries read`,
    );
  }
});

test('a self-hosted or unlisted runner in a desktop-release matrix fails', () => {
  const text = desktopWorkflow();
  const mutate = (from, to) => {
    assert.equal(text.split(from).length, 2, `anchor must occur once: ${from}`);
    return text.replace(from, to);
  };
  // verify-build runs on pull_request: no variable, no self-hosted label
  for (const runner of ['self-hosted', '[self-hosted, macOS, ARM64]', 'macos-latest', 'macos-13']) {
    assert.ok(
      desktopRunnerViolations(
        mutate('runner: macos-15-intel', `runner: ${runner}`),
      ).length > 0,
      runner,
    );
  }
  assert.ok(
    desktopRunnerViolations(
      mutate(
        'runner: macos-15-intel',
        "runner: ${{ vars.DESKTOP_MACOS_SIGNING_RUNNER || 'macos-15' }}",
      ),
    ).length > 0,
    'the signing-runner variable must not reach verify-build',
  );
  // release-build compiles with no secrets on hosted runners only
  assert.ok(
    desktopRunnerViolations(
      mutate(
        '            runner: windows-latest\n            bundles: nsis',
        '            runner: self-hosted\n            bundles: nsis',
      ),
    ).some((v) => v.startsWith('release-build: runner')),
  );
  assert.ok(
    desktopRunnerViolations(
      mutate(
        '            runner: ubuntu-latest\n            bundles: deb',
        "            runner: ${{ vars.DESKTOP_MACOS_SIGNING_RUNNER || 'macos-15' }}\n            bundles: deb",
      ),
    ).length > 0,
  );
  // release: the variable is for the macOS legs only
  assert.ok(
    desktopRunnerViolations(
      mutate(
        '            runner: windows-latest\n            installer_dir: nsis',
        "            runner: ${{ vars.DESKTOP_MACOS_SIGNING_RUNNER || 'macos-15' }}\n            installer_dir: nsis",
      ),
    ).some((v) => v.startsWith('release: runner')),
  );
  assert.ok(
    desktopRunnerViolations(
      mutate(
        '            runner: ubuntu-latest\n            installer_dir: deb',
        '            runner: self-hosted\n            installer_dir: deb',
      ),
    ).some((v) => v.startsWith('release: runner')),
  );
  // a different default for the variable is not the documented expression
  assert.ok(
    desktopRunnerViolations(
      text.replace(
        /\|\| 'macos-15' \}\}\n(\s+)- target: x86_64-apple-darwin/,
        "|| 'self-hosted' }}\n$1- target: x86_64-apple-darwin",
      ),
    ).some((v) => v.startsWith('release: runner')),
  );
});

test('a matrix the reader would drop on the floor is refused, not skipped', () => {
  const text = desktopWorkflow();
  const mutate = (from, to) => {
    assert.equal(text.split(from).length, 2, `anchor must occur once: ${from}`);
    return text.replace(from, to);
  };
  const VERIFY = '      fail-fast: false\n      matrix:\n        include:\n          - label: macos-arm64';
  const BUILD = '      fail-fast: true\n      matrix:\n        include:\n          # Both macOS targets build on the hosted arm64 runner; the x64 target\n          # is cross-compiled.\n          - target: aarch64-apple-darwin';
  const SIGN = '      fail-fast: true\n      matrix:\n        include:\n          - target: aarch64-apple-darwin\n            runner: ${{ vars';
  const refused = (mutated, pattern) => {
    const violations = desktopRunnerViolations(mutated);
    assert.ok(violations.length > 0, 'expected the mutation to be refused');
    if (pattern) {
      assert.ok(
        violations.some((v) => pattern.test(v)),
        `${pattern}: ${violations.join(' | ')}`,
      );
    }
  };
  for (const [anchor, job] of [[VERIFY, 'verify-build'], [BUILD, 'release-build'], [SIGN, 'release']]) {
    // an extra axis at the matrix level (8 spaces), scalar or list
    refused(
      mutate(anchor, anchor.replace('        include:', '        runner: [my-mac-label]\n        include:')),
      /exactly an include list/,
    );
    refused(
      mutate(anchor, anchor.replace('        include:', '        runner: my-mac-label\n        include:')),
      /exactly an include list/,
    );
    // exclude and a second include-like key
    refused(
      mutate(anchor, anchor.replace('        include:', '        exclude:\n          - runner: macos-15\n        include:')),
      /exactly an include list/,
    );
    // a flow-form entry appended to the list
    const flow = `          - {${job === 'verify-build' ? 'label' : 'target'}: x, runner: my-label}\n`;
    refused(
      mutate(anchor, anchor.replace('        include:\n', `        include:\n${flow}`)),
      /not a block mapping|my-label/,
    );
    // an unexpected key on an entry (a label list the reader never looked at)
    refused(
      mutate(anchor, anchor.replace(/(- (label|target): [^\n]*)(\n|$)/, '$1\n            labels: [self-hosted]\n')),
      /unexpected key labels/,
    );
  }
  // an axis or exclude AFTER the include list, where a line reader stops looking
  refused(
    mutate(
      '            binary: smrt-desktop-wrapper\n    steps:',
      '            binary: smrt-desktop-wrapper\n        runner: [my-mac-label]\n    steps:',
    ),
    /exactly an include list/,
  );
  refused(
    mutate(
      '            binary: smrt-desktop-wrapper\n    steps:',
      '            binary: smrt-desktop-wrapper\n        exclude:\n          - runner: macos-15\n    steps:',
    ),
    /exactly an include list/,
  );
  // include written as a flow list, the whole matrix as flow, or as an expression
  refused(
    mutate(VERIFY, '      fail-fast: false\n      matrix: {include: [{label: x, runner: self-hosted}]}\n      _x: 1\n      #'),
  );
  refused(
    mutate(VERIFY, "      fail-fast: false\n      matrix: ${{ fromJSON(vars.MATRIX) }}\n      #"),
    /block mapping/,
  );
  // anchors and aliases put a runner somewhere the reader does not look
  refused(
    mutate('runner: macos-15-intel', 'runner: &r self-hosted').replace(
      'runner: windows-latest\n            binary: smrt-desktop-wrapper.exe',
      'runner: *r\n            binary: smrt-desktop-wrapper.exe',
    ),
    /anchor|alias/,
  );
  refused(mutate('runner: macos-15-intel', 'runner: !!str macos-15-intel'), /tag/);
  // a quoted or block scalar runner is not a plain scalar
  refused(mutate('runner: macos-15-intel', "runner: 'macos-15-intel'"), /not a plain scalar/);
  refused(mutate('runner: macos-15-intel', 'runner: |\n              macos-15-intel'), /not a plain scalar/);
  // an entry with no runner
  refused(
    mutate('            runner: macos-15-intel\n', ''),
    /no scalar runner/,
  );
  // the signing variable read anywhere else
  refused(
    mutate(
      '      - name: Upload the unsigned wrapper binary (verification only)\n',
      "      - name: Read\n        env:\n          R: ${{ vars.DESKTOP_MACOS_SIGNING_RUNNER }}\n        run: echo hi\n      - name: Upload the unsigned wrapper binary (verification only)\n",
    ),
    /read outside/,
  );
});

/** The `runs-on` value of each desktop-release.yml job, as parsed. */
function desktopRunsOn(text) {
  const { doc } = parseDesktopWorkflow(text);
  const jobs = doc.toJS().jobs;
  return Object.fromEntries(Object.entries(jobs).map(([job, body]) => [job, body['runs-on']]));
}

test('the runs-on expressions of the desktop-release matrix jobs are exact', () => {
  const text = desktopWorkflow();
  const runsOn = desktopRunsOn(text);
  assert.equal(runsOn['verify-build'], DESKTOP_MATRIX_RUNS_ON);
  assert.equal(runsOn['release-build'], DESKTOP_MATRIX_RUNS_ON);
  assert.equal(runsOn.release, DESKTOP_SIGNING_RUNS_ON);
  // Anything else on those jobs is a different runner rule, whatever the matrix.
  const swapped = text.replace(
    '    runs-on: ${{ matrix.runner }}\n    timeout-minutes: 45',
    '    runs-on: [self-hosted, macOS]\n    timeout-minutes: 45',
  );
  assert.notEqual(desktopRunsOn(swapped)['verify-build'], DESKTOP_MATRIX_RUNS_ON);
  const signing = text.replace(
    "runs-on: ${{ fromJSON(startsWith(matrix.runner, '[')",
    "runs-on: ${{ fromJSON(vars.OTHER || startsWith(matrix.runner, '[')",
  );
  assert.notEqual(desktopRunsOn(signing).release, DESKTOP_SIGNING_RUNS_ON);
});

test('a job header a line reader cannot place cannot hide a runs-on', () => {
  const text = desktopWorkflow();
  const BEFORE = '  release-publish:\n';
  assert.equal(text.split(BEFORE).length, 2);
  const withJob = (job) => text.replace(BEFORE, `${job}\n${BEFORE}`);
  const generic = (mutated) =>
    inventoryViolations({ 'desktop-release.yml': mutated }).violations;
  const evilJobs = [
    // a trailing comment after the header: the old reader skipped the header
    // and credited the runs-on below to the job before it
    '  evil: # c\n    runs-on: ${{ matrix.runner }}\n    strategy:\n      matrix:\n        runner: [self-hosted]\n    steps:\n      - run: echo hi\n',
    '  evil: # c\n    runs-on: [self-hosted]\n    steps:\n      - run: echo hi\n',
    '  "evil":\n    runs-on: self-hosted\n    steps:\n      - run: echo hi\n',
    '  evil :\n    runs-on: self-hosted\n    steps:\n      - run: echo hi\n',
    '  evil: {runs-on: self-hosted, steps: [{run: echo hi}]}\n',
    '  evil:\n    name: x\n    runs-on:\n      group: mine\n    steps:\n      - run: echo hi\n',
  ];
  for (const job of evilJobs) {
    const mutated = withJob(job);
    const declared = runnerDeclarations('desktop-release.yml', mutated).declarations;
    assert.ok(
      declared.some((d) => d.job === 'evil'),
      `the job is read as a job of its own: ${job}`,
    );
    assert.ok(
      generic(mutated).some((v) => /:evil: (native job runner rule failed|expected ubuntu-latest)/.test(v)),
      `the generic inventory refuses it: ${job}`,
    );
    assert.ok(
      desktopJobViolations(mutated).some((v) => /unexpected job evil/.test(v)),
      `the desktop-release job list refuses it: ${job}`,
    );
  }
  // a job the document has but the expected table does not, or lacks
  assert.ok(desktopJobViolations(text.replace('  release-publish:\n', '  release-publish-2:\n')).some((v) => /job release-publish is missing/.test(v)));
  // an expected job with another runs-on, written in any spelling
  const bundle = /(  release-bundle:\n(?:.*\n)*?    runs-on: )ubuntu-latest/;
  assert.ok(bundle.test(text), 'the release-bundle runs-on anchor');
  for (const runsOn of ['[self-hosted]', 'self-hosted', 'macos-latest', '${{ matrix.runner }}', '{group: mine}']) {
    const mutated = text.replace(bundle, `$1${runsOn}`);
    assert.ok(
      desktopJobViolations(mutated).some((v) => /job release-bundle runs-on/.test(v)),
      runsOn,
    );
    assert.ok(generic(mutated).some((v) => /release-bundle/.test(v)), runsOn);
  }
  // an extra job on a hosted runner is still not one of the six jobs
  assert.ok(
    generic(withJob('  evil: # c\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n')).some((v) =>
      /unexpected job evil/.test(v),
    ),
  );
  // a job with neither runs-on nor uses is reported, not skipped
  assert.ok(
    generic(withJob('  evil:\n    steps:\n      - run: echo hi\n')).some((v) =>
      /evil: the job has no runs-on and no uses/.test(v),
    ),
  );
  // a file that does not parse is reported, not skipped
  assert.ok(generic(`${text}\n---\nother: 1\n`).some((v) => /not plain YAML/.test(v)));
});

test('test matrices retain the hosted three-shard parallelism', () => {
  const { declarations } = runnerDeclarations('test-suite.yml');

  for (const job of [
    'affected-core-tests',
    'affected-package-tests',
    'test-core',
    'test-packages',
  ]) {
    assert.ok(
      declarations.some(({ job: currentJob }) => currentJob === job),
      `${job} must declare a runner`,
    );
    const workflow = readFileSync(path.join(workflowsDir, 'test-suite.yml'), 'utf8').split('\n');
    const jobLines = jobBlock(workflow, job);
    assert.ok(jobLines.includes('      max-parallel: 3'), `${job} must use all hosted shards`);
  }
});

test('matrix checks reject missing jobs and use the final job boundary', () => {
  const missingJob = ['jobs:', '  another-matrix:', '      max-parallel: 3'];
  assert.throws(() => jobBlock(missingJob, 'test-core'), /test-core must declare a job block/);

  const finalJob = [
    'jobs:',
    '  another-matrix:',
    '      max-parallel: 3',
    '  test-core:',
    '      max-parallel: 2',
  ];
  assert.deepEqual(jobBlock(finalJob, 'test-core'), ['  test-core:', '      max-parallel: 2']);
  assert.throws(
    () => assert.ok(jobBlock(finalJob, 'test-core').includes('      max-parallel: 3'), 'test-core must use all hosted shards'),
    /test-core must use all hosted shards/,
  );
});
