#!/usr/bin/env node
/**
 * Plain-Node stdio launcher for the smrt-dev-mcp server.
 *
 * MCP over stdio requires stdout to carry only JSON-RPC, so this launcher runs
 * no package manager (`pnpm exec` prints a verification banner to stdout and
 * may install). It picks one of two entries:
 *   - packages/smrt-dev-mcp/dist/index.js, when newer than every file in src/
 *   - src/index.ts through the workspace node_modules/.bin/tsx, resolved by path
 * Anything this launcher says goes to stderr. Stdio is inherited by the child.
 *
 * SMRT_DEV_MCP_ENTRY=dist|tsx forces an entry (used by the protocol test).
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const packageRoot = join(repoRoot, 'packages', 'smrt-dev-mcp');
const distEntry = join(packageRoot, 'dist', 'index.js');
const srcEntry = join(packageRoot, 'src', 'index.ts');
const tsxBin = join(repoRoot, 'node_modules', '.bin', 'tsx');

const say = (message) =>
  process.stderr.write(`[smrt-dev-mcp launcher] ${message}\n`);

function newestMtime(dir) {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    const mtime = entry.isDirectory()
      ? newestMtime(path)
      : statSync(path).mtimeMs;
    if (mtime > newest) newest = mtime;
  }
  return newest;
}

function distIsFresh() {
  if (!existsSync(distEntry)) return false;
  return statSync(distEntry).mtimeMs >= newestMtime(join(packageRoot, 'src'));
}

const forced = process.env.SMRT_DEV_MCP_ENTRY;
if (forced && forced !== 'dist' && forced !== 'tsx') {
  say(`SMRT_DEV_MCP_ENTRY must be "dist" or "tsx", got "${forced}"`);
  process.exit(1);
}
const mode = forced ?? (distIsFresh() ? 'dist' : 'tsx');

let command;
let args;
if (mode === 'dist') {
  if (!existsSync(distEntry)) {
    say(`dist entry missing: ${distEntry}; build @happyvertical/smrt-dev-mcp`);
    process.exit(1);
  }
  command = process.execPath;
  args = [distEntry, ...process.argv.slice(2)];
} else {
  if (!existsSync(tsxBin)) {
    say(
      `tsx not found at ${tsxBin}; run pnpm install (the launcher never installs)`,
    );
    process.exit(1);
  }
  command = tsxBin;
  args = [srcEntry, ...process.argv.slice(2)];
}

const child = spawn(command, args, { stdio: 'inherit' });

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    if (!child.killed) child.kill(signal);
  });
}

child.on('error', (error) => {
  say(`failed to start ${command}: ${error.message}`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (code !== null) process.exit(code);
  process.exit(signal === 'SIGINT' ? 130 : signal === 'SIGHUP' ? 129 : 143);
});
