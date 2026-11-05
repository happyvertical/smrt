#!/usr/bin/env node
/**
 * Copies the committed OKF knowledge pages into each package's publish output
 * (#4689) so a consumer's `smrt docs:agents` can export them without the
 * monorepo checkout.
 *
 *   docs/knowledge/components/<unscoped-name>.md -> packages/<dir>/dist/smrt-knowledge.okf.md
 *   docs/knowledge/intents/*.md                 -> packages/{cli,smrt-dev-mcp}/dist/knowledge/intents/
 *
 * The page sits next to `dist/smrt-knowledge.json` and rides the `dist` entry
 * every package already lists in `files`, so no package.json changes. This is a
 * pure copy: it never regenerates pages (`pnpm knowledge:okf` owns that, and
 * `pnpm knowledge:check` gates the committed copies), so `pnpm build` leaves
 * the checkout clean. Run after the package builds (root `pnpm build`, and
 * `scripts/prepack-package.js` for a non-CI rebuild), because a build empties
 * `dist/`.
 *
 * Packages that publish no `dist/` (private packages, the two scaffold
 * templates) ship no page. A public package with a `dist/` but no committed
 * page is an error: run `pnpm knowledge:okf`.
 *
 * Contract constants mirror `packages/smrt-dev-mcp/src/knowledge/okf-bundle.ts`.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SHIPPED_COMPONENT_PAGE = 'smrt-knowledge.okf.md';
export const SHIPPED_INTENTS_DIR = join('knowledge', 'intents');
// The full, unfiltered intent set ships with the CLI (docs:agents export source)
// and with smrt-dev-mcp (the trusted duplicate-detection index, #4690).
const INTENT_HOME_PACKAGES = [
  '@happyvertical/smrt-cli',
  '@happyvertical/smrt-dev-mcp',
];

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * Ship the pages for one package directory. Returns the files written
 * (relative to the package), or [] when the package publishes no dist.
 */
export function shipPackageKnowledge(packageDir, rootDir = defaultRoot) {
  const pkg = readJson(join(packageDir, 'package.json'));
  if (pkg.private || !existsSync(join(packageDir, 'dist'))) return [];
  const unscoped = String(pkg.name).replace(/^@[^/]+\//, '');
  const source = join(
    rootDir,
    'docs',
    'knowledge',
    'components',
    `${unscoped}.md`,
  );
  if (!existsSync(source)) {
    throw new Error(
      `${pkg.name} has no committed knowledge page at docs/knowledge/components/${unscoped}.md; run \`pnpm knowledge:okf\`.`,
    );
  }
  const written = [];
  copyFileSync(source, join(packageDir, 'dist', SHIPPED_COMPONENT_PAGE));
  written.push(join('dist', SHIPPED_COMPONENT_PAGE));

  if (INTENT_HOME_PACKAGES.includes(pkg.name)) {
    const intentsSource = join(rootDir, 'docs', 'knowledge', 'intents');
    const intentsTarget = join(packageDir, 'dist', SHIPPED_INTENTS_DIR);
    // Replace, never merge: a retired intent page must not linger in dist.
    rmSync(intentsTarget, { recursive: true, force: true });
    mkdirSync(intentsTarget, { recursive: true });
    for (const name of readdirSync(intentsSource)) {
      if (!name.endsWith('.md')) continue;
      copyFileSync(join(intentsSource, name), join(intentsTarget, name));
      written.push(join('dist', SHIPPED_INTENTS_DIR, name));
    }
  }
  return written;
}

/** Ship the pages for every workspace package. */
export function shipAllKnowledge(rootDir = defaultRoot) {
  const packagesDir = join(rootDir, 'packages');
  let shipped = 0;
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(packagesDir, entry.name);
    if (!existsSync(join(dir, 'package.json'))) continue;
    if (shipPackageKnowledge(dir, rootDir).length > 0) shipped += 1;
  }
  return shipped;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    // `pnpm build --force` appends its flags to the last command; ignore them.
    const target = process.argv.slice(2).find((arg) => !arg.startsWith('-'));
    if (target) {
      const written = shipPackageKnowledge(resolve(target));
      console.log(`[knowledge:ship] ${written.length} file(s) for ${target}`);
    } else {
      console.log(
        `[knowledge:ship] shipped pages into ${shipAllKnowledge()} package(s)`,
      );
    }
  } catch (error) {
    console.error(`[knowledge:ship] ${error.message}`);
    process.exit(1);
  }
}
