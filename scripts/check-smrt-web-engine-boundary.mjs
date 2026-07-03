#!/usr/bin/env node
/**
 * Engine-boundary guard for @happyvertical/smrt-web (#1761, ratified condition #2).
 *
 * The client-data engine (currently TanStack DB) must stay an implementation
 * detail: no `@tanstack/*` type may appear in smrt-web's PUBLIC API. If an
 * exported type references an engine type, `tsc` emits a `@tanstack/...`
 * reference into the corresponding `.d.ts` — as a quoted module specifier
 * (`from '@tanstack/…'`, `import('@tanstack/…')`), so scanning for that is an
 * exact check. Matching the quoted specifier (not a bare substring) means
 * doc-comment prose that mentions `@tanstack/*` in backticks is not a false
 * positive. Runs as the last step of `smrt-web`'s build; a leak fails the
 * build (and thus CI).
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const distDir = fileURLToPath(
  new URL('../packages/smrt-web/dist', import.meta.url),
);

/** Recursively collect every `.d.ts` file under `dir`. */
function collectDeclarations(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...collectDeclarations(full));
    } else if (entry.name.endsWith('.d.ts')) {
      found.push(full);
    }
  }
  return found;
}

if (!existsSync(distDir)) {
  console.error(
    '[smrt-web boundary] packages/smrt-web/dist not found — build must run first',
  );
  process.exit(1);
}

const files = collectDeclarations(distDir).sort();
if (files.length === 0) {
  console.error(
    '[smrt-web boundary] no .d.ts found under packages/smrt-web/dist — build must run first',
  );
  process.exit(1);
}

// A real engine reference in a `.d.ts` is always a quoted module specifier
// (`from '@tanstack/…'` or inline `import("@tanstack/…")`). Backtick prose in
// doc comments is not.
const ENGINE_SPECIFIER = /["']@tanstack\//;

const leaks = [];
for (const file of files) {
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (ENGINE_SPECIFIER.test(line)) {
      leaks.push({ file, line: i + 1, text: line.trim() });
    }
  });
}

if (leaks.length > 0) {
  console.error(
    '[smrt-web boundary] FAIL — public API leaks engine (@tanstack) types:',
  );
  for (const leak of leaks) {
    const rel = leak.file.slice(leak.file.indexOf('packages/'));
    console.error(`  ${rel}:${leak.line}: ${leak.text}`);
  }
  console.error(
    '\nWrap engine types behind a SMRT-owned type so the engine stays swappable.',
  );
  process.exit(1);
}

console.log(
  `[smrt-web boundary] OK — ${files.length} declaration file(s) engine-agnostic`,
);
