import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TAURI_CLI_VERSION } from './constants.js';
import { cargoLockWrapperVersion, cargoPackageVersion } from './run.js';

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const repoRoot = resolve(packageDir, '..', '..');
const read = (path: string) => readFileSync(path, 'utf8');
const packageVersion = JSON.parse(
  read(join(packageDir, 'package.json')),
).version;

describe('wrapper and package versions cannot drift (smrt#4965)', () => {
  it('Cargo.toml carries the package version', () => {
    expect(
      cargoPackageVersion(read(join(packageDir, 'wrapper/Cargo.toml'))),
    ).toBe(packageVersion);
  });
  it('Cargo.lock carries the package version for the wrapper crate', () => {
    expect(
      cargoLockWrapperVersion(read(join(packageDir, 'wrapper/Cargo.lock'))),
    ).toBe(packageVersion);
  });
  it('the release version scripts run the sync after changeset version', () => {
    const scripts = JSON.parse(read(join(repoRoot, 'package.json'))).scripts;
    for (const name of ['changeset:version', 'version']) {
      expect(scripts[name], name).toContain(
        'scripts/sync-desktop-wrapper-version.mjs',
      );
    }
  });
});

describe('the Tauri CLI pin', () => {
  it.each([
    'desktop-release.yml',
    'desktop-consumer-build.yml',
  ])('equals the version %s installs', (file) => {
    const workflow = read(join(repoRoot, '.github/workflows', file));
    expect(/^\s*TAURI_CLI_VERSION:\s*([0-9.]+)\s*$/m.exec(workflow)?.[1]).toBe(
      TAURI_CLI_VERSION,
    );
  });
});
