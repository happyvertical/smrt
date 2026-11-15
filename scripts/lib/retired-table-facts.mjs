/**
 * Facts about a published release's models, read from that release's
 * published package manifests (#5005), for the retire step:
 *
 * - `owners`: which qualified classes declared each model table. The release
 *   upgrade gate checks a retirement's `lastOwner` against it. Written to
 *   `packages/core/release-upgrade/owners/<release>.json`, beside the
 *   release's snapshot, and pruned and checked for staleness with it.
 * - `definition`: one table's columns and types as its models declared them.
 *   A retirement carries it, and migrate compares it with the live table.
 *
 * Both come from the same projection of the same manifests, the one smrt's
 * registry makes of them, so they agree. Nothing here is written by hand.
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const readJSON = (file) => JSON.parse(readFileSync(file, 'utf8'));
const OVERLAY_KEYS = ['owners', 'release', 'source'];
export const OWNERS_SOURCE = 'published package manifests';

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys(value[key])]),
    );
  return value;
}
const stableJSON = (value) => `${JSON.stringify(sortKeys(value), null, 2)}\n`;

/** The overlay file of a release, relative to the gate directory. */
export const ownersFileName = (release) => `owners/${release}.json`;

/** The repository's publishable packages: name to package directory. */
export function repositoryPackages(root) {
  const packages = new Map();
  const dir = path.join(root, 'packages');
  for (const name of readdirSync(dir).sort()) {
    const file = path.join(dir, name, 'package.json');
    if (!existsSync(file)) continue;
    const json = readJSON(file);
    if (json.private || typeof json.name !== 'string') continue;
    packages.set(json.name, path.join(dir, name));
  }
  return packages;
}

/**
 * The manifests of `release`: from `from` (a directory holding
 * `<anything>/dist/manifest.json` with a `package.json` beside `dist`, such
 * as an install's `node_modules` or extracted tarballs), or else fetched
 * with `npm pack <name>@<release>` for every package of the repository. A
 * package that was not published at that release is skipped; one whose
 * version is not `release` fails.
 */
