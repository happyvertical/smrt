import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import test from 'node:test';

const guard = new URL('./check-test-resource-cleanup.mjs', import.meta.url);
let callerTmpdir;

function startGuard(source, options = {}) {
  const command = options.command ?? process.execPath;
  const commandArgs = options.command ? [] : ['--input-type=module', '--eval', source];
  let resolveRun;
  let rejectRun;
  const completed = new Promise((resolve, reject) => {
    resolveRun = resolve;
    rejectRun = reject;
  });
  let stdout = '';
  let stderr = '';
  const child = spawn(process.execPath, [guard.pathname, '--', command, ...commandArgs], {
    env: { ...process.env, TMPDIR: callerTmpdir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.once('error', rejectRun);
  child.once('close', (code) => resolveRun({ code, stdout, stderr }));
  return { child, completed, output: () => stdout };
}

async function runGuard(source, options = {}) {
  return startGuard(source, options).completed;
}

async function waitFor(predicate) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for child output');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function isProcessLive(pid) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
  if (process.platform !== 'linux') return true;
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    return !/^\d+ \(.*\) Z /.test(stat);
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

test.before(async () => {
  callerTmpdir = await mkdtemp(join(process.cwd(), '.test-resource-cleanup-'));
});
test.after(async () => {
  await rm(callerTmpdir, { recursive: true, force: true });
});

test('passes a clean command and removes its owned root', async () => {
  const result = await runGuard("console.log([process.env.TMPDIR, process.env.TMP, process.env.TEMP, process.env.CI_TEST_TMPDIR, process.env.NODE_COMPILE_CACHE].join('|'))");
  const roots = result.stdout.trim().split('|');
  const root = roots[0];
  assert.equal(result.code, 0, result.stderr);
  assert.match(root, /smrt-run-.*\/tmp$/);
  assert.deepEqual(roots.slice(0, 4), [root, root, root, root]);
  assert.equal(roots[4], join(dirname(root), 'node-compile-cache'));
  await assert.rejects(readFile(root));
});

test('reclaims the owned compiler cache while fixture leaks still fail', async () => {
  const result = await runGuard("import { writeFile } from 'node:fs/promises'; import { join } from 'node:path'; await writeFile(join(process.env.NODE_COMPILE_CACHE, 'cache.bin'), 'cache'); await writeFile(join(process.env.TMPDIR, 'fixture-leak'), 'leak'); console.log(`${process.env.TMPDIR}|${process.env.NODE_COMPILE_CACHE}`)");
  const [fixtureRoot, compileCache] = result.stdout.trim().split('|');
  assert.equal(result.code, 1);
  assert.match(result.stderr, /fixture-leak/);
  assert.doesNotMatch(result.stderr, /cache\.bin/);
  await assert.rejects(readFile(fixtureRoot));
  await assert.rejects(readFile(compileCache));
});

test('reports nested hidden and unrelated cache-looking leftovers while reserving exact tool caches', async () => {
  const result = await runGuard("import { mkdir, writeFile } from 'node:fs/promises'; import { join } from 'node:path'; const exactTsxCache = join(process.env.TMPDIR, `tsx-${process.geteuid()}`); const exactJitiCache = join(process.env.TMPDIR, 'jiti'); await mkdir(join(process.env.TMPDIR, '.hidden', 'nested'), { recursive: true }); await mkdir(exactTsxCache, { recursive: true }); await mkdir(exactJitiCache, { recursive: true }); await mkdir(join(process.env.TMPDIR, 'tsx-other'), { recursive: true }); await mkdir(join(process.env.TMPDIR, 'jiti-other'), { recursive: true }); await writeFile(join(exactTsxCache, 'cache'), 'x'); await writeFile(join(exactJitiCache, 'cache'), 'x'); await writeFile(join(process.env.TMPDIR, '.hidden', 'nested', 'artifact'), 'x'); await writeFile(join(process.env.TMPDIR, 'tsx-other', 'artifact'), 'x'); await writeFile(join(process.env.TMPDIR, 'jiti-other', 'artifact'), 'x'); await writeFile(join(process.env.TMPDIR, 'unrelated.txt'), 'x');");
  assert.equal(result.code, 1);
  for (const path of ['.hidden', 'nested', 'tsx-other', 'jiti-other', 'artifact', 'unrelated.txt']) assert.match(result.stderr, new RegExp(path));
  assert.doesNotMatch(result.stderr, /tsx-\d+\/cache/);
  assert.doesNotMatch(result.stderr, /jiti\/cache/);
});

test('preserves a failing command exit code', async () => {
  const result = await runGuard("import { writeFile } from 'node:fs/promises'; import { join } from 'node:path'; await writeFile(join(process.env.TMPDIR, 'failure.txt'), 'x'); process.exit(23)");
  assert.equal(result.code, 23);
  assert.match(result.stderr, /failure\.txt/);
});

test('reports startup failures and still removes its owned root', async () => {
  const before = await readdir(callerTmpdir);
  const result = await runGuard('', { command: 'definitely-not-a-smrt-test-command' });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /could not start/i);
  assert.deepEqual(await readdir(callerTmpdir), before);
});

test('uses a fresh owned root for repeated executions', async () => {
  const first = await runGuard('console.log(process.env.TMPDIR)');
  const second = await runGuard('console.log(process.env.TMPDIR)');
  assert.equal(first.code, 0, first.stderr);
  assert.equal(second.code, 0, second.stderr);
  assert.notEqual(first.stdout.trim(), second.stdout.trim());
});

test('does not follow symlink targets while inspecting or cleaning', async () => {
  const outside = join(callerTmpdir, 'outside.txt');
  await writeFile(outside, 'keep');
  const result = await runGuard(`import { symlink } from 'node:fs/promises'; import { join } from 'node:path'; await symlink(${JSON.stringify(outside)}, join(process.env.TMPDIR, 'outside-link'));`);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /outside-link \(symlink\)/);
  assert.equal(await readFile(outside, 'utf8'), 'keep');
});

test('refuses a substituted managed Jiti cache directory without touching its target', async () => {
  const outside = join(callerTmpdir, 'jiti-target');
  await writeFile(outside, 'keep');
  const result = await runGuard(`import { rm, symlink } from 'node:fs/promises'; import { join } from 'node:path'; const cache = join(process.env.TMPDIR, 'jiti'); await rm(cache, { recursive: true }); await symlink(${JSON.stringify(outside)}, cache);`);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /managed tool cache is not an owned directory/);
  assert.equal(await readFile(outside, 'utf8'), 'keep');
});

