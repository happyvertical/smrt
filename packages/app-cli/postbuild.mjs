#!/usr/bin/env node
/**
 * Post-build sanity checks for `@happyvertical/smrt-app-cli`:
 *
 *   1. Assert the bin entry has the `#!/usr/bin/env node` shebang.
 *   2. `chmod 0755` the bin so it's executable after `npm install`.
 *   3. Assert the dist tree contains no `.test.*` artifacts.
 *   4. Assert the `./mcp-bridge` file answers MCP `initialize` on its own,
 *      from a directory with no `node_modules` (a desktop bundle ships it so).
 *
 * The build fails loudly if any of these don't hold — these are the kinds
 * of regressions that only show up after publish, so they need to be
 * caught at build time.
 */

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const distRoot = new URL('./dist/', import.meta.url);
const binPaths = [
  join(distRoot.pathname, 'bin/smrt-app.js'),
  join(distRoot.pathname, 'bin/smrt-mcp-bridge.js'),
];

for (const binPath of binPaths) {
  const binSource = readFileSync(binPath, 'utf8');
  if (!binSource.startsWith('#!/usr/bin/env node')) {
    console.error(
      `[postbuild] ${binPath} missing shebang after build (got: ${JSON.stringify(
        binSource.slice(0, 32),
      )}).`,
    );
    process.exit(1);
  }
  chmodSync(binPath, 0o755);
}

/**
 * Catch anything that looks like a test artifact slipping into `dist/`.
 * Broad pattern instead of an enumeration of suffixes — `.test.d.ts.map`,
 * `.spec.*`, and any future declaration build config drift that re-enables
 * declaration maps for excluded files all get caught here. (#1311 review #7.)
 */
const TEST_ARTIFACT_RE = /\.(test|spec)\./;

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
      continue;
    }
    if (TEST_ARTIFACT_RE.test(entry.name)) {
      console.error(`[postbuild] dist contains test artifact: ${full}`);
      process.exit(1);
    }
  }
}
walk(distRoot.pathname);

// Sanity-check that the bin is executable, not zero-byte.
for (const binPath of binPaths) {
  const stats = statSync(binPath);
  if (stats.size < 64) {
    console.error(
      `[postbuild] ${binPath} suspiciously small (${stats.size} bytes).`,
    );
    process.exit(1);
  }
}

const isolated = mkdtempSync(join(tmpdir(), 'smrt-mcp-bridge-'));
try {
  const bridge = join(isolated, 'smrt-mcp-bridge.mjs');
  copyFileSync(join(distRoot.pathname, 'bin/smrt-mcp-bridge.mjs'), bridge);
  const initialize = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'postbuild', version: '0.0.0' },
    },
  });
  const probe = spawnSync(
    process.execPath,
    [bridge, '--env-prefix=SMRT_POSTBUILD', '--name=postbuild-mcp'],
    {
      cwd: isolated,
      env: { HOME: isolated, USERPROFILE: isolated },
      input: `${initialize}\n`,
      encoding: 'utf8',
      timeout: 30_000,
    },
  );
  if (probe.status !== 0 || !probe.stdout.includes('"name":"postbuild-mcp"')) {
    console.error(
      `[postbuild] the bundled MCP bridge does not run on its own (exit ${probe.status}): ${probe.stderr.slice(0, 2000)}`,
    );
    process.exit(1);
  }
} finally {
  rmSync(isolated, { recursive: true, force: true });
}

console.log('[postbuild] ok');
