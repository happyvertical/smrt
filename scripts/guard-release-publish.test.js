import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  assertHeadMatchesRemote,
  assertReleaseTagIsUnused,
  findMajorVersionOffenders,
  findPublishedPackageConflicts,
  listPublishablePackages,
  npmVersionExists,
} from './guard-release-publish.js';

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function createRepoFixture() {
  const repoRoot = mkdtempSync(join(tmpdir(), 'smrt-release-guard-'));
  mkdirSync(join(repoRoot, '.changeset'), { recursive: true });
  mkdirSync(join(repoRoot, 'packages/core'), { recursive: true });
  mkdirSync(join(repoRoot, 'packages/private-mobile'), { recursive: true });
  mkdirSync(join(repoRoot, 'packages/extra'), { recursive: true });

  writeJson(join(repoRoot, 'package.json'), {
    name: '@happyvertical/smrt',
    version: '0.39.0',
  });
  writeJson(join(repoRoot, '.changeset/config.json'), {
    fixed: [['@happyvertical/smrt-core', '@happyvertical/smrt-mobile']],
  });
  writeJson(join(repoRoot, 'packages/core/package.json'), {
    name: '@happyvertical/smrt-core',
    publishConfig: { access: 'public' },
    version: '0.39.0',
  });
  writeJson(join(repoRoot, 'packages/private-mobile/package.json'), {
    name: '@happyvertical/smrt-mobile',
    private: true,
    version: '0.39.0',
  });
  writeJson(join(repoRoot, 'packages/extra/package.json'), {
    name: '@happyvertical/smrt-extra',
    publishConfig: { access: 'public' },
    version: '0.39.0',
  });

  return repoRoot;
}

function spawnFromResponses(responses) {
  return (command, args) => {
    const key = `${command} ${args.join(' ')}`;
    const response = responses.get(key);
    if (!response) {
      throw new Error(`Unexpected command: ${key}`);
    }
    return { stderr: '', stdout: '', ...response };
  };
}

describe('guard-release-publish', () => {
  it('discovers fixed and explicitly publishable packages', () => {
    const repoRoot = createRepoFixture();

    expect(listPublishablePackages(repoRoot).map((pkg) => pkg.name)).toEqual([
      '@happyvertical/smrt-core',
      '@happyvertical/smrt-extra',
    ]);
  });

  it('flags major version manifests', () => {
    expect(
      findMajorVersionOffenders([
        { manifestPath: 'package.json', version: '0.39.0' },
        { manifestPath: 'packages/core/package.json', version: '1.0.0' },
      ]),
    ).toEqual([
      { manifestPath: 'packages/core/package.json', version: '1.0.0' },
    ]);
  });

  it('fails when the workflow checkout is behind origin/main', () => {
    const spawn = spawnFromResponses(
      new Map([
        [
          'git fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main',
          { status: 0 },
        ],
        ['git rev-parse HEAD', { status: 0, stdout: 'old-head\n' }],
        [
          'git rev-parse refs/remotes/origin/main',
          { status: 0, stdout: 'new-head\n' },
        ],
      ]),
    );

    expect(() => assertHeadMatchesRemote({ spawn })).toThrow(
      /Refusing to publish from a stale main checkout/,
    );
  });

  it('fails when the release tag already exists', () => {
    const spawn = spawnFromResponses(
      new Map([
        [
          'git ls-remote --exit-code --tags origin refs/tags/v0.39.0',
          { status: 0, stdout: 'abc\trefs/tags/v0.39.0\n' },
        ],
      ]),
    );

    expect(() =>
      assertReleaseTagIsUnused({ releaseVersion: '0.39.0', spawn }),
    ).toThrow(/release tag v0.39.0 already exists/);
  });

  it('treats npm 404 as an unpublished package version', () => {
    const spawn = spawnFromResponses(
      new Map([
        [
          'npm view @happyvertical/smrt-core@0.39.0 version --registry=https://registry.npmjs.org --json',
          { status: 1, stderr: 'npm ERR! code E404\n' },
        ],
      ]),
    );

    expect(
      npmVersionExists({
        packageName: '@happyvertical/smrt-core',
        spawn,
        version: '0.39.0',
      }),
    ).toBe(false);
  });

  it('reports package versions that are already published on npm', () => {
    const spawn = spawnFromResponses(
      new Map([
        [
          'npm view @happyvertical/smrt-core@0.39.0 version --registry=https://registry.npmjs.org --json',
          { status: 0, stdout: '"0.39.0"\n' },
        ],
        [
          'npm view @happyvertical/smrt-extra@0.39.0 version --registry=https://registry.npmjs.org --json',
          { status: 1, stderr: 'npm ERR! code E404\n' },
        ],
      ]),
    );

    expect(
      findPublishedPackageConflicts({
        packages: [
          { name: '@happyvertical/smrt-core', version: '0.39.0' },
          { name: '@happyvertical/smrt-extra', version: '0.39.0' },
        ],
        spawn,
      }).map((pkg) => pkg.name),
    ).toEqual(['@happyvertical/smrt-core']);
  });
});
