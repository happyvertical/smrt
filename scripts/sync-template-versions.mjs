#!/usr/bin/env node
/**
 * Sync starter-template @happyvertical/smrt-* version pins to the monorepo's
 * current release.
 *
 * The starter templates under `packages/<pkg>/template/` ship as static files
 * inside their published package, so a downstream project scaffolded from them
 * consumes `@happyvertical/smrt-*` as real npmjs dependencies. Those pins
 * therefore cannot use `workspace:*` (pnpm only rewrites the publishing
 * package's own manifest, not nested files shipped via `files`), and they must
 * NOT be chased independently by Renovate — that produces self-referential,
 * perpetually-stale PRs (#1698/#1699/#1700). Instead the release pipeline runs
 * this script so the templates always reference the version being published.
 *
 * Renovate is configured to skip these files (see renovate.json).
 *
 * Usage:
 *   node scripts/sync-template-versions.mjs [version]   # write pins (^version)
 *   node scripts/sync-template-versions.mjs --check      # exit 1 if out of sync
 *
 * When no version is given it falls back to packages/core/package.json (the
 * monorepo's version source of truth — all @happyvertical/smrt-* packages are
 * version-locked together via changesets).
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const packagesDir = join(repoRoot, 'packages');

const SMRT_DEP_RE = /^@happyvertical\/smrt-[a-z0-9-]+$/;

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const versionArg = args.find((a) => !a.startsWith('--'));

/** Resolve the release version: explicit arg, else packages/core/package.json. */
function resolveVersion() {
  if (versionArg) return versionArg.replace(/^\^|^v/, '');
  const corePkg = JSON.parse(
    readFileSync(join(packagesDir, 'core', 'package.json'), 'utf8'),
  );
  return corePkg.version;
}

const version = resolveVersion();
const targetRange = `^${version}`;

if (!/^\d+\.\d+\.\d+/.test(version)) {
  console.error(`[sync-template-versions] Invalid version: "${version}"`);
  process.exit(1);
}

/** Find every `packages/<pkg>/template/` scaffold directory. */
function findTemplateDirs() {
  const dirs = [];
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const templateDir = join(packagesDir, entry.name, 'template');
    try {
      readFileSync(join(templateDir, 'package.json'));
      dirs.push({ pkg: entry.name, templateDir });
    } catch {
      // No template/package.json — skip.
    }
  }
  return dirs;
}

const drift = [];

/** Rewrite smrt-* pins inside a template's package.json (deps + devDeps). */
function syncTemplatePackageJson(file) {
  const raw = readFileSync(file, 'utf8');
  const pkg = JSON.parse(raw);
  let changed = false;
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
    const deps = pkg[field];
    if (!deps) continue;
    for (const name of Object.keys(deps)) {
      if (SMRT_DEP_RE.test(name) && deps[name] !== targetRange) {
        drift.push(`${file}: ${name} ${deps[name]} -> ${targetRange}`);
        deps[name] = targetRange;
        changed = true;
      }
    }
  }
  if (changed && !checkOnly) {
    writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
  }
  return changed;
}

/**
 * Rewrite smrt-* pins inside a template.config.js. It is a JS module rather
 * than JSON, so we string-replace the quoted version that follows each smrt-*
 * key instead of parsing it.
 */
function syncTemplateConfigJs(file) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return false;
  }
  const re =
    /(['"]@happyvertical\/smrt-[a-z0-9-]+['"]\s*:\s*)(['"])\^?\d[^'"]*(['"])/g;
  let changed = false;
  const next = raw.replace(re, (match, keyPart, openQuote, closeQuote) => {
    const replacement = `${keyPart}${openQuote}${targetRange}${closeQuote}`;
    if (replacement !== match) {
      drift.push(`${file}: ${match.trim()} -> ...${targetRange}`);
      changed = true;
    }
    return replacement;
  });
  if (changed && !checkOnly) {
    writeFileSync(file, next);
  }
  return changed;
}

const templates = findTemplateDirs();
let anyChanged = false;
for (const { pkg, templateDir } of templates) {
  if (syncTemplatePackageJson(join(templateDir, 'package.json'))) {
    anyChanged = true;
  }
  // template.config.js lives next to the template/ directory.
  if (syncTemplateConfigJs(join(packagesDir, pkg, 'template.config.js'))) {
    anyChanged = true;
  }
}

if (checkOnly) {
  if (anyChanged) {
    console.error(
      `[sync-template-versions] Template smrt-* pins are out of sync with ${targetRange}:`,
    );
    for (const line of drift) console.error(`  ${line}`);
    console.error('Run: node scripts/sync-template-versions.mjs');
    process.exit(1);
  }
  console.log(
    `[sync-template-versions] Template smrt-* pins are in sync with ${targetRange}.`,
  );
  process.exit(0);
}

if (anyChanged) {
  console.log(`[sync-template-versions] Synced template smrt-* pins to ${targetRange}:`);
  for (const line of drift) console.log(`  ${line}`);
} else {
  console.log(
    `[sync-template-versions] Template smrt-* pins already at ${targetRange}; nothing to do.`,
  );
}
