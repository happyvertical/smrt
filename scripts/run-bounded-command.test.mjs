import { execFile } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = new URL('..', import.meta.url);
const helper = new URL('./run-bounded-command.mjs', import.meta.url);

async function run(options, command = [process.execPath, '--eval', 'process.exit(0)']) {
  try {
    return await execFileAsync(process.execPath, [helper.pathname, ...options, '--', ...command], {
      cwd: root,
    });
  } catch (error) {
    return error;
  }
}

async function hasTerminated(pid) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return error.code === 'ESRCH';
  }
  if (process.platform !== 'linux') return false;
  const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
  return stat.split(' ')[2] === 'Z';
}

test('completes successful commands', async () => {
  const result = await run(['--stage', 'apt-get update', '--timeout-seconds', '1']);
  assert.equal(result.code, undefined);
});

test('reports a stage-specific nonzero failure', async () => {
  const result = await run(
    ['--stage', 'apt-get update', '--timeout-seconds', '1'],
    [process.execPath, '--eval', 'process.stderr.write("offline index failure\\n"); process.exit(17)'],
  );
  assert.equal(result.code, 1);
  assert.match(result.stderr, /offline index failure/);
  assert.match(result.stderr, /ONNX system dependency apt-get update failed with exit code 17/);
});

test('reports an install-stage nonzero failure', async () => {
  const result = await run(
    ['--stage', 'apt-get install', '--timeout-seconds', '1'],
    [process.execPath, '--eval', 'process.exit(23)'],
  );
  assert.equal(result.code, 1);
  assert.match(result.stderr, /ONNX system dependency apt-get install failed with exit code 23/);
});

test('times out and terminates an owned SIGTERM-resistant process group', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'smrt-bounded-command-'));
  const childPath = join(directory, 'child.mjs');
  const grandchildPath = join(directory, 'grandchild.mjs');
  const pidsPath = join(directory, 'pids.json');
  await writeFile(grandchildPath, "process.on('SIGTERM', () => {}); setInterval(() => {}, 1_000);\n");
  await writeFile(
    childPath,
    [
      "import { spawn } from 'node:child_process';",
      "import { writeFile } from 'node:fs/promises';",
      "process.on('SIGTERM', () => {});",
      `const grandchild = spawn(process.execPath, [${JSON.stringify(grandchildPath)}], { stdio: 'ignore' });`,
      `await writeFile(${JSON.stringify(pidsPath)}, JSON.stringify([process.pid, grandchild.pid]));`,
      'setInterval(() => {}, 1_000);',
      '',
    ].join('\n'),
  );

  try {
    const result = await run(
      ['--stage', 'apt-get install', '--timeout-seconds', '1', '--grace-ms', '100'],
      [process.execPath, childPath],
    );
    assert.equal(result.code, 124);
    assert.match(result.stderr, /ONNX system dependency apt-get install timed out after 1 seconds/);
    const pids = JSON.parse(await readFile(pidsPath, 'utf8'));
    await new Promise((resolve) => setTimeout(resolve, 100));
    for (const pid of pids) {
      assert.equal(await hasTerminated(pid), true, `pid ${pid} is still running`);
    }
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test('the setup action bounds update and install without changing ONNX dependencies', async () => {
  const action = await readFile(new URL('../.github/actions/setup-environment/action.yml', import.meta.url), 'utf8');
  const readyCheck = action.indexOf('CI_ONNX_DEPS_READY:-}');
  const boundedUpdate = action.indexOf("--stage 'apt-get update'");
  const projectInstall = action.indexOf('Install project dependencies');
  assert.ok(readyCheck >= 0 && readyCheck < boundedUpdate);
  assert.ok(boundedUpdate >= 0 && boundedUpdate < projectInstall);
  assert.ok(action.includes('node_path="$(command -v node)"'));
  assert.match(
    action,
    /sudo "\$node_path" "\$GITHUB_WORKSPACE\/scripts\/run-bounded-command\.mjs"\s+\\\n\s+--stage 'apt-get update'\s+\\\n\s+--timeout-seconds 300\s+\\\n\s+-- apt-get update &&/,
  );
  assert.match(
    action,
    /sudo "\$node_path" "\$GITHUB_WORKSPACE\/scripts\/run-bounded-command\.mjs"\s+\\\n\s+--stage 'apt-get install'\s+\\\n\s+--timeout-seconds 900\s+\\\n\s+-- apt-get install -y/,
  );
  for (const dependency of [
    'libstdc++6',
    'libc6-dev',
    'build-essential',
    'gcc',
    'g++',
    'cmake',
    'libgomp1',
    'libprotobuf-dev',
  ]) {
    assert.ok(action.includes(`          ${dependency}`));
  }
});
