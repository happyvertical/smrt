/**
 * Facts about a published release's models, read from that release's
 * published package manifests (#5005), for the retire step:
 *
 * - `owners`: which qualified model classes declared each model table
 *   (collection classes are not owners). The release upgrade gate checks a
 *   retirement's `lastOwner` against it. Written to
 *   `packages/core/release-upgrade/owners/<release>.json`, beside the
 *   release's snapshot, and pruned and checked for staleness with it.
 * - `definition`: one table's columns and types as its models declared them
 *   in one release. A retirement carries one per supported release
 *   (`definitions`), and migrate compares them with the live table.
 *
 * Both come from the same projection of the same manifests, the one smrt's
 * registry makes of them, so they agree. Nothing here is written by hand:
 * `checkRetiredFacts` regenerates both from the published manifests and
 * fails on any difference, so a hand edit is caught.
 *
 * The projection runs through this build's core, not the release's. A base
 * column or reference kind core gained after the release would show in the
 * definition and not in the release's tables; the release upgrade gate
 * compares every definition with the release snapshots' physical columns,
 * so such drift fails the build.
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const readJSON = (file) => JSON.parse(readFileSync(file, 'utf8'));
const OVERLAY_KEYS = ['owners', 'release', 'source'];
export const OWNERS_SOURCE = 'published package manifests';
export const REFRESH_COMMAND = 'pnpm release-upgrade:refresh-owners';

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

/**
 * The manifests a built checkout of `release` would publish, read from the
 * checkout itself (`packages/<pkg>/dist/manifest.json`, #5005): every
 * publishable package at version `release` with a built manifest, as
 * `loadReleaseManifests` reads them from npm (a package at another version
 * was not published at `release`; one without a manifest declares no
 * models). No registry is needed, so a snapshot's owners overlay is written
 * from the checkout it was captured from.
 */
export function loadCheckoutManifests({ root, release }) {
  const manifests = [];
  for (const [name, dir] of repositoryPackages(root)) {
    const pkg = readJSON(path.join(dir, 'package.json'));
    if (pkg.version !== release) continue;
    const file = path.join(dir, 'dist/manifest.json');
    if (!existsSync(file)) continue;
    const manifest = readJSON(file);
    if (manifest.packageName && manifest.packageName !== name)
      throw new Error(`${file} names ${manifest.packageName}, not ${name}.`);
    manifests.push({ packageName: name, manifest });
  }
  if (!manifests.length)
    throw new Error(
      `No built manifests at release ${release} in ${root}. Run pnpm build in the checkout first.`,
    );
  return manifests.sort((a, b) =>
    a.packageName === '@happyvertical/smrt-core'
      ? -1
      : b.packageName === '@happyvertical/smrt-core'
        ? 1
        : a.packageName.localeCompare(b.packageName),
  );
}

/**
 * Whether npm can answer for `release` of core: `online`, `unpublished`
 * (npm answers, the release is not there) or `offline` (npm could not
 * answer: no network, no npm, a timeout or a registry error), with npm's
 * message.
 */
export function probeNpmRelease(release) {
  try {
    execFileSync(
      'npm',
      ['view', `@happyvertical/smrt-core@${release}`, 'version', '--json'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 },
    );
    return { state: 'online' };
  } catch (error) {
    const text = String(error.stderr || error.message || error);
    if (/E404|No matching version|is not in this registry/.test(text))
      return { state: 'unpublished', message: text.trim().split('\n')[0] };
    // Anything else (no network, no npm, a timeout, a proxy or registry
    // error) means npm could not answer: the check is skipped, not failed.
    return {
      state: 'offline',
      message: text.trim().split('\n')[0] || String(error.code ?? error),
    };
  }
}

/**
 * Regenerate `releases`' owners files and definitions from npm and compare
 * them with the repository (`checkRetiredFacts`), when npm can answer.
 * Returns `{ state: 'verified' | 'failed' | 'skipped', failures, message }`;
 * skipped when npm is unreachable or a release is not published, with the
 * reason and the command to run later.
 */
