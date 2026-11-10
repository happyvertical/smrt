import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * Regression guard for #4685: the launcher that `.mcp.json` points at must keep
 * stdout protocol-only. `pnpm exec` printed a banner there and every client
 * reported CONNECTION_CLOSED.
 */
const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
);
const launcher = join(repoRoot, 'scripts', 'mcp-servers', 'smrt-dev-mcp.mjs');
const distEntry = join(
  repoRoot,
  'packages',
  'smrt-dev-mcp',
  'dist',
  'index.js',
);
const hasDist = existsSync(distEntry);

const initialize = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'launcher-test', version: '0' },
  },
};

let child: ChildProcess | undefined;

afterEach(() => {
  child?.kill('SIGKILL');
  child = undefined;
});

function firstStdoutLine(entry: 'dist' | 'tsx') {
  return new Promise<{ line: string; stderr: string }>(
    (resolveLine, reject) => {
      const proc = spawn(process.execPath, [launcher, repoRoot], {
        cwd: repoRoot,
        env: { ...process.env, DEBUG: 'false', SMRT_DEV_MCP_ENTRY: entry },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      child = proc;
      let stdout = '';
      let stderr = '';
      proc.stderr?.on('data', (chunk) => {
        stderr += String(chunk);
      });
      proc.stdout?.on('data', (chunk) => {
        stdout += String(chunk);
        const newline = stdout.indexOf('\n');
        if (newline !== -1) {
          resolveLine({ line: stdout.slice(0, newline), stderr });
        }
      });
      proc.on('error', reject);
      proc.on('exit', (code) => {
        if (!stdout.includes('\n')) {
          reject(
            new Error(
              `launcher exited (${code}) before a stdout line: ${stderr}`,
            ),
          );
        }
      });
      proc.stdin?.write(`${JSON.stringify(initialize)}\n`);
    },
  );
}

describe('smrt-dev-mcp stdio launcher', () => {
  const modes: Array<'dist' | 'tsx'> = hasDist ? ['tsx', 'dist'] : ['tsx'];

  for (const entry of modes) {
    it(`first stdout line is the initialize response (${entry} entry)`, async () => {
      const { line } = await firstStdoutLine(entry);
      const message = JSON.parse(line);
      expect(message.jsonrpc).toBe('2.0');
      expect(message.id).toBe(1);
      expect(message.result.serverInfo.name).toBe('smrt-dev-mcp');
    }, 60_000);
  }

  it('says nothing on stdout of its own when the entry is invalid', async () => {
    const proc = spawn(process.execPath, [launcher], {
      cwd: repoRoot,
      env: { ...process.env, SMRT_DEV_MCP_ENTRY: 'bogus' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child = proc;
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    proc.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    const code = await new Promise<number | null>((done) =>
      proc.on('exit', done),
    );
    expect(code).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('SMRT_DEV_MCP_ENTRY');
  }, 30_000);
});
