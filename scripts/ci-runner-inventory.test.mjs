import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflowsDir = path.join(repoRoot, '.github', 'workflows');
const workflowFiles = readdirSync(workflowsDir).filter((file) => file.match(/\.ya?ml$/));

function runnerDeclarations(file) {
  const declarations = [];
  let job;
  const lines = readFileSync(path.join(workflowsDir, file), 'utf8').split('\n');

  for (const [index, line] of lines.entries()) {
    const jobMatch = line.match(/^  ([A-Za-z][\w-]*):\s*$/);
    if (jobMatch) job = jobMatch[1];

    const runnerMatch = line.match(/^    runs-on:\s*(.*)$/);
    if (!runnerMatch) continue;

    declarations.push({ file, job, line: index + 1, value: runnerMatch[1] });
  }

  return declarations;
}

// desktop-release.yml jobs whose runner comes from a matrix. The expression in
// `runs-on` is matched exactly, and the matrix values are checked against an
// explicit list (below), so a self-hosted label cannot hide behind
// `${{ matrix.runner }}`.
const DESKTOP_MATRIX_RUNS_ON = '${{ matrix.runner }}';
const DESKTOP_SIGNING_RUNS_ON =
  "${{ fromJSON(startsWith(matrix.runner, '[') && matrix.runner || format('[\"{0}\"]', matrix.runner)) }}";
const DESKTOP_HOSTED_RUNNERS = Object.freeze([
  'macos-14',
  'macos-15-intel',
  'windows-latest',
  'ubuntu-latest',
]);
// The signing runner variable: documented to name a DEDICATED, EPHEMERAL runner
// in its own runner group. Allowed on the macOS legs of the signing job only.
const DESKTOP_SIGNING_RUNNER_EXPRESSION =
  "${{ vars.DESKTOP_MACOS_SIGNING_RUNNER || 'macos-14' }}";

function jobBlock(lines, job) {
  const start = lines.findIndex((line) => line.match(new RegExp(`^  ${job}:\\s*$`)));
  assert.notEqual(start, -1, `${job} must declare a job block`);

  const end = lines.findIndex(
    (line, index) => index > start && /^  [A-Za-z][\w-]*:\s*$/.test(line),
  );
  return lines.slice(start, end === -1 ? lines.length : end);
}

test('workflow runner inventory permits only explicit Ubuntu and native macOS jobs', () => {
  const unexpectedRunners = [];
  const expectedMacosJobs = new Set(['mobile.yml:gradle-macos', 'mobile.yml:xcode-ios']);
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
  ]);
  const declarations = workflowFiles.flatMap(runnerDeclarations);

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

  assert.ok(declarations.length > 0, 'workflow inventory must find runner declarations');
  assert.deepEqual(unexpectedRunners, []);
  assert.deepEqual(
    declarations
      .filter(({ value }) => value === 'macos-latest')
      .map(({ file, job }) => `${file}:${job}`)
      .sort(),
    [...expectedMacosJobs].sort(),
    'only Kotlin/Native and Xcode jobs may use macos-latest',
  );
});

/**
 * Every `runner:` value of the matrix entries of one desktop-release.yml job,
 * with the target or label of its entry. Anything but a plain include list of
 * scalar entries is reported as a problem rather than guessed at.
 */
function desktopMatrixRunners(text, job) {
  const lines = jobBlock(text.split('\n'), job);
  const problems = [];
  const entries = [];
  const matrixAt = lines.findIndex((line) => /^ {6}matrix:\s*$/.test(line));
  if (matrixAt === -1 || !/^ {8}include:\s*$/.test(lines[matrixAt + 1] ?? '')) {
    return { entries, problems: [`${job}: the matrix must be a plain include list`] };
  }
  let current;
  for (const line of lines.slice(matrixAt + 2)) {
    if (/^ {0,7}\S/.test(line)) break; // left the matrix
    const first = /^ {10}- ([A-Za-z_]+):\s*(.*)$/.exec(line);
    if (first) {
      current = { [first[1]]: first[2] };
      entries.push(current);
      continue;
    }
    const kv = /^ {12}([A-Za-z_]+):\s*(.*)$/.exec(line);
    if (kv && current) current[kv[1]] = kv[2];
  }
  if (entries.length === 0) problems.push(`${job}: the matrix has no entries`);
  for (const entry of entries) {
    if (entry.runner === undefined || entry.runner === '') {
      problems.push(`${job}: a matrix entry has no scalar runner`);
    }
  }
  return { entries, problems };
}

/** Violations of the runner rules for the three desktop-release matrix jobs. */
function desktopRunnerViolations(text) {
  const violations = [];
  for (const job of ['verify-build', 'release-build', 'release']) {
    let result;
    try {
      result = desktopMatrixRunners(text, job);
    } catch (error) {
      violations.push(error.message);
      continue;
    }
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
  // The variable names a signing runner and nothing else may read it.
  const variableUses = text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .filter((line) => line.includes('DESKTOP_MACOS_SIGNING_RUNNER')).length;
  const releaseBlock = jobBlock(text.split('\n'), 'release').join('\n');
  const inRelease = releaseBlock
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .filter((line) => line.includes('DESKTOP_MACOS_SIGNING_RUNNER')).length;
  if (variableUses !== inRelease) {
    violations.push('DESKTOP_MACOS_SIGNING_RUNNER is read outside the release job');
  }
  const noComments = text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
  if (/self-hosted/i.test(noComments)) {
    violations.push('desktop-release.yml names a self-hosted runner');
  }
  return violations;
}

const desktopWorkflow = () =>
  readFileSync(path.join(workflowsDir, 'desktop-release.yml'), 'utf8');

test('desktop-release matrix runners come from the explicit list', () => {
  assert.deepEqual(desktopRunnerViolations(desktopWorkflow()), []);
  for (const job of ['verify-build', 'release-build', 'release']) {
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
      ).some((v) => v.startsWith('verify-build: runner')),
      runner,
    );
  }
  assert.ok(
    desktopRunnerViolations(
      mutate(
        'runner: macos-15-intel',
        "runner: ${{ vars.DESKTOP_MACOS_SIGNING_RUNNER || 'macos-14' }}",
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
        "            runner: ${{ vars.DESKTOP_MACOS_SIGNING_RUNNER || 'macos-14' }}\n            bundles: deb",
      ),
    ).length > 0,
  );
  // release: the variable is for the macOS legs only
  assert.ok(
    desktopRunnerViolations(
      mutate(
        '            runner: windows-latest\n            installer_dir: nsis',
        "            runner: ${{ vars.DESKTOP_MACOS_SIGNING_RUNNER || 'macos-14' }}\n            installer_dir: nsis",
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
        /\|\| 'macos-14' \}\}\n(\s+)- target: x86_64-apple-darwin/,
        "|| 'self-hosted' }}\n$1- target: x86_64-apple-darwin",
      ),
    ).some((v) => v.startsWith('release: runner')),
  );
});

/** The `runs-on` line of each desktop-release.yml job, comments aside. */
function desktopRunsOn(text) {
  const result = {};
  let job;
  for (const line of text.split('\n')) {
    const header = line.match(/^  ([A-Za-z][\w-]*):\s*$/);
    if (header) job = header[1];
    const runs = line.match(/^    runs-on:\s*(.*)$/);
    if (runs) result[job] = runs[1];
  }
  return result;
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

test('test matrices retain the hosted three-shard parallelism', () => {
  const declarations = runnerDeclarations('test-suite.yml');

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
