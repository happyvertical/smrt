#!/usr/bin/env node
/**
 * Monorepo standards check — runs the package-shape invariants documented in
 * docs/content/standards.md and fails CI on any violation.
 *
 * Currently checks:
 *   - exports map condition order: `types` always before `import`
 *   - package.json shape: type=module, author=HappyVertical, repository.directory present
 *   - `files` allowlist: must include "CLAUDE.md" (unless package opts out)
 *   - vitest.config.ts presence + smrtVitestPlugin usage
 *   - no `--passWithNoTests` in test scripts (allowlist for templates)
 *
 * Exit code: 0 if all packages pass, 1 if any violation. Prints a report
 * grouped by package.
 *
 * Run: `node scripts/check-standards.mjs` or `pnpm check:standards`.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const PKGS = join(ROOT, 'packages');

// Exemption tables — packages that have a documented reason to skip a check.
// Keep narrow; expand only when adding the comment to docs/content/standards.md
// describing the exemption.
const EXEMPTIONS = {
  // No vitest.config.ts required:
  //   - vitest provides the plugin to others, builds with tsc
  //   - templates ship a scaffold; their test surface is the scaffolded
  //     output, not in-repo tests (e2e via Playwright tracked separately)
  noVitestConfig: new Set([
    'vitest',
    'template-sveltekit',
    'template-site-static-json',
  ]),
  // Templates and stub packages may legitimately ship without tests.
  passWithNoTestsAllowed: new Set([
    'template-sveltekit',
    'template-site-static-json',
  ]),
  // Packages whose vitest config exists but has not yet migrated from raw
  // setupFiles to smrtVitestPlugin(). Tracked under issue 1195 (CC-4
  // remainder); migration requires careful test verification because
  // both packages have substantive existing test suites.
  noSmrtVitestPlugin: new Set(['core', 'cli', 'smrt-playground']),
  // Packages whose hand-written exports map predates the conditional
  // standard. Migrating ~18 bare-string entries in core requires careful
  // type-resolution verification across consumers. Tracked as a CC-2
  // follow-up (issue 1193). Templates ship plain JS scaffolding helpers
  // (`./index.js`) rather than typed module APIs, so the conditional shape
  // does not apply to their root export.
  bareStringExportsAllowed: new Set([
    'core',
    'template-sveltekit',
    'template-site-static-json',
  ]),
};

const REPO_URL = 'https://github.com/happyvertical/smrt.git';

function listPackages() {
  return readdirSync(PKGS, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

function readPkg(name) {
  const path = join(PKGS, name, 'package.json');
  if (!existsSync(path)) return null;
  return { path, json: JSON.parse(readFileSync(path, 'utf8')) };
}

// Recursively walk an exports map looking for any entry that has both `types`
// and `import` conditions where `types` is not the first key.
function findExportsOrderViolations(obj, path = '') {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return [];
  const issues = [];
  if ('import' in obj && 'types' in obj) {
    const keys = Object.keys(obj);
    if (keys.indexOf('import') < keys.indexOf('types')) {
      issues.push(path || '.');
    }
  }
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      issues.push(...findExportsOrderViolations(v, path ? `${path}.${k}` : k));
    }
  }
  return issues;
}

// Bare-string export targets are forbidden by docs/content/standards.md §2.
// Every entry must be a conditional object so consumers get a `types`
// resolution path. Exemptions:
//   - JSON-target exports (data, not modules — TS does not resolve types)
//   - Glob patterns ending in `/*` (raw file scaffolding, not modules — used
//     by templates and asset directories where the target paths are static
//     files copied into consumer projects)
function findBareStringExportViolations(exports) {
  if (typeof exports !== 'object' || exports === null) return [];
  const issues = [];
  for (const [path, target] of Object.entries(exports)) {
    if (typeof target !== 'string') continue;
    if (target.endsWith('.json')) continue;
    if (path.endsWith('/*') || target.endsWith('/*')) continue;
    issues.push(path);
  }
  return issues;
}

function checkPackage(name) {
  const violations = [];
  const pkg = readPkg(name);
  if (!pkg) return violations;
  const { json } = pkg;

  // 1. exports condition order
  if (json.exports) {
    const bad = findExportsOrderViolations(json.exports);
    for (const path of bad) {
      violations.push(
        `exports map "${path}" lists \`import\` before \`types\` — flip so \`types\` comes first`,
      );
    }
  }

  // 1b. bare-string export targets
  if (json.exports && !EXEMPTIONS.bareStringExportsAllowed.has(name)) {
    const bare = findBareStringExportViolations(json.exports);
    for (const path of bare) {
      violations.push(
        `exports map "${path}" uses a bare-string target — replace with a conditional { types, import } object`,
      );
    }
  }

  // 2. type=module
  if (json.type !== 'module') {
    violations.push('package.json must set "type": "module"');
  }

  // 3. author=HappyVertical
  if (json.author !== 'HappyVertical') {
    violations.push(
      `author must be "HappyVertical" (got ${JSON.stringify(json.author)})`,
    );
  }

  // 4. repository.directory present and correct
  const expectedDir = `packages/${name}`;
  const repo = json.repository;
  if (
    !repo ||
    typeof repo !== 'object' ||
    repo.url !== REPO_URL ||
    repo.directory !== expectedDir
  ) {
    violations.push(
      `repository must be { type: "git", url: "${REPO_URL}", directory: "${expectedDir}" }`,
    );
  }

  // 5. files allowlist must include CLAUDE.md
  if (Array.isArray(json.files) && !json.files.includes('CLAUDE.md')) {
    violations.push('files allowlist missing "CLAUDE.md"');
  }

  // 6. vitest.config.ts presence + smrtVitestPlugin usage
  if (!EXEMPTIONS.noVitestConfig.has(name)) {
    const vitestConfig = join(PKGS, name, 'vitest.config.ts');
    if (!existsSync(vitestConfig)) {
      violations.push('missing vitest.config.ts');
    } else if (!EXEMPTIONS.noSmrtVitestPlugin.has(name)) {
      const content = readFileSync(vitestConfig, 'utf8');
      if (!content.includes('smrtVitestPlugin')) {
        violations.push('vitest.config.ts must use smrtVitestPlugin()');
      }
    }
  }

  // 7. no --passWithNoTests in any test script (test, test:watch, test:sqlite,
  //    test:postgres, test:json, test:e2e, test:integration, etc.). Adapter-
  //    specific scripts must enforce the same rule as the default test script.
  //    Exception: scripts that select a specific Vitest project via --project
  //    are allowed --passWithNoTests because the targeted project may have
  //    legitimately zero tests in some CI envs (e.g. postgres adapter without
  //    a postgres container).
  if (!EXEMPTIONS.passWithNoTestsAllowed.has(name) && json.scripts) {
    for (const [key, script] of Object.entries(json.scripts)) {
      if (key !== 'test' && !key.startsWith('test:')) continue;
      if (typeof script !== 'string') continue;
      if (!script.includes('--passWithNoTests')) continue;
      if (script.includes('--project')) continue;
      violations.push(
        `scripts.${key} uses --passWithNoTests — write at least one real test`,
      );
    }
  }

  return violations;
}

const packages = listPackages();
let totalViolations = 0;
const report = [];
for (const name of packages) {
  const v = checkPackage(name);
  if (v.length === 0) continue;
  totalViolations += v.length;
  report.push({ name, violations: v });
}

if (report.length === 0) {
  console.log(
    `✓ standards-check: ${packages.length} packages, 0 violations`,
  );
  process.exit(0);
}

console.error(
  `✗ standards-check: ${totalViolations} violation(s) across ${report.length} package(s)\n`,
);
for (const { name, violations } of report) {
  console.error(`  packages/${name}/`);
  for (const v of violations) {
    console.error(`    - ${v}`);
  }
  console.error();
}
console.error(
  'See docs/content/standards.md for the full standard. To exempt a check,\n' +
    'add the package to the EXEMPTIONS table in scripts/check-standards.mjs\n' +
    'and document the exemption in CLAUDE.md.',
);
process.exit(1);
