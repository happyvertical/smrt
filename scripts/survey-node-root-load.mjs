#!/usr/bin/env node
/**
 * Survey: can plain Node evaluate each workspace package root? (#4219)
 *
 * For every `packages/<dir>` with a built manifest (`dist/manifest.json` or
 * `dist/lib/manifest.json`) that declares `@smrt()` objects, spawn
 * `node --input-type=module -e "await import('<name>')"` from the package
 * directory (Node resolves the self-reference through the package's own
 * `exports`) and report OK/FAIL with the first error line. A root that fails
 * here is one the generated `.smrt/register.js` must never import; see
 * `packages/core/agents/build-knowledge.md` ("Register imports stay
 * Node-loadable").
 *
 * This is a survey, not a gate: a root that re-exports Svelte components by
 * contract (`@happyvertical/smrt-products`) fails by design. Run after
 * `pnpm build`. `--all` also surveys packages that declare no objects;
 * `--strict` exits 1 on any failure not named in `--allow=<name>[,<name>]`.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packagesDir = path.join(repoRoot, 'packages');
const args = new Set(process.argv.slice(2));
const includeAll = args.has('--all');
const strict = args.has('--strict');
const allowed = new Set(
  [...args]
    .filter((arg) => arg.startsWith('--allow='))
    .flatMap((arg) => arg.slice('--allow='.length).split(','))
    .filter(Boolean),
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
    ['--input-type=module', '-e', `await import(${JSON.stringify(packageJson.name)})`],
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

const failures = rows.filter((row) => !row.ok);
for (const row of rows) {
  console.log(
    `${row.ok ? 'OK  ' : 'FAIL'} ${row.name.padEnd(38)} objects=${String(row.objects).padEnd(4)} ${row.error}`,
  );
}
console.log(
  `\nnode-root-load: ${rows.length - failures.length} OK, ${failures.length} FAIL` +
    (failures.length ? ` (${failures.map((row) => row.name).join(', ')})` : ''),
);

const unexpected = failures.filter((row) => !allowed.has(row.name));
if (strict && unexpected.length > 0) {
  console.error(
    `node-root-load: ${unexpected.length} unexpected failure(s): ${unexpected.map((row) => row.name).join(', ')}`,
  );
  process.exit(1);
}