export function loadReleaseManifests({ root, release, from, log = () => {} }) {
  const manifests = [];
  const take = (packageDir, source) => {
    const manifestFile = path.join(packageDir, 'dist/manifest.json');
    const packageFile = path.join(packageDir, 'package.json');
    if (!existsSync(manifestFile) || !existsSync(packageFile)) return;
    const pkg = readJSON(packageFile);
    if (pkg.version !== release)
      throw new Error(
        `${pkg.name} in ${source} is version ${pkg.version}, not ${release}.`,
      );
    const manifest = readJSON(manifestFile);
    if (manifest.packageName && manifest.packageName !== pkg.name)
      throw new Error(
        `${manifestFile} names ${manifest.packageName}, not ${pkg.name}.`,
      );
    manifests.push({ packageName: pkg.name, manifest });
  };
  if (from) {
    const walk = (dir, depth) => {
      if (depth > 4 || !existsSync(dir)) return;
      if (existsSync(path.join(dir, 'dist/manifest.json'))) {
        take(dir, from);
        return;
      }
      for (const entry of readdirSync(dir, { withFileTypes: true }))
        if (entry.isDirectory() && entry.name !== 'dist')
          walk(path.join(dir, entry.name), depth + 1);
    };
    walk(path.resolve(from), 0);
  } else {
    const scratch = mkdtempSync(path.join(tmpdir(), 'smrt-release-facts-'));
    try {
      for (const name of repositoryPackages(root).keys()) {
        let tarball;
        try {
          const out = execFileSync(
            'npm',
            ['pack', `${name}@${release}`, '--json', '--pack-destination', scratch],
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
          );
          tarball = path.join(scratch, JSON.parse(out)[0].filename);
        } catch (error) {
          if (/E404|No matching version|is not in this registry/.test(String(error.stderr ?? error)))
            continue;
          throw error;
        }
        const dir = path.join(scratch, name.replace(/[@/]/g, '_'));
        mkdirSync(dir, { recursive: true });
        execFileSync('tar', ['-xzf', tarball, '-C', dir]);
        take(path.join(dir, 'package'), `${name}@${release} on npm`);
        log(`read ${name}@${release}`);
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
  if (!manifests.length)
    throw new Error(`No published manifests found for release ${release}.`);
  return manifests.sort((a, b) =>
    a.packageName === '@happyvertical/smrt-core'
      ? -1
      : b.packageName === '@happyvertical/smrt-core'
        ? 1
        : a.packageName.localeCompare(b.packageName),
  );
}

/** The current build's core, used to project the manifests. */
export async function loadCore(root) {
  return import(
    pathToFileURL(path.join(root, 'packages/core/dist/index.js')).href
  );
}

/**
 * Register `manifests` in a clean registry and read what the release
 * declared: each model table's owners and its columns.
 */
export function releaseFacts(core, manifests) {
  const registry = core.ObjectRegistry;
  registry.clear();
  try {
    for (const { packageName, manifest } of manifests) {
      // Retirements are not facts of the release's models.
      const { retiredTables: _retired, ...models } = manifest;
      const result = registry.registerPackageManifest({
        ...models,
        packageName: manifest.packageName ?? packageName,
      });
      if (!result.loaded)
        throw new Error(`Could not load the manifest of ${packageName}`);
    }
    const owners = {};
    for (const [key, entry] of registry.getAllClasses()) {
      const table = registry.getTableName(key);
      if (!table) continue;
      const name = entry.qualifiedName ?? key;
      owners[table] = [...new Set([...(owners[table] ?? []), name])].sort();
    }
    const columns = {};
    for (const [table, schema] of Object.entries(
      registry.getAllSchemasAsDefinitions(),
    ))
      columns[table] = Object.fromEntries(
        Object.entries(schema.columns)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([name, column]) => [
            name,
            {
              type: column.type,
              ...(column.referenceKind
                ? { referenceKind: column.referenceKind }
                : {}),
            },
          ]),
      );
    return { owners: sortKeys(owners), columns };
  } finally {
    registry.clear();
  }
}

/** The owners overlay of a release, checked; undefined when absent. */
export function readOwnersOverlay(directory, release) {
  const file = path.join(directory, ownersFileName(release));
  if (!existsSync(file)) return undefined;
  return validateOwnersOverlay(readJSON(file), release);
}

export function validateOwnersOverlay(overlay, release) {
  const where = ownersFileName(release);
  if (!overlay || typeof overlay !== 'object' || Array.isArray(overlay))
    throw new Error(`${where} must be an object`);
  const keys = Object.keys(overlay).sort();
  if (keys.join(',') !== OVERLAY_KEYS.join(','))
    throw new Error(
      `${where} must have exactly ${OVERLAY_KEYS.join(', ')}; it has ${keys.join(', ')}. Regenerate it with node scripts/retired-table-facts.mjs owners --release ${release}.`,
    );
  if (overlay.release !== release)
    throw new Error(`${where} names release ${overlay.release}`);
  if (overlay.source !== OWNERS_SOURCE)
    throw new Error(`${where} must say it was read from ${OWNERS_SOURCE}`);
  for (const [table, list] of Object.entries(overlay.owners ?? {}))
    if (
      !Array.isArray(list) ||
      !list.length ||
      list.some((name) => typeof name !== 'string' || !name.includes(':'))
    )
      throw new Error(
        `${where}: ${table} must list the qualified classes that declared it`,
      );
  return overlay;
}

/**
 * An overlay is checked with its snapshot: one whose snapshot is gone is
 * stale, and one naming a table its snapshot does not hold as a model table
 * was read from other manifests.
 */
export function validateOwnersFiles(directory, snapshots) {
  const folder = path.join(directory, 'owners');
  if (!existsSync(folder)) return;
  for (const name of readdirSync(folder).filter((n) => n.endsWith('.json'))) {
    const release = name.slice(0, -5);
    const snapshot = snapshots.get(release);
    if (!snapshot)
      throw new Error(
        `Stale owners file owners/${name}: there is no snapshot for ${release}. Delete it.`,
      );
    const overlay = readOwnersOverlay(directory, release);
    const held = new Set(snapshot.modelTables ?? Object.keys(snapshot.tables));
    const strays = Object.keys(overlay.owners).filter((t) => !held.has(t));
    if (strays.length)
      throw new Error(
        `owners/${name} names table(s) ${strays.join(', ')} that the ${release} snapshot does not hold as model tables. Regenerate it with node scripts/retired-table-facts.mjs owners --release ${release}.`,
      );
  }
}

/** Write the owners overlay of `release`. Its snapshot must exist. */
export function writeOwnersOverlay({ directory, release, owners }) {
  const snapshotFile = path.join(directory, `snapshots/${release}.json`);
  if (!existsSync(snapshotFile))
    throw new Error(
      `There is no snapshot for ${release}; an owners file goes beside its snapshot.`,
    );
  mkdirSync(path.join(directory, 'owners'), { recursive: true });
  const overlay = { release, source: OWNERS_SOURCE, owners };
  const snapshot = readJSON(snapshotFile);
  const held = new Set(snapshot.modelTables ?? Object.keys(snapshot.tables));
  // Only the snapshot's model tables: a table the release published but the
  // gate's snapshot does not hold is not the gate's to vouch for.
  overlay.owners = Object.fromEntries(
    Object.entries(owners).filter(([table]) => held.has(table)),
  );
  const file = path.join(directory, ownersFileName(release));
  writeFileSync(file, stableJSON(validateOwnersOverlay(overlay, release)));
  return file;
}

/**
 * Write `definition` into the declaration of `table` in the package's
 * `package.json` (`smrt.retiredTables`), from the release's facts. The
 * declaration must already name the table, its lastOwner, since and reason;
 * lastOwner must be a class that declared the table in that release.
 */
export function writeDefinition({ root, packageName, table, release, facts }) {
  const dir = repositoryPackages(root).get(packageName);
  if (!dir) throw new Error(`${packageName} is not a package of this repository.`);
  const file = path.join(dir, 'package.json');
  const json = readJSON(file);
  const entry = json.smrt?.retiredTables?.find((item) => item.table === table);
  if (!entry)
    throw new Error(
      `${packageName} declares no retirement of ${table}. Add the declaration (table, lastOwner, since, reason) to smrt.retiredTables first.`,
    );
  const columns = facts.columns[table];
  if (!columns)
    throw new Error(`No model of release ${release} declares ${table}.`);
  const owners = facts.owners[table] ?? [];
  if (!owners.includes(entry.lastOwner))
    throw new Error(
      `lastOwner ${entry.lastOwner} did not declare ${table} in release ${release} (declared by ${owners.join(', ') || 'nothing'}).`,
    );
  entry.definition = { release, columns };
  writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
  return file;
}
