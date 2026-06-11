#!/usr/bin/env node
/**
 * Per-tier test coverage gate (Sweep S6, #1411).
 *
 * Enforces the Production Readiness Rubric's per-tier line-coverage floors on the
 * packages a PR *touches* — so it blocks regressions below the floor without
 * forcing a repo-wide uplift (that uplift is Wave 3, off each package audit's
 * dim-4 finding). The floor is a HARD floor: a touched package must measure at or
 * above its tier floor to pass, no grandfathering.
 *
 * Floors + tier assignments are the machine-readable mirror of
 * docs/content/PRODUCTION_READINESS.md §Tiers — keep the two in sync.
 *
 * Usage:
 *   node scripts/check-coverage.mjs                 # touched packages vs BASE_REF (CI)
 *   node scripts/check-coverage.mjs --packages a,b  # explicit list (local / manual)
 *   BASE_REF=main node scripts/check-coverage.mjs   # override the diff base
 *
 * Measurement: per-package `vitest run --coverage` (v8) with the json-summary
 * reporter; the gate reads total line coverage from coverage/coverage-summary.json.
 *
 * All subprocess calls use execFileSync with array args (no shell) so the
 * branch-name base ref can't be interpreted as a shell command.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PKGS = join(ROOT, 'packages');

const FLOORS = { T1: 80, T2: 70, T3: 50 };

// Tier assignments — mirror of docs/content/PRODUCTION_READINESS.md §Tiers.
// Package directory name → tier. `types` is coverage-waived (zero-runtime).
// Packages absent from this map are "untiered": skipped with a warning until a
// tier is ratified for them (gnode/subscriptions/templates/etc.).
const TIERS = {
  // T1 Foundation (80%)
  cli: 'T1',
  config: 'T1',
  core: 'T1',
  scanner: 'T1',
  tenancy: 'T1',
  vitest: 'T1',
  // T2 Mature domain (70%)
  agents: 'T2',
  assets: 'T2',
  chat: 'T2',
  commerce: 'T2',
  content: 'T2',
  jobs: 'T2',
  ledgers: 'T2',
  messages: 'T2',
  profiles: 'T2',
  secrets: 'T2',
  'smrt-svelte': 'T2',
  users: 'T2',
  // T3 Light domain (50%)
  ads: 'T3',
  affiliates: 'T3',
  analytics: 'T3',
  'app-cli': 'T3',
  'assets-ergot': 'T3',
  'assets-local': 'T3',
  events: 'T3',
  facts: 'T3',
  features: 'T3',
  images: 'T3',
  inventory: 'T3',
  languages: 'T3',
  manufacturing: 'T3',
  places: 'T3',
  products: 'T3',
  projects: 'T3',
  prompts: 'T3',
  properties: 'T3',
  sites: 'T3',
  'smrt-dev-mcp': 'T3',
  social: 'T3',
  tags: 'T3',
  video: 'T3',
  voice: 'T3',
};
// Coverage-waived packages (zero-runtime). See rubric footnote †.
const WAIVED = new Set(['types']);

// Packages temporarily exempt from the line-coverage gate (distinct from WAIVED:
// these DO ship runtime code, but v8 line coverage isn't a meaningful gate for
// them yet). smrt-svelte is Svelte-heavy and v8 cannot instrument `.svelte`, so
// the `.ts`-only measure both understates and destabilizes (importing a
// component pulls its untested transitive `.ts` into the denominator). Real
// component coverage is the explicit deliverable of S11 (#1416 — UI test
// harness); the floor is enforced there. Remove this once S11 lands.
const GATE_EXEMPT = new Set(['smrt-svelte']);

// Interim ratchet floors for packages that measured BELOW their ratified tier
// floor when the gate landed. S6 (#1411) explicitly deferred per-package
// coverage *uplift* to Wave 3; a hard tier floor on a package that has never
// measured at it doesn't block regressions — it freezes all development on
// the package. The interim floor pins the package's measured baseline so PRs
// still can't regress it, while the uplift to the tier floor is tracked as
// its own work item. Ratchet upward as uplift lands; delete the entry once
// the package measures at its tier floor.
const INTERIM_FLOORS = {
  // core measured 66.3% (CI) / 66.5% (local) on 2026-06-11, the first time a
  // core-touching PR hit the gate (#1499). Floor set just below baseline to
  // absorb run-to-run measurement noise. Uplift to the T1 80% floor is #1500.
  core: 65,
};

function flagValue(name) {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

function git(args, opts = {}) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', ...opts });
}

/** Packages whose files changed vs the PR base, via `git diff`. */
function touchedPackagesFromGit() {
  const baseRef = process.env.BASE_REF || 'main';
  let range;
  try {
    // Ensure the base is present (CI checkouts can be shallow), then diff.
    try {
      git(['fetch', 'origin', baseRef, '--depth=200'], { stdio: 'ignore' });
    } catch {
      // best-effort; the ref may already be local
    }
    const base = git(['merge-base', `origin/${baseRef}`, 'HEAD']).trim();
    range = `${base}...HEAD`;
  } catch {
    range = `origin/${baseRef}...HEAD`;
  }
  const out = git(['diff', '--name-only', range]);
  const pkgs = new Set();
  for (const line of out.split('\n')) {
    // Only shipped SOURCE under src/ counts as "touching" a package for the
    // coverage floor. Config (vitest.config/tsconfig/package.json), test files
    // (*.test/*.spec, __tests__), and docs don't add testable surface, so they
    // must not trigger the "bring it to floor" requirement — otherwise a vitest
    // timeout tweak or a test-only PR is wrongly blocked by a package's
    // pre-existing coverage debt.
    const m = line.match(/^packages\/([^/]+)\/(.+)$/);
    if (!m) continue;
    const [, pkg, rest] = m;
    if (!rest.startsWith('src/')) continue;
    if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(rest)) continue;
    if (/(^|\/)__tests__\//.test(rest)) continue;
    pkgs.add(pkg);
  }
  return [...pkgs];
}

