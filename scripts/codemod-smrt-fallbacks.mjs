#!/usr/bin/env node
/**
 * Strips hardcoded fallbacks from `var(--smrt-…, <literal>)` (issue #3826).
 *
 * A fallback is removed only when its token is theme-required: the completeness
 * test (`src/themes/__tests__/required-tokens.test.ts`) proves every preset and
 * `createTheme()` output defines every required token, so the literal can never
 * apply and only hides a missing token behind a silent Material-blue colour or a
 * stale pixel value. Component-private tokens (`--smrt-<component>-*`) and
 * override hooks keep their fallbacks: they are not theme tokens, so removing
 * the literal could blank a component that is rendered outside its defining
 * ancestor.
 *
 * Literals handled: `#hex` (every hex fallback must go; the required-name rule is
 * the only exemption and none exist) and `<n>px` fallbacks.
 *
 * Idempotent. Scope: `.svelte` and `.css` sources under `packages/*\/src`,
 * excluding test files.
 *
 * Usage:
 *   node scripts/codemod-smrt-fallbacks.mjs           # rewrite files
 *   node scripts/codemod-smrt-fallbacks.mjs --check   # exit 1 if a required-token fallback remains
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { allPackageSrcDirs, listFiles, ROOT } from './smrt-token-scan-lib.mjs';

const TEST_FILE = /__tests__|\.(test|spec)\./;
const FALLBACK_RE =
  /var\(\s*(--smrt-[a-zA-Z0-9_-]+)\s*,\s*(#[0-9a-fA-F]{3,8}|-?\d*\.?\d+px)\s*\)/g;

const REQUIRED = new Set(
  JSON.parse(
    readFileSync(join(ROOT, 'packages/smrt-ui/src/themes/required-tokens.generated.json'), 'utf8'),
  ).required,
);

/** `{ text, count, kept }`: required-token fallbacks are stripped, others kept. */
export function stripFallbacks(text, required = REQUIRED) {
  let count = 0;
  let kept = 0;
  const out = text.replace(FALLBACK_RE, (match, name) => {
    if (!required.has(name)) {
      kept++;
      return match;
    }
    count++;
    return `var(${name})`;
  });
  return { text: out, count, kept };
}

function main() {
  const check = process.argv.includes('--check');
  let total = 0;
  let keptTotal = 0;
  const changedFiles = [];
  for (const { dir } of allPackageSrcDirs()) {
    for (const file of listFiles(dir, ['.svelte', '.css'])) {
      if (TEST_FILE.test(file)) continue;
      const original = readFileSync(file, 'utf8');
      const { text, count, kept } = stripFallbacks(original);
      keptTotal += kept;
      if (count === 0) continue;
      total += count;
      changedFiles.push(file);
      if (!check) writeFileSync(file, text);
    }
  }
  if (check) {
    if (total > 0) {
      console.error(
        `${total} fallback(s) on theme-required tokens remain in ${changedFiles.length} file(s); run scripts/codemod-smrt-fallbacks.mjs`,
      );
      process.exit(1);
    }
    console.log(`smrt fallbacks on required tokens: none (${keptTotal} component-private fallback(s) kept).`);
    process.exit(0);
  }
  console.log(
    `stripped ${total} fallback(s) across ${changedFiles.length} file(s); kept ${keptTotal} component-private fallback(s).`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();
