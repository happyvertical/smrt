#!/usr/bin/env node
/**
 * Can plain Node evaluate each workspace model package root? (#4219)
 *
 * Backs the `pnpm check:node-roots` gate (root `package.json`), which CI runs
 * after `pnpm build` in both Knowledge Freshness jobs of
 * `.github/workflows/test-suite.yml`. The generated consumer register
 * (`.smrt/register.js`, `smrt db:migrate`, task/schedule workers) is loaded by
 * plain Node, so a model root that starts reaching `.svelte` files breaks
 * every consumer CLI; see `packages/core/agents/build-knowledge.md`
 * ("Register imports stay Node-loadable").
 *
 * For every `packages/<dir>` with a built manifest (`dist/manifest.json` or
 * `dist/lib/manifest.json`) that declares `@smrt()` objects, spawn
 * `node --input-type=module -e "await import('<name>')"` from the package
 * directory (Node resolves the self-reference through the package's own
 * `exports`) and report OK/FAIL with the first error line.
 *
 * Flags:
 *   --strict              exit 1 on a failure not in --allow, when nothing was
 *                         surveyed (e.g. run before `pnpm build`), or when an
 *                         allow-listed package was not surveyed or now loads
 *                         (so the allow-list cannot go stale).
 *   --allow=<a>[,<b>]     expected failures. The list lives in the root
 *                         `check:node-roots` script; currently only
 *                         `@happyvertical/smrt-products`, whose root
 *                         re-exports its Svelte components by contract.
 *   --all                 also survey packages that declare no objects
 *                         (report only; do not combine with --strict).
 *   --packages-dir=<dir>  survey another packages directory (tests).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

function manifestObjectCount(packageDir) {
  for (const candidate of ['dist/manifest.json', 'dist/lib/manifest.json']) {
    const manifestPath = path.join(packageDir, candidate);
    if (!existsSync(manifestPath)) continue;
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      return Object.keys(manifest.objects ?? {}).length;
    } catch {
      return 0;
    }
  }
  return 0;
}

/**
 * Load each eligible package root under plain Node.
 *
 * @param {{ packagesDir: string, includeAll?: boolean }} options
 * @returns {Array<{ name: string, objects: number, ok: boolean, error: string }>}
 */
export function surveyPackageRoots({ packagesDir, includeAll = false }) {
  const rows = [];
  for (const dir of readdirSync(packagesDir).sort()) {
    const packageDir = path.join(packagesDir, dir);
    const packageJsonPath = path.join(packageDir, 'package.json');
    if (!existsSync(packageJsonPath)) continue;
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
    if (packageJson.private || !packageJson.name) continue;
    const objects = manifestObjectCount(packageDir);
    if (objects === 0 && !includeAll) continue;

    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `await import(${JSON.stringify(packageJson.name)})`,
      ],
      { cwd: packageDir, encoding: 'utf8', timeout: 120_000 },
    );
    const error =
      (result.stderr ?? '')
        .split('\n')
        .find((line) => /Error|Unknown file extension|Cannot find/.test(line)) ??
      '';
    rows.push({
      name: packageJson.name,
      objects,
      ok: result.status === 0,
      error: error.replace(repoRoot, '.').slice(0, 160),
    });
  }
  return rows;
}

/**
 * Decide the strict-mode outcome for a set of survey rows.
 *
 * @param {Array<{ name: string, ok: boolean }>} rows
 * @param {Iterable<string>} allowed expected failures
 * @returns {string[]} one message per violation; empty means pass
 */
export function strictViolations(rows, allowed) {
  const allowList = new Set(allowed);
  const violations = [];
  if (rows.length === 0) {
    violations.push(
      'no package was surveyed; run `pnpm build` first so dist manifests exist',
    );
  }
  const unexpected = rows.filter((row) => !row.ok && !allowList.has(row.name));
  if (unexpected.length > 0) {
    violations.push(
      `${unexpected.length} unexpected failure(s): ${unexpected.map((row) => row.name).join(', ')}`,
    );
  }
  const byName = new Map(rows.map((row) => [row.name, row]));
  for (const name of allowList) {
    const row = byName.get(name);
    if (!row) {
      violations.push(
        `allow-listed ${name} was not surveyed (renamed, removed, unbuilt, or no longer declares objects); update the check:node-roots allow-list`,
      );
    } else if (row.ok) {
      violations.push(
        `allow-listed ${name} now loads under plain Node; remove it from the check:node-roots allow-list`,
      );
    }
  }
  return violations;
}

function main(argv) {
  const args = new Set(argv);
  const packagesDirArg = [...args].find((arg) =>
    arg.startsWith('--packages-dir='),
  );
  const packagesDir = packagesDirArg
    ? path.resolve(packagesDirArg.slice('--packages-dir='.length))
    : path.join(repoRoot, 'packages');
  const allowed = [...args]
    .filter((arg) => arg.startsWith('--allow='))
    .flatMap((arg) => arg.slice('--allow='.length).split(','))
    .filter(Boolean);

  const rows = surveyPackageRoots({
    packagesDir,
    includeAll: args.has('--all'),
  });
  const failures = rows.filter((row) => !row.ok);
  for (const row of rows) {
    console.log(
      `${row.ok ? 'OK  ' : 'FAIL'} ${row.name.padEnd(38)} objects=${String(row.objects).padEnd(4)} ${row.error}`,
    );
  }
  console.log(
    `\nnode-root-load: ${rows.length - failures.length} OK, ${failures.length} FAIL` +
      (failures.length
        ? ` (${failures.map((row) => row.name).join(', ')})`
        : ''),
  );

  if (!args.has('--strict')) return 0;
  const violations = strictViolations(rows, allowed);
  for (const violation of violations) {
    console.error(`node-root-load: ${violation}`);
  }
  return violations.length > 0 ? 1 : 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  process.exitCode = main(process.argv.slice(2));
}