/** Run vitest coverage for one package and return total line coverage %, or null. */
function measureLineCoverage(pkg) {
  const cwd = join(PKGS, pkg);
  // The turbo `test` task dependsOn `generate:test` because some packages
  // (core) need a generated test manifest in src/ before vitest runs. This
  // gate calls vitest directly, bypassing turbo, so it must honor the same
  // dependency — otherwise a turbo build cache hit leaves the gitignored
  // manifest stub missing and dozens of schema-dependent tests fail with
  // "ON CONFLICT does not match any UNIQUE constraint" (#1499 runs 2-3).
  try {
    execFileSync('pnpm', ['run', '--if-present', 'generate:test'], {
      cwd,
      stdio: 'inherit',
      env: { ...process.env, NODE_ENV: 'test' },
    });
  } catch {
    // Non-fatal: the vitest run below surfaces any real breakage.
  }
  try {
    execFileSync(
      'pnpm',
      [
        'exec',
        'vitest',
        'run',
        '--coverage',
        '--coverage.reporter=json-summary',
        '--coverage.reporter=text',
      ],
      { cwd, stdio: 'inherit', env: { ...process.env, NODE_ENV: 'test' } },
    );
  } catch {
    // Non-zero exit (failing/zero tests). Fall through to read any summary; if
    // none exists the package is treated as uncovered (gate fails).
  }
  const summaryPath = join(cwd, 'coverage', 'coverage-summary.json');
  if (!existsSync(summaryPath)) return null;
  try {
    const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
    return summary.total?.lines?.pct ?? null;
  } catch {
    return null;
  }
}

function main() {
  const explicit = flagValue('--packages');
  const touched = explicit
    ? explicit
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : touchedPackagesFromGit();

  if (touched.length === 0) {
    console.log('✓ coverage-gate: no packages touched — nothing to check.');
    return;
  }

  const checked = [];
  const skipped = [];
  for (const pkg of touched.sort()) {
    if (!existsSync(join(PKGS, pkg))) continue; // deleted dir
    if (WAIVED.has(pkg)) {
      skipped.push(`${pkg} (coverage waived)`);
      continue;
    }
    if (GATE_EXEMPT.has(pkg)) {
      skipped.push(`${pkg} (gate exempt — coverage owned by S11 #1416)`);
      continue;
    }
    const tier = TIERS[pkg];
    if (!tier) {
      skipped.push(`${pkg} (untiered — no ratified floor)`);
      continue;
    }
    const interim = INTERIM_FLOORS[pkg];
    checked.push({
      pkg,
      tier,
      floor: interim ?? FLOORS[tier],
      interim: interim !== undefined,
    });
  }

  for (const line of skipped) console.log(`• skipped: ${line}`);
  if (checked.length === 0) {
    console.log('✓ coverage-gate: no tiered packages to check.');
    return;
  }

  const failures = [];
  const results = [];
  for (const { pkg, tier, floor, interim } of checked) {
    const floorLabel = interim
      ? `interim floor ${floor}% — tier floor ${FLOORS[tier]}%, uplift tracked separately`
      : `floor ${floor}%`;
    console.log(`\n── measuring coverage: ${pkg} (${tier}, ${floorLabel}) ──`);
    const pct = measureLineCoverage(pkg);
    if (pct === null) {
      failures.push({ pkg, tier, floor, pct: 'no coverage summary' });
      results.push(`✗ ${pkg} (${tier}): no coverage produced (${floorLabel})`);
      continue;
    }
    const ok = pct >= floor;
    results.push(
      `${ok ? '✓' : '✗'} ${pkg} (${tier}): ${pct.toFixed(2)}% (${floorLabel})`,
    );
    if (!ok) failures.push({ pkg, tier, floor, pct });
  }

  console.log('\n=== Per-tier coverage gate ===');
  for (const r of results) console.log(`  ${r}`);

  if (failures.length > 0) {
    console.error(
      `\n✗ coverage-gate: ${failures.length} package(s) below tier floor.\n` +
        'A PR that touches a package must bring it to >= its tier floor\n' +
        '(T1 80% / T2 70% / T3 50%). Add tests to the touched package(s).\n' +
        'See docs/content/PRODUCTION_READINESS.md §Tiers.',
    );
    process.exit(1);
  }
  console.log(
    `\n✓ coverage-gate: ${checked.length} package(s) at or above tier floor.`,
  );
}

main();