test('does not delete caller-owned siblings', async () => {
  const sibling = join(callerTmpdir, 'caller-owned.txt');
  await writeFile(sibling, 'keep');
  const result = await runGuard('');
  assert.equal(result.code, 0, result.stderr);
  assert.equal(await readFile(sibling, 'utf8'), 'keep');
});

test('stops a surviving worker after its parent exits normally', async () => {
  const descendantProgram = "process.on('SIGTERM', () => {}); process.send?.('ready'); setInterval(() => {}, 1_000);";
  const source = `import { spawn } from 'node:child_process'; const descendant = spawn(process.execPath, ['--eval', ${JSON.stringify(descendantProgram)}], { env: process.env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }); descendant.once('message', () => { descendant.disconnect(); descendant.unref(); console.log(\`root:\${process.env.TMPDIR}|descendant:\${descendant.pid}\`); });`;
  const execution = startGuard(source);
  await waitFor(() => /root:.+\|descendant:\d+/.test(execution.output()));
  const root = execution.output().match(/root:(.+)\|descendant:/)[1];
  const pid = Number(execution.output().match(/descendant:(\d+)/)[1]);
  try {
    const result = await execution.completed;
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stderr, /left a surviving worker process group/);
    await assert.rejects(readFile(root));
    assert.equal(await isProcessLive(pid), false);
  } finally {
    if (await isProcessLive(pid)) process.kill(pid, 'SIGKILL');
  }
});

test('preserves a failing parent exit code when it also leaves a worker', async () => {
  const descendantProgram = "process.on('SIGTERM', () => {}); process.send?.('ready'); setInterval(() => {}, 1_000);";
  const source = `import { spawn } from 'node:child_process'; const descendant = spawn(process.execPath, ['--eval', ${JSON.stringify(descendantProgram)}], { env: process.env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }); descendant.once('message', () => { descendant.disconnect(); descendant.unref(); console.log(\`descendant:\${descendant.pid}\`); process.exitCode = 23; });`;
  const execution = startGuard(source);
  await waitFor(() => /descendant:\d+/.test(execution.output()));
  const pid = Number(execution.output().match(/descendant:(\d+)/)[1]);
  try {
    const result = await execution.completed;
    assert.equal(result.code, 23, result.stderr);
    assert.match(result.stderr, /left a surviving worker process group/);
    assert.equal(await isProcessLive(pid), false);
  } finally {
    if (await isProcessLive(pid)) process.kill(pid, 'SIGKILL');
  }
});

test('waits for group escalation when a parent exits on SIGTERM and its worker survives', async () => {
  const descendantProgram = "process.on('SIGTERM', () => {}); process.send?.('ready'); setInterval(() => {}, 1_000);";
  const source = `import { spawn } from 'node:child_process'; const descendant = spawn(process.execPath, ['--eval', ${JSON.stringify(descendantProgram)}], { env: process.env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }); descendant.once('message', () => { descendant.disconnect(); console.log(\`root:\${process.env.TMPDIR}|descendant:\${descendant.pid}\`); }); process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1_000);`;
  const execution = startGuard(source);
  await waitFor(() => /root:.+\|descendant:\d+/.test(execution.output()));
  const root = execution.output().match(/root:(.+)\|descendant:/)[1];
  const pid = Number(execution.output().match(/descendant:(\d+)/)[1]);
  execution.child.kill('SIGTERM');
  try {
    const result = await execution.completed;
    assert.equal(result.code, 143, result.stderr);
    assert.doesNotMatch(result.stderr, /::error::Test command left a surviving worker/);
    await assert.rejects(readFile(root));
    assert.equal(await isProcessLive(pid), false);
  } finally {
    if (await isProcessLive(pid)) process.kill(pid, 'SIGKILL');
  }
});
