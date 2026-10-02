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
  const declarations = workflowFiles.flatMap(runnerDeclarations);

  for (const declaration of declarations) {
    const key = `${declaration.file}:${declaration.job}`;
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
