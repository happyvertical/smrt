import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, test } from 'node:test';
import { checkSdkVersions } from './check-sdk-versions.mjs';

const directories = [];
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture({ name = '@happyvertical/auth', version = '1.2.3', rawPackage } = {}) {
  const root = mkdtempSync(resolve(realpathSync(tmpdir()), 'sdk-alignment-'));
  directories.push(root);
  const relativeArchive = 'vendor/sdk/revision/auth.tgz';
  const archive = resolve(root, relativeArchive);
  mkdirSync(resolve(root, 'vendor/sdk/revision'), { recursive: true });
  mkdirSync(resolve(root, 'payload/package'), { recursive: true });
  writeFileSync(resolve(root, 'payload/package/package.json'), rawPackage ?? JSON.stringify({ name, version }));
  execFileSync('tar', ['-czf', archive, '-C', resolve(root, 'payload'), 'package']);
  const bytes = readFileSync(archive);
  const manifest = {
    repository: 'https://github.com/happyvertical/sdk',
    revision: 'a'.repeat(40),
    artifacts: [{ file: 'auth.tgz', sha256: createHash('sha256').update(bytes).digest('hex') }],
  };
  const manifestPath = resolve(root, 'vendor/sdk/revision/manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const workspace = `overrides:\n  '@happyvertical/auth': file:${relativeArchive}\n  '@happyvertical/sql': ^1.2.3\n  '@happyvertical/pdf': ^0.65.9\ncatalog:\n  '@happyvertical/sql': ^1.2.3\n  '@happyvertical/ai': ^1.2.3\n  '@happyvertical/pdf': ^0.65.9\n`;
  const workspacePath = resolve(root, 'pnpm-workspace.yaml');
  writeFileSync(workspacePath, workspace);
  const lock = `lockfileVersion: '9.0'\npackages:\n  '@happyvertical/auth@file:${relativeArchive}':\n    resolution: {integrity: sha512-${createHash('sha512').update(bytes).digest('base64')}, tarball: file:${relativeArchive}}\n    version: 1.2.3\nsnapshots:\n`;
  const lockPath = resolve(root, 'pnpm-lock.yaml');
  writeFileSync(lockPath, lock);
  return { root, archive, manifest, manifestPath, workspace, workspacePath, lock, lockPath };
}

test('accepts a same-version immutable archive and retains independent standalone versions', () => {
  const f = fixture();
  assert.equal(checkSdkVersions(f.root), '^1.2.3');
  const result = spawnSync('bash', [resolve('scripts/check-sdk-versions.sh')], { cwd: f.root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('retains strict registry equality and requires a catalog', () => {
  const f = fixture();
  writeFileSync(f.workspacePath, f.workspace.replace('file:vendor/sdk/revision/auth.tgz', '^1.2.3'));
  rmSync(f.lockPath);
  assert.equal(checkSdkVersions(f.root), '^1.2.3');
  writeFileSync(f.workspacePath, f.workspace.replace('file:vendor/sdk/revision/auth.tgz', '^1.2.4'));
  assert.throws(() => checkSdkVersions(f.root), /override version mismatch/);
  writeFileSync(f.workspacePath, f.workspace.replace("'@happyvertical/ai': ^1.2.3", "'@happyvertical/ai': ^1.2.4"));
  assert.throws(() => checkSdkVersions(f.root), /catalog versions/);
  writeFileSync(f.workspacePath, 'overrides:\n');
  assert.throws(() => checkSdkVersions(f.root), /catalog versions/);
});

for (const fields of [{ name: '@happyvertical/sql' }, { version: '1.2.4' }]) {
  test(`rejects archive package identity drift: ${JSON.stringify(fields)}`, () => {
    const f = fixture(fields);
    assert.throws(() => checkSdkVersions(f.root), /package identity\/version/);
  });
}

for (const field of ['repository', 'revision', 'hash', 'missing', 'malformed']) {
  test(`rejects invalid source provenance: ${field}`, () => {
    const f = fixture();
    if (field === 'repository') f.manifest.repository = 'https://example.com/sdk';
    if (field === 'revision') f.manifest.revision = 'main';
    if (field === 'hash') f.manifest.artifacts[0].sha256 = 'b'.repeat(64);
    writeFileSync(f.manifestPath, field === 'malformed' ? '{' : JSON.stringify(f.manifest));
    if (field === 'missing') rmSync(f.manifestPath);
    assert.throws(() => checkSdkVersions(f.root));
  });
}

for (const field of ['integrity', 'version', 'tarball', 'missing']) {
  test(`rejects lock disagreement: ${field}`, () => {
    const f = fixture();
    let lock = f.lock;
    if (field === 'integrity') lock = lock.replace(/sha512-[^,]+/, 'sha512-wrong');
    if (field === 'version') lock = lock.replace('version: 1.2.3', 'version: 1.2.4');
    if (field === 'tarball') lock = lock.replace('tarball: file:vendor', 'tarball: file:other');
    if (field === 'missing') lock = 'packages:\n';
    writeFileSync(f.lockPath, lock);
    assert.throws(() => checkSdkVersions(f.root), /lock/);
  });
}

for (const path of ['/tmp/auth.tgz', '../auth.tgz', 'vendor/../auth.tgz', 'vendor/missing.tgz']) {
  test(`rejects uncontained or missing archive: ${path}`, () => {
    const f = fixture();
    writeFileSync(f.workspacePath, f.workspace.replace('vendor/sdk/revision/auth.tgz', path));
    assert.throws(() => checkSdkVersions(f.root));
  });
}

test('rejects archive and provenance symlinks', () => {
  for (const field of ['archive', 'manifestPath']) {
    const f = fixture();
    const target = `${f[field]}.original`;
    writeFileSync(target, readFileSync(f[field]));
    rmSync(f[field]);
    symlinkSync(target, f[field]);
    assert.throws(() => checkSdkVersions(f.root), /without symlinks/);
  }
});

test('rejects malformed archive package metadata and duplicate provenance records', () => {
  const malformed = fixture({ rawPackage: '{' });
  assert.throws(() => checkSdkVersions(malformed.root));
  const duplicated = fixture();
  duplicated.manifest.artifacts.push(duplicated.manifest.artifacts[0]);
  writeFileSync(duplicated.manifestPath, JSON.stringify(duplicated.manifest));
  assert.throws(() => checkSdkVersions(duplicated.root), /provenance mismatch/);
});

test('rejects ambiguous duplicate lock package entries', () => {
  const f = fixture();
  writeFileSync(f.lockPath, f.lock.replace('snapshots:', f.lock.split('packages:')[1]));
  assert.throws(() => checkSdkVersions(f.root), /one pnpm lock package entry/);
});
