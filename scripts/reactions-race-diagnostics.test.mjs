import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

async function runRaceWorker(code, shape = 'context') {
  const source = await readFile(new URL('../packages/reactions/src/reactions.test.ts', import.meta.url), 'utf8');
  const worker = source.match(/const worker = String\.raw`([\s\S]*?)`;/)?.[1];
  assert.ok(worker, 'exercise the actual SQLite race worker');
  const directory = await mkdtemp(join(tmpdir(), 'smrt-race-diagnostics-'));
  try {
    const runtime = join(directory, 'runtime.mjs');
    await writeFile(runtime, `
      const failure = Object.assign(new Error('database operation failed'), { code: ${JSON.stringify(code)} });
      const wrapped = ${JSON.stringify(shape)} === 'cause'
        ? new Error('Failed to execute pluck query', { cause: failure })
        : Object.assign(new Error('Failed to execute pluck query'), {
            name: 'DatabaseError', code: 'DATABASE_ERROR',
            context: { originalError: 'database operation failed, code=' + failure.code }
          });
      export const ParticipationRuntime = { create: async () => ({
        polls: { vote: async () => { throw wrapped; } },
        database: { close: async () => { process.stdout.write('DATABASE_CLOSED'); } }
      }) };
    `);
    const child = spawn(process.execPath, [
      '--input-type=module', '-e', worker, pathToFileURL(runtime).href,
      JSON.stringify({ operation: 'vote', id: 'fixture', database: {}, actor: {} }),
    ], { stdio: ['pipe', 'pipe', 'pipe'], timeout: 10_000 });
    let stdout = '';
    let stderr = '';
    let started = false;
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
      if (!started && stdout.includes('RACE_READY')) {
        started = true;
        child.stdin.end('go\n');
      }
    });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    const exit = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    assert.equal(exit, 1, 'the operation failure must remain a failure');
    assert.match(stdout, /DATABASE_CLOSED/, 'the worker still closes its database');
    return stderr;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('the real SQLite race worker retains a wrapped native busy cause for the strict parent oracle', async () => {
  assert.match(await runRaceWorker('SQLITE_BUSY'), /SQLITE_BUSY/);
});

test('the real SQLite race worker also retains standard Error.cause diagnostics', async () => {
  assert.match(await runRaceWorker('SQLITE_BUSY', 'cause'), /SQLITE_BUSY/);
});

test('unrelated wrapped failures cannot satisfy the unchanged busy oracle', async () => {
  const stderr = await runRaceWorker('SQLITE_ERROR');
  assert.match(stderr, /SQLITE_ERROR/);
  assert.doesNotMatch(stderr, /SQLITE_BUSY/);
});
