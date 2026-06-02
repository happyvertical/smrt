#!/usr/bin/env node
/**
 * Post-build sanity checks for `@happyvertical/smrt-app-cli`:
 *
 *   1. Assert the bin entry has the `#!/usr/bin/env node` shebang.
 *   2. `chmod 0755` the bin so it's executable after `npm install`.
 *   3. Assert the dist tree contains no `.test.*` artifacts.
 *
 * The build fails loudly if any of these don't hold — these are the kinds
 * of regressions that only show up after publish, so they need to be
 * caught at build time.
 */

import { chmodSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const distRoot = new URL('./dist/', import.meta.url);
const binPath = join(distRoot.pathname, 'bin/smrt-mcp-bridge.js');

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

/**
 * Catch anything that looks like a test artifact slipping into `dist/`.
 * Broad pattern instead of an enumeration of suffixes — `.test.d.ts.map`,
 * `.spec.*`, and any future vite-plugin-dts config drift that re-enables
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
const stats = statSync(binPath);
if (stats.size < 64) {
  console.error(
    `[postbuild] ${binPath} suspiciously small (${stats.size} bytes).`,
  );
  process.exit(1);
}

console.log('[postbuild] ok');
