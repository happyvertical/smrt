import { execFile } from 'node:child_process';
import assert from 'node:assert/strict';
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

async function doesNotExist(path) {
  await assert.rejects(access(path));
}

async function runActionSystemDependencies(directory) {
  const action = await readFile(new URL('../.github/actions/setup-environment/action.yml', import.meta.url), 'utf8');
  const section = action.slice(action.indexOf('    - name: Install system dependencies for ONNX Runtime'));
  const run = section.match(/      run: \|\n([\s\S]*?)\n\n    - name:/)?.[1];
  assert.ok(run, 'expected ONNX system-dependency action script');
  const bin = join(directory, 'bin');
  const installMarker = join(directory, 'install-ran');
  const projectMarker = join(directory, 'project-ran');
  await mkdir(bin);
  await writeFile(join(bin, 'dpkg'), '#!/bin/sh\nexit 1\n');
  await writeFile(join(bin, 'sudo'), '#!/bin/sh\nexec "$@"\n');
  await writeFile(
    join(bin, 'apt-get'),
    '#!/bin/sh\nif [ "$1" = update ]; then echo "partial index failure" >&2; exit 42; fi\ntouch "$SMRT_INSTALL_MARKER"\n',
  );
  await Promise.all(['dpkg', 'sudo', 'apt-get'].map((name) => chmod(join(bin, name), 0o755)));
  const script = run.replace(/^        /gm, '').replaceAll('--backoff-seconds 10', '--backoff-seconds 0');
  const wrapper = [
    'bash -e -c "$1"',
    'status=$?',
    'if [ "$status" -eq 0 ]; then touch "$SMRT_PROJECT_MARKER"; fi',
    'exit "$status"',
  ].join('\n');
  try {
    return await execFileAsync('bash', ['-c', wrapper, 'smrt-action-probe', script], {
      cwd: root,
      env: {
        ...process.env,
        GITHUB_WORKSPACE: root.pathname,
        PATH: `${bin}:${process.env.PATH}`,
        SMRT_INSTALL_MARKER: installMarker,
        SMRT_PROJECT_MARKER: projectMarker,
      },
    });
  } catch (error) {
    await Promise.all([doesNotExist(installMarker), doesNotExist(projectMarker)]);
    return error;
  }
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

test('retains group cleanup after a TERM-exited leader leaves a resistant descendant', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'smrt-bounded-command-leader-exit-'));
  const childPath = join(directory, 'child.mjs');
  const grandchildPath = join(directory, 'grandchild.mjs');
  const pidsPath = join(directory, 'pids.json');
  await writeFile(grandchildPath, "process.on('SIGTERM', () => {}); setInterval(() => {}, 1_000);\n");
  await writeFile(
    childPath,
    [
      "import { spawn } from 'node:child_process';",
      "import { writeFile } from 'node:fs/promises';",
      'process.on(\'SIGTERM\', () => process.exit(0));',
      `const grandchild = spawn(process.execPath, [${JSON.stringify(grandchildPath)}], { stdio: 'ignore' });`,
      `await writeFile(${JSON.stringify(pidsPath)}, JSON.stringify([process.pid, grandchild.pid]));`,
      'setInterval(() => {}, 1_000);',
      '',
    ].join('\n'),
  );
  try {
    const result = await run(
      ['--stage', 'apt-get update', '--timeout-seconds', '1', '--grace-ms', '100'],
      [process.execPath, childPath],
    );
    assert.equal(result.code, 124);
    const [, grandchildPid] = JSON.parse(await readFile(pidsPath, 'utf8'));
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(await hasTerminated(grandchildPid), true, `pid ${grandchildPid} is still running`);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test('a partial apt index failure prevents install and project progression', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'smrt-bounded-action-'));
  try {
    const result = await runActionSystemDependencies(directory);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /partial index failure/);
    assert.match(result.stderr, /ONNX system dependency apt-get update failed with exit code 42/);
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
    /sudo "\$node_path" "\$GITHUB_WORKSPACE\/scripts\/run-bounded-command\.mjs"\s+\\\n\s+--stage 'apt-get update'\s+\\\n\s+--timeout-seconds 120\s+\\\n\s+--attempts 3\s+\\\n\s+--backoff-seconds 10\s+\\\n\s+-- apt-get update -o APT::Update::Error-Mode=any &&/,
  );
  assert.match(
    action,
    /sudo "\$node_path" "\$GITHUB_WORKSPACE\/scripts\/run-bounded-command\.mjs"\s+\\\n\s+--stage 'apt-get install'\s+\\\n\s+--timeout-seconds 600\s+\\\n\s+--attempts 2\s+\\\n\s+--backoff-seconds 10\s+\\\n\s+-- apt-get install -y/,
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

async function flakyCommand(directory, failures, mode) {
  const counter = join(directory, 'count');
  const scriptPath = join(directory, 'flaky.mjs');
  await writeFile(
    scriptPath,
    [
      "import { appendFileSync, readFileSync } from 'node:fs';",
      `const counter = ${JSON.stringify(counter)};`,
      "appendFileSync(counter, 'x');",
      'const count = readFileSync(counter, \'utf8\').length;',
      `if (count <= ${failures}) {`,
      mode === 'hang' ? '  setInterval(() => {}, 1_000);' : '  process.exit(9);',
      '}',
      '',
    ].join('\n'),
  );
  return { counter, command: [process.execPath, scriptPath] };
}

test('retries a failing command and succeeds when a later attempt passes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'smrt-bounded-retry-'));
  try {
    const { counter, command } = await flakyCommand(directory, 2, 'exit');
    const result = await run(
      ['--stage', 'apt-get update', '--timeout-seconds', '5', '--attempts', '3', '--backoff-seconds', '0'],
      command,
    );
    assert.equal(result.code, undefined);
    assert.equal((await readFile(counter, 'utf8')).length, 3);
    assert.match(result.stderr, /failed with exit code 9 \(attempt 1\/3\)/);
    assert.match(result.stderr, /will retry/);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test('retries a timed-out attempt and succeeds on the next', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'smrt-bounded-retry-timeout-'));
  try {
    const { counter, command } = await flakyCommand(directory, 1, 'hang');
    const result = await run(
      [
        '--stage', 'apt-get update', '--timeout-seconds', '1', '--grace-ms', '100',
        '--attempts', '2', '--backoff-seconds', '0',
      ],
      command,
    );
    assert.equal(result.code, undefined);
    assert.equal((await readFile(counter, 'utf8')).length, 2);
    assert.match(result.stderr, /timed out after 1 seconds \(attempt 1\/2\)/);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test('fails closed with the named stage once every attempt is exhausted', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'smrt-bounded-retry-exhausted-'));
  try {
    const { counter, command } = await flakyCommand(directory, 99, 'exit');
    const result = await run(
      ['--stage', 'apt-get update', '--timeout-seconds', '5', '--attempts', '3', '--backoff-seconds', '0'],
      command,
    );
    assert.equal(result.code, 1);
    assert.equal((await readFile(counter, 'utf8')).length, 3);
    assert.match(result.stderr, /ONNX system dependency apt-get update failed with exit code 9 \(attempt 3\/3\)/);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test('exits 124 when the final attempt times out', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'smrt-bounded-retry-final-timeout-'));
  try {
    const { counter, command } = await flakyCommand(directory, 99, 'hang');
    const result = await run(
      [
        '--stage', 'apt-get update', '--timeout-seconds', '1', '--grace-ms', '100',
        '--attempts', '2', '--backoff-seconds', '0',
      ],
      command,
    );
    assert.equal(result.code, 124);
    assert.equal((await readFile(counter, 'utf8')).length, 2);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test('rejects invalid retry options', async () => {
  for (const options of [['--attempts', '0'], ['--attempts', '1.5'], ['--backoff-seconds', '-1']]) {
    const result = await run(['--stage', 'apt-get update', '--timeout-seconds', '1', ...options]);
    assert.equal(result.code, 2);
  }
});

test('the setup action skips ONNX provisioning when project dependencies are not installed', async () => {
  const action = await readFile(new URL('../.github/actions/setup-environment/action.yml', import.meta.url), 'utf8');
  assert.match(
    action,
    /- name: Install system dependencies for ONNX Runtime\n\s+if: inputs\.install-deps == 'true'\n/,
  );
});
