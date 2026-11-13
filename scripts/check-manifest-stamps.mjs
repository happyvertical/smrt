#!/usr/bin/env node
/**
 * Fail when a built manifest carries a `schemaFingerprint` that does not
 * describe the objects in the same file (#4929).
 *
 * A stamp is the hash of the schema a manifest lists. A tool that filters or
 * copies a manifest after generation (the shell's `publish-manifest.mjs` kept
 * only its own objects and copied the whole app's stamp) leaves a stamp that
 * names a schema the file does not hold; migrate then records one value and the
 * bundled app expects another. This check recomputes each stamp with the
 * function the generators use and names every file where the two differ.
 *
 * Usage: node scripts/check-manifest-stamps.mjs [repoRoot]
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const LOCATIONS = [
  'dist/manifest.json',
  '.smrt/manifest.json',
  'src/manifest/manifest.json',
  'src/manifest/static-manifest.json',
];

/** `{ manifest, stamped, computed }` for each stamp that is not its own file's. */
export function findStaleStamps(repoRoot, compute) {
  const packagesDir = join(repoRoot, 'packages');
  const stale = [];
  for (const name of readdirSync(packagesDir).sort()) {
    for (const location of LOCATIONS) {
      const path = join(packagesDir, name, location);
      if (!existsSync(path)) continue;
      const manifest = JSON.parse(readFileSync(path, 'utf8'));
      if (typeof manifest.schemaFingerprint !== 'string' || !manifest.objects)
        continue;
      let computed;
      try {
        computed = compute(manifest);
      } catch {
        // The generator leaves the stamp out when it cannot compute one.
        computed = undefined;
      }
      if (computed !== manifest.schemaFingerprint)
        stale.push({
          manifest: `packages/${name}/${location}`,
          stamped: manifest.schemaFingerprint,
          computed,
        });
    }
  }
  return stale;
}

async function coreCompute(root) {
  const entry = join(root, 'packages', 'core', 'dist', 'migrations.js');
  if (!existsSync(entry))
    throw new Error(`${entry} is missing: build @happyvertical/smrt-core first`);
  const { computeManifestSchemaFingerprint } = await import(pathToFileURL(entry).href);
  return computeManifestSchemaFingerprint;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..'));
  const stale = findStaleStamps(root, await coreCompute(root));
  if (stale.length > 0) {
    console.error(
      `check-manifest-stamps: ${stale.length} built manifest(s) carry a schemaFingerprint that does not match their own objects (#4929). ` +
        'A tool that filters or copies a manifest must recompute the stamp or leave it out.',
    );
    for (const s of stale.slice(0, 20))
      console.error(`  ${s.manifest}: stamped ${s.stamped.slice(0, 12)}, its objects hash to ${s.computed?.slice(0, 12) ?? 'nothing'}`);
    if (stale.length > 20) console.error(`  ... and ${stale.length - 20} more`);
    process.exit(1);
  }
  console.log('check-manifest-stamps: every built manifest stamp matches its own objects.');
}
