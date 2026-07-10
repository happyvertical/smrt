import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const DEPENDENCY_SECTIONS = [
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
  'devDependencies',
];

export function findUnsupportedDependencyProtocols(packageJson) {
  const unsupported = [];

  for (const section of DEPENDENCY_SECTIONS) {
    for (const [name, specifier] of Object.entries(packageJson[section] ?? {})) {
      if (
        typeof specifier === 'string' &&
        (specifier.startsWith('catalog:') || specifier.startsWith('workspace:'))
      ) {
        unsupported.push(`${section}.${name}=${specifier}`);
      }
    }
  }

  return unsupported;
}

function discoverExpectedPackages(repoRoot) {
  const config = JSON.parse(
    readFileSync(join(repoRoot, '.changeset/config.json'), 'utf8'),
  );
  const fixed = new Set(
    (config.fixed ?? []).flatMap((group) => (Array.isArray(group) ? group : [])),
  );
  const packagesDir = join(repoRoot, 'packages');
  const expected = [];

  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(packagesDir, entry.name, 'package.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (manifest.private === true) continue;
    if (!fixed.has(manifest.name) && !manifest.publishConfig) continue;
    expected.push(manifest.name);
  }

  return expected.sort();
}

function findFiles(root, predicate) {
  const found = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) found.push(...findFiles(path, predicate));
    else if (predicate(entry.name)) found.push(path);
  }
  return found;
}

export function verifyPublishArtifacts(artifactDir, repoRoot = process.cwd()) {
  const root = resolve(artifactDir);
  const manifestPaths = findFiles(root, (name) =>
    /^manifest-\d+-of-\d+\.json$/.test(name),
  );
  if (manifestPaths.length === 0) {
    throw new Error(`No publish manifests found under ${root}`);
  }

  const packages = [];
  const versions = new Set();
  for (const manifestPath of manifestPaths) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.packages)) {
      throw new Error(`Invalid publish manifest: ${manifestPath}`);
    }
    versions.add(manifest.releaseVersion);
    for (const artifact of manifest.packages) {
      if (artifact.version !== manifest.releaseVersion) {
        throw new Error(
          `${artifact.name} version does not match its release manifest`,
        );
      }
      packages.push(artifact);
    }
  }

  if (versions.size !== 1) {
    throw new Error(`Publish manifests contain multiple release versions`);
  }

  const names = packages.map((artifact) => artifact.name);
  if (new Set(names).size !== names.length) {
    throw new Error('Publish manifests contain duplicate package names');
  }

  const expected = discoverExpectedPackages(repoRoot);
  const actual = [...names].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    const missing = expected.filter((name) => !actual.includes(name));
    const extra = actual.filter((name) => !expected.includes(name));
    throw new Error(
      `Publish artifact membership mismatch; missing=[${missing.join(', ')}] extra=[${extra.join(', ')}]`,
    );
  }

  for (const artifact of packages) {
    const matches = findFiles(
      root,
      (name) => name === artifact.filename,
    );
    if (matches.length !== 1) {
      throw new Error(
        `Expected one ${artifact.filename} tarball, found ${matches.length}`,
      );
    }
    const sha256 = createHash('sha256')
      .update(readFileSync(matches[0]))
      .digest('hex');
    if (sha256 !== artifact.sha256) {
      throw new Error(`SHA-256 mismatch for ${artifact.name}`);
    }
    artifact.path = matches[0];
  }

  return {
    releaseVersion: [...versions][0],
    packages: packages.sort((left, right) => left.name.localeCompare(right.name)),
  };
}