export async function verifyRetiredFactsOnline({
  root,
  directory,
  releases,
  probe = probeNpmRelease,
  factsFor,
  log = () => {},
}) {
  const later = `Run node scripts/retired-table-facts.mjs check${releases.length === 1 ? ` --release ${releases[0]}` : ''} when it is.`;
  for (const release of releases) {
    const answer = probe(release);
    if (answer.state === 'offline')
      return {
        state: 'skipped',
        failures: [],
        message: `Owners check skipped: npm is not reachable (${answer.message}). ${later}`,
      };
    if (answer.state === 'unpublished')
      return {
        state: 'skipped',
        failures: [],
        message: `Owners check skipped: smrt ${release} is not on npm yet (${answer.message}). ${later}`,
      };
  }
  let read = factsFor;
  if (!read) {
    const core = await loadCore(root);
    read = (release) =>
      releaseFacts(core, loadReleaseManifests({ root, release, log }));
  }
  const failures = checkRetiredFacts({
    root,
    directory,
    releases,
    factsFor: read,
  });
  return {
    state: failures.length ? 'failed' : 'verified',
    failures,
    message: failures.length
      ? `Owners check: FAIL for ${releases.join(', ')} (${failures.length} failure(s))`
      : `Owners check: ${releases.join(', ')} match the published manifests`,
  };
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
      // A collection class names its model's table; it never declared one.
      if (registry.isCollectionClass?.(key)) continue;
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
  // The other direction: every snapshot has its overlay, so a base merge or a
  // saved snapshot that changed the snapshot set cannot leave one behind.
  for (const release of snapshots.keys())
    if (!existsSync(path.join(directory, ownersFileName(release))))
      throw new Error(
        `Missing owners file ${ownersFileName(release)}: the ${release} snapshot has none. Run ${REFRESH_COMMAND} to write it.`,
      );
  if (!existsSync(folder)) return;
  for (const name of readdirSync(folder).filter((n) => n.endsWith('.json'))) {
    const release = name.slice(0, -5);
    const snapshot = snapshots.get(release);
    if (!snapshot)
      throw new Error(
        `Stale owners file owners/${name}: there is no snapshot for ${release}. Run ${REFRESH_COMMAND} to remove it.`,
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
  const overlay = {
    release,
    source: OWNERS_SOURCE,
    owners: ownersForSnapshot(directory, release, owners),
  };
  const file = path.join(directory, ownersFileName(release));
  writeFileSync(file, stableJSON(validateOwnersOverlay(overlay, release)));
  return file;
}

/** The owners overlay `release`'s facts give, limited to its snapshot. */
function ownersForSnapshot(directory, release, owners) {
  const snapshot = readJSON(path.join(directory, `snapshots/${release}.json`));
  const held = new Set(snapshot.modelTables ?? Object.keys(snapshot.tables));
  // Only the snapshot's model tables: a table the release published but the
  // gate's snapshot does not hold is not the gate's to vouch for.
  return Object.fromEntries(
    Object.entries(owners).filter(([table]) => held.has(table)),
  );
}

/** One release's definition of `table` from its facts, checked against lastOwner. */
export function definitionFromFacts({ table, release, facts, lastOwner }) {
  const columns = facts.columns[table];
  if (!columns)
    throw new Error(`No model of release ${release} declares ${table}.`);
  const owners = facts.owners[table] ?? [];
  if (!owners.includes(lastOwner))
    throw new Error(
      `lastOwner ${lastOwner} did not declare ${table} in release ${release} (declared by ${owners.join(', ') || 'nothing'}).`,
    );
  return { release, columns };
}

const releaseOrder = (a, b) => {
  const parts = (release) =>
    release.replace(/^v/, '').split(/[-+]/)[0].split('.').map(Number);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return a < b ? -1 : a > b ? 1 : 0;
};

/**
 * Write `release`'s entry of `definitions` into the declaration of `table` in
 * the package's `package.json` (`smrt.retiredTables`), from the release's
 * facts, replacing that release's entry and keeping the others. The
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
  const definition = definitionFromFacts({
    table,
    release,
    facts,
    lastOwner: entry.lastOwner,
  });
  entry.definitions = [
    ...(entry.definitions ?? []).filter((item) => item.release !== release),
    definition,
  ].sort((a, b) => releaseOrder(a.release, b.release));
  writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
  return file;
}

/**
 * Regenerate every owners file and every declaration's definitions from the
 * published manifests and compare them with what the repository holds. A
 * hand edit, or a file written from other manifests, is a failure naming the
 * command that writes it. `factsFor(release)` reads a release's facts (the
 * published manifests projected through this build's core); `releases`, when
 * given, limits the check to those releases. Returns the failures.
 */
export function checkRetiredFacts({ root, directory, factsFor, releases }) {
  const only = releases ? new Set(releases) : undefined;
  const wanted = (release) => !only || only.has(release);
  const failures = [];
  const cache = new Map();
  const facts = (release) => {
    if (!cache.has(release)) cache.set(release, factsFor(release));
    return cache.get(release);
  };
  const folder = path.join(directory, 'owners');
  if (existsSync(folder))
    for (const name of readdirSync(folder).filter((n) => n.endsWith('.json'))) {
      const release = name.slice(0, -5);
      if (!wanted(release)) continue;
      const held = readOwnersOverlay(directory, release);
      const fresh = ownersForSnapshot(directory, release, facts(release).owners);
      if (stableJSON(sortKeys(held.owners)) !== stableJSON(sortKeys(fresh)))
        failures.push(
          `owners/${name} is not what release ${release}'s published manifests give. Regenerate it with node scripts/retired-table-facts.mjs owners --release ${release}; never edit it by hand.`,
        );
    }
  for (const [packageName, dir] of repositoryPackages(root)) {
    const json = readJSON(path.join(dir, 'package.json'));
    for (const entry of json.smrt?.retiredTables ?? [])
      for (const definition of entry.definitions ?? []) {
        if (!wanted(definition.release)) continue;
        const where = `Retired table ${entry.table} (${packageName}), definition of release ${definition.release}`;
        let fresh;
        try {
          fresh = definitionFromFacts({
            table: entry.table,
            release: definition.release,
            facts: facts(definition.release),
            lastOwner: entry.lastOwner,
          });
        } catch (error) {
          failures.push(`${where}: ${error.message}`);
          continue;
        }
        if (stableJSON(definition) !== stableJSON(fresh))
          failures.push(
            `${where} is not what that release's published manifests give. Regenerate it with node scripts/retired-table-facts.mjs definition --package ${packageName} --table ${entry.table} --release ${definition.release}; never edit it by hand.`,
          );
      }
  }
  return failures;
}

/** The releases that have a snapshot, oldest first. */
function snapshotReleases(directory) {
  const folder = path.join(directory, 'snapshots');
  return existsSync(folder)
    ? readdirSync(folder)
        .filter((name) => name.endsWith('.json'))
        .map((name) => name.slice(0, -5))
        .sort(releaseOrder)
    : [];
}

/**
 * Bring every generated retire-step fact in line with the snapshot set, from
 * the published manifests; idempotent. Run it after anything that changes
 * `snapshots/` (a base merge, `release:snapshot`):
 *
 * - writes the owners overlay of every snapshot, and deletes the overlay of
 *   a release whose snapshot is gone;
 * - for every retired-table declaration in the repository's package.json
 *   files, rewrites `definitions` to one entry per snapshot release whose
 *   snapshot holds the table (the supported release set), dropping the
 *   entries of any other release.
 *
 * `factsFor(release)` reads a release's facts; each is read once. Returns a
 * summary of what was written and removed.
 */
export function refreshRetiredFacts({ root, directory, factsFor, log = () => {} }) {
  const releases = snapshotReleases(directory);
  const cache = new Map();
  const facts = (release) => {
    if (!cache.has(release)) cache.set(release, factsFor(release));
    return cache.get(release);
  };
  const summary = { owners: [], removed: [], definitions: [] };
  const folder = path.join(directory, 'owners');
  if (existsSync(folder))
    for (const name of readdirSync(folder).filter((n) => n.endsWith('.json'))) {
      const release = name.slice(0, -5);
      if (releases.includes(release)) continue;
      unlinkSync(path.join(folder, name));
      summary.removed.push(release);
      log(`removed owners/${name}: no snapshot for ${release}`);
    }
  for (const release of releases) {
    writeOwnersOverlay({ directory, release, owners: facts(release).owners });
    summary.owners.push(release);
    log(`wrote owners/${release}.json`);
  }
  for (const [packageName, dir] of repositoryPackages(root)) {
    const file = path.join(dir, 'package.json');
    const json = readJSON(file);
    const entries = json.smrt?.retiredTables ?? [];
    if (!entries.length) continue;
    for (const entry of entries) {
      const definitions = [];
      for (const release of releases) {
        const snapshot = readJSON(
          path.join(directory, `snapshots/${release}.json`),
        );
        const held = new Set(snapshot.modelTables ?? Object.keys(snapshot.tables));
        if (!held.has(entry.table)) continue;
        definitions.push(
          definitionFromFacts({
            table: entry.table,
            release,
            facts: facts(release),
            lastOwner: entry.lastOwner,
          }),
        );
      }
      entry.definitions = definitions;
      summary.definitions.push({
        packageName,
        table: entry.table,
        releases: definitions.map((definition) => definition.release),
      });
    }
    writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
  }
  return summary;
}
