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
// them yet).
//   - smrt-svelte: Svelte-heavy and v8 cannot instrument `.svelte`, so the
//     `.ts`-only measure both understates and destabilizes (importing a
//     component pulls its untested transitive `.ts` into the denominator). Real
//     component coverage is the deliverable of S11 (#1416 — UI test harness).
//   - vitest (`@happyvertical/smrt-vitest`): the shared test/build plugin. Its
//     uncovered surface is the Vite plugin lifecycle (config/transform/manifest
//     hooks, workspace fs scanning) — exercised through every package's test run
//     rather than unit line-coverage; its "product" is test infrastructure.
// Revisit both as their respective coverage stories mature.
const GATE_EXEMPT = new Set(['smrt-svelte', 'vitest']);

// Interim ratchet floors for packages that measure BELOW their ratified tier
// floor. S6 (#1411) explicitly deferred per-package coverage *uplift* to Wave 3;
// a hard tier floor on a package that has never measured at it doesn't just
// block regressions — it freezes all development that adds new measured source
// to the package (the modified-only debt exemption below can't cover a new
// file). The interim floor pins the package's measured baseline so PRs still
// can't regress it, while the uplift to the tier floor is tracked as its own
// work item. Ratchet upward as uplift lands; delete the entry once the package
// measures at its tier floor.
const INTERIM_FLOORS = {
  // core: interim floor removed — the #1500 coverage uplift took core from
  // ~66% to 83.79% lines (2026-06-21), clearing the ratified T1 80% floor. The
  // gate now enforces the real tier floor for core. Add new entries here only
  // for packages still measuring below their tier floor.
};

function flagValue(name) {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

function git(args, opts = {}) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', ...opts });
}

/**
 * Source files (under `src/`) changed vs the PR base, grouped by package.
 * Returns `Map<pkg, { files: Set<relPath>, onlyModified: boolean }>` where
 * relPath is package-relative (e.g. `src/svelte/Foo.svelte`) and `onlyModified`
 * is true only when EVERY touched file is an in-place modification (`M`) — not
 * an add/delete/rename/copy. Config, test files, and docs are excluded — they
 * add no testable surface, so a vitest-timeout tweak or a test-only PR isn't
 * wrongly blocked by a package's pre-existing coverage debt.
 */
function touchedSourceByPackage() {
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
  // `--name-status` so we can tell a pure modification (which can't change the
  // covered surface) from an add/delete/rename (which can).
  const out = git(['diff', '--name-status', range]);
  const byPkg = new Map();
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const fields = line.split('\t');
    const status = fields[0][0]; // M | A | D | R | C
    // For rename/copy the destination is the last field; both source and dest
    // are surface changes, so consider every path on the line.
    for (const p of fields.slice(1)) {
      const m = p.match(/^packages\/([^/]+)\/(.+)$/);
      if (!m) continue;
      const [, pkg, rest] = m;
      if (!rest.startsWith('src/')) continue;
      if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(rest)) continue;
      if (/(^|\/)__tests__\//.test(rest)) continue;
      if (!byPkg.has(pkg)) {
        byPkg.set(pkg, { files: new Set(), onlyModified: true });
      }
      const entry = byPkg.get(pkg);
      entry.files.add(rest);
      if (status !== 'M') entry.onlyModified = false;
    }
  }
  return byPkg;
}

/**
 * Run vitest coverage for one package. Returns `{ pct, files }` where `pct` is
 * total line coverage % and `files` is the set of per-file keys v8 actually
 * measured (absolute paths), or null if no summary was produced.
 */
function measureCoverage(pkg) {
  const cwd = join(PKGS, pkg);
  // The turbo `test` task dependsOn `generate:test` because some packages
  // (core) need a generated test manifest in src/ before vitest runs. This
  // gate calls vitest directly, bypassing turbo, so it must honor the same
  // dependency — otherwise a turbo build cache hit leaves the gitignored
  // src/manifest/test-manifest-stub.ts unrestored and dozens of
  // schema-dependent tests fail with "ON CONFLICT does not match any UNIQUE
  // constraint", which the gate would misread as "no coverage produced".
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
    const pct = summary.total?.lines?.pct ?? null;
    const files = Object.keys(summary).filter((k) => k !== 'total');
    return { pct, files };
  } catch {
    return null;
  }
}

/**
 * Did the PR touch any source file v8 actually measured in this package?
 *
 * A touched file that doesn't appear in the coverage report (a `.svelte` file
 * in a package without component tests, or any source not imported by a test)
 * cannot have moved the measured number — so a below-floor result for such a PR
 * is pre-existing debt, not this PR's regression, and must not block. This is
 * the surgical version of the smrt-svelte gate exemption: it keeps `.svelte`
 * that IS measured (e.g. `content`'s component-tested files) under the gate.
 */
function touchesMeasuredSource(touchedRel, coverageFiles) {
  const norm = (p) => p.replace(/\\/g, '/');
  const measured = coverageFiles.map(norm);
  for (const rel of touchedRel) {
    const r = norm(rel);
    if (measured.some((f) => f === r || f.endsWith(`/${r}`))) return true;
  }
  return false;
}

function main() {
  const explicit = flagValue('--packages');
  // In CI we have the git diff, so we know WHICH files were touched — that lets
  // us tell a pre-existing shortfall apart from one this PR could have caused.
  // Explicit `--packages` mode has no diff, so it always enforces the floor.
  const touchedMap = explicit ? null : touchedSourceByPackage();
  const touched = explicit
    ? explicit
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [...touchedMap.keys()];

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
    const cov = measureCoverage(pkg);
    if (cov === null || cov.pct === null) {
      failures.push({ pkg, tier, floor, pct: 'no coverage summary' });
      results.push(`✗ ${pkg} (${tier}): no coverage produced (${floorLabel})`);
      continue;
    }
    const { pct, files } = cov;
    if (pct >= floor) {
      results.push(`✓ ${pkg} (${tier}): ${pct.toFixed(2)}% (${floorLabel})`);
      continue;
    }
    // Below floor. The shortfall is only treated as pre-existing debt (report,
    // don't block) when the PR *cannot* have changed this package's covered
    // surface: every touched file is an in-place modification (no add/delete/
    // rename) AND none of them are files v8 actually measured. That covers a
    // `.svelte`-only refactor in a package without component tests. A new/removed
    // file, or a modified file that IS measured, still blocks. Explicit
    // `--packages` mode has no diff, so it always enforces.
    const touchedEntry = touchedMap?.get(pkg);
    if (
      touchedEntry?.onlyModified &&
      !touchesMeasuredSource(touchedEntry.files, files)
    ) {
      results.push(
        `• ${pkg} (${tier}): ${pct.toFixed(2)}% < floor ${floor}% — PR only ` +
          'modifies source v8 does not measure here; pre-existing debt, not blocked',
      );
      continue;
    }
    results.push(`✗ ${pkg} (${tier}): ${pct.toFixed(2)}% (${floorLabel})`);
    failures.push({ pkg, tier, floor, pct });
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
