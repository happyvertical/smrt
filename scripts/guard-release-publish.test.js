import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  assertHeadMatchesRemote,
  assessReleaseState,
  findMajorVersionOffenders,
  findPublishedPackageConflicts,
  guardReleasePublish,
  listPublishablePackages,
  npmVersionExists,
  releaseTagExistsOnOrigin,
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

  it('treats npm 404 as an unpublished package version', () => {
    const spawn = spawnFromResponses(
      new Map([
        [
          'npm view @happyvertical/smrt-core@0.39.0 version --registry=https://registry.npmjs.org --prefer-online --json',
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
          'npm view @happyvertical/smrt-core@0.39.0 version --registry=https://registry.npmjs.org --prefer-online --json',
          { status: 0, stdout: '"0.39.0"\n' },
        ],
        [
          'npm view @happyvertical/smrt-extra@0.39.0 version --registry=https://registry.npmjs.org --prefer-online --json',
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

  it('reports a release tag that already exists on origin without throwing', () => {
    const spawn = spawnFromResponses(
      new Map([
        [
          'git ls-remote --exit-code --tags origin refs/tags/v0.39.0',
          { status: 0, stdout: 'abc\trefs/tags/v0.39.0\n' },
        ],
      ]),
    );

    expect(releaseTagExistsOnOrigin({ releaseVersion: '0.39.0', spawn })).toBe(
      true,
    );
  });

  it('assessReleaseState resumes a partially published release instead of failing', () => {
    const spawn = spawnFromResponses(
      new Map([
        [
          'git ls-remote --exit-code --tags origin refs/tags/v0.39.0',
          { status: 2, stdout: '', stderr: '' },
        ],
        [
          'npm view @happyvertical/smrt-core@0.39.0 version --registry=https://registry.npmjs.org --prefer-online --json',
          { status: 0, stdout: '"0.39.0"\n' },
        ],
        [
          'npm view @happyvertical/smrt-extra@0.39.0 version --registry=https://registry.npmjs.org --prefer-online --json',
          { status: 1, stderr: 'npm ERR! code E404\n' },
        ],
      ]),
    );

    const state = assessReleaseState({
      publishablePackages: [
        { name: '@happyvertical/smrt-core', version: '0.39.0' },
        { name: '@happyvertical/smrt-extra', version: '0.39.0' },
      ],
      releaseVersion: '0.39.0',
      spawn,
    });

    expect(state.fullyRecorded).toBe(false);
    expect(state.tagAlreadyPushed).toBe(false);
    expect(state.alreadyPublished.map((pkg) => pkg.name)).toEqual([
      '@happyvertical/smrt-core',
    ]);
    expect(state.packagesToPublish.map((pkg) => pkg.name)).toEqual([
      '@happyvertical/smrt-extra',
    ]);
  });

  it('assessReleaseState reports a release as fully recorded once the tag and every package are on origin/npm', () => {
    const spawn = spawnFromResponses(
      new Map([
        [
          'git ls-remote --exit-code --tags origin refs/tags/v0.39.0',
          { status: 0, stdout: 'abc\trefs/tags/v0.39.0\n' },
        ],
        [
          'npm view @happyvertical/smrt-core@0.39.0 version --registry=https://registry.npmjs.org --prefer-online --json',
          { status: 0, stdout: '"0.39.0"\n' },
        ],
      ]),
    );

    const state = assessReleaseState({
      publishablePackages: [
        { name: '@happyvertical/smrt-core', version: '0.39.0' },
      ],
      releaseVersion: '0.39.0',
      spawn,
    });

    expect(state.fullyRecorded).toBe(true);
  });

  it('guardReleasePublish no longer refuses a run that resumes an already-partly-published release', () => {
    const repoRoot = createRepoFixture();
    const spawn = spawnFromResponses(
      new Map([
        [
          'git fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main',
          { status: 0 },
        ],
        ['git rev-parse HEAD', { status: 0, stdout: 'same-head\n' }],
        [
          'git rev-parse refs/remotes/origin/main',
          { status: 0, stdout: 'same-head\n' },
        ],
        [
          'git ls-remote --exit-code --tags origin refs/tags/v0.39.0',
          { status: 2, stdout: '', stderr: '' },
        ],
        [
          'npm view @happyvertical/smrt-core@0.39.0 version --registry=https://registry.npmjs.org --prefer-online --json',
          { status: 0, stdout: '"0.39.0"\n' },
        ],
        [
          'npm view @happyvertical/smrt-extra@0.39.0 version --registry=https://registry.npmjs.org --prefer-online --json',
          { status: 1, stderr: 'npm ERR! code E404\n' },
        ],
      ]),
    );

    const state = guardReleasePublish({
      releaseVersion: '0.39.0',
      repoRoot,
      spawn,
    });

    expect(state.fullyRecorded).toBe(false);
    expect(state.packagesToPublish.map((pkg) => pkg.name)).toEqual([
      '@happyvertical/smrt-extra',
    ]);
  });

  it('guardReleasePublish still refuses a conflicted changesets-mode release, which has no per-package resume logic', () => {
    const repoRoot = createRepoFixture();
    const spawn = spawnFromResponses(
      new Map([
        [
          'git fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main',
          { status: 0 },
        ],
        ['git rev-parse HEAD', { status: 0, stdout: 'same-head\n' }],
        [
          'git rev-parse refs/remotes/origin/main',
          { status: 0, stdout: 'same-head\n' },
        ],
        [
          'git ls-remote --exit-code --tags origin refs/tags/v0.39.0',
          { status: 2, stdout: '', stderr: '' },
        ],
        [
          'npm view @happyvertical/smrt-core@0.39.0 version --registry=https://registry.npmjs.org --prefer-online --json',
          { status: 0, stdout: '"0.39.0"\n' },
        ],
        [
          'npm view @happyvertical/smrt-extra@0.39.0 version --registry=https://registry.npmjs.org --prefer-online --json',
          { status: 1, stderr: 'npm ERR! code E404\n' },
        ],
      ]),
    );

    expect(() =>
      guardReleasePublish({
        publishMode: 'changesets',
        releaseVersion: '0.39.0',
        repoRoot,
        spawn,
      }),
    ).toThrow(/has no per-package resume logic/);
  });

  it('guardReleasePublish treats a fully recorded release as a no-op success', () => {
    const repoRoot = createRepoFixture();
    const spawn = spawnFromResponses(
      new Map([
        [
          'git fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main',
          { status: 0 },
        ],
        ['git rev-parse HEAD', { status: 0, stdout: 'same-head\n' }],
        [
          'git rev-parse refs/remotes/origin/main',
          { status: 0, stdout: 'same-head\n' },
        ],
        [
          'git ls-remote --exit-code --tags origin refs/tags/v0.39.0',
          { status: 0, stdout: 'abc\trefs/tags/v0.39.0\n' },
        ],
        [
          'npm view @happyvertical/smrt-core@0.39.0 version --registry=https://registry.npmjs.org --prefer-online --json',
          { status: 0, stdout: '"0.39.0"\n' },
        ],
        [
          'npm view @happyvertical/smrt-extra@0.39.0 version --registry=https://registry.npmjs.org --prefer-online --json',
          { status: 0, stdout: '"0.39.0"\n' },
        ],
      ]),
    );

    const state = guardReleasePublish({
      releaseVersion: '0.39.0',
      repoRoot,
      spawn,
    });

    expect(state.fullyRecorded).toBe(true);
  });

  it('guardReleasePublish reaches the fully-recorded no-op even when HEAD is stale, because push-release-refs.mjs moved origin/main by publishing this exact release', () => {
    const repoRoot = createRepoFixture();
    // No git-fetch/rev-parse entries here on purpose: a rerun after this
    // run's own earlier successful push checks out the *original*, now
    // superseded SHA — assertHeadMatchesRemote() must never run (and would
    // fail "stale checkout") once the tag/npm state already shows the
    // release fully recorded. If guardReleasePublish regresses to running
    // the HEAD check first, this spawn stub throws "Unexpected command"
    // for the fetch/rev-parse calls it doesn't expect.
    const spawn = spawnFromResponses(
      new Map([
        [
          'git ls-remote --exit-code --tags origin refs/tags/v0.39.0',
          { status: 0, stdout: 'abc\trefs/tags/v0.39.0\n' },
        ],
        [
          'npm view @happyvertical/smrt-core@0.39.0 version --registry=https://registry.npmjs.org --prefer-online --json',
          { status: 0, stdout: '"0.39.0"\n' },
        ],
        [
          'npm view @happyvertical/smrt-extra@0.39.0 version --registry=https://registry.npmjs.org --prefer-online --json',
          { status: 0, stdout: '"0.39.0"\n' },
        ],
      ]),
    );

    const state = guardReleasePublish({
      releaseVersion: '0.39.0',
      repoRoot,
      spawn,
    });

    expect(state.fullyRecorded).toBe(true);
  });

  it("guardReleasePublish clarifies the stale-checkout failure when this release's own tag is already on origin and only the guard's npm read still lags (#2881)", () => {
    const repoRoot = createRepoFixture();
    // Tag already pushed (this run's own prior success moved origin/main),
    // but the guard's own npm read for smrt-extra has not caught up yet, so
    // fullyRecorded is false and assertHeadMatchesRemote() runs and fails.
    // The generic "a newer merge has landed" message is wrong here — this
    // is the release's own tag, not an unrelated newer release.
    const spawn = spawnFromResponses(
      new Map([
        [
          'git fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main',
          { status: 0 },
        ],
        ['git rev-parse HEAD', { status: 0, stdout: 'original-sha\n' }],
        [
          'git rev-parse refs/remotes/origin/main',
          { status: 0, stdout: 'release-commit-sha\n' },
        ],
        [
          'git ls-remote --exit-code --tags origin refs/tags/v0.39.0',
          { status: 0, stdout: 'abc\trefs/tags/v0.39.0\n' },
        ],
        [
          'npm view @happyvertical/smrt-core@0.39.0 version --registry=https://registry.npmjs.org --prefer-online --json',
          { status: 0, stdout: '"0.39.0"\n' },
        ],
        [
          'npm view @happyvertical/smrt-extra@0.39.0 version --registry=https://registry.npmjs.org --prefer-online --json',
          { status: 1, stderr: 'npm ERR! code E404\n' },
        ],
      ]),
    );

    expect(() =>
      guardReleasePublish({
        releaseVersion: '0.39.0',
        repoRoot,
        spawn,
      }),
    ).toThrow(
      /own tag, already pushed by a prior attempt.*smrt-extra.*Re-run once npm registry propagation catches up; do not bump a new version/s,
    );
  });
});
