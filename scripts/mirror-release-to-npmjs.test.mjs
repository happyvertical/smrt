import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { compareVersions, mirrorRelease, reportMirror } from './mirror-release-to-npmjs.mjs';

const PRIMARY = 'https://npm.happyvertical.com/';
const NPMJS = 'https://registry.npmjs.org/';
const NAME = '@happyvertical/smrt-core';
const BYTES = Buffer.from('the exact tarball the primary serves');
const SHA1 = createHash('sha1').update(BYTES).digest('hex');

function registryOf(args) {
  return args[args.indexOf('--registry') + 1];
}

// A fake pair of registries: `primary`/`npmjs` map package name -> versions.
function fakeRegistries({ primary, npmjs, publishFails = () => false, unreadable = [] }) {
  const calls = [];
  const published = [];
  const runNpm = (args, options = {}) => {
    calls.push(args);
    const registry = registryOf(args);
    // Every call must carry the scope flag for the SAME registry.
    assert.ok(args.includes(`--@happyvertical:registry=${registry}`), args.join(' '));
    if (args[0] === 'view' && args[2] === 'versions') {
      if (unreadable.includes(registry)) throw new Error('EAI_AGAIN registry unreachable');
      const versions = (registry === PRIMARY ? primary : npmjs)[args[1]];
      if (!versions) {
        assert.ok(options.allowNotFound);
        return null;
      }
      return JSON.stringify(versions.length === 1 ? versions[0] : versions);
    }
    if (args[0] === 'view' && args[2] === 'dist') {
      assert.equal(registry, PRIMARY);
      const [, version] = /@([^@]+)$/.exec(args[1]);
      return JSON.stringify({
        tarball: `${PRIMARY}${NAME}/-/smrt-core-${version}.tgz`,
        shasum: SHA1,
      });
    }
    if (args[0] === 'publish') {
      assert.equal(registry, NPMJS);
      if (publishFails(args)) throw new Error('npm error code E403\nmore detail');
      published.push({ bytes: readFileSync(args[1]), tag: args.includes('--tag') ? args[args.indexOf('--tag') + 1] : 'latest' });
      return '';
    }
    throw new Error(`unexpected npm call: ${args.join(' ')}`);
  };
  const fetchImpl = async (url) => {
    assert.ok(url.startsWith(PRIMARY));
    return { ok: true, status: 200, arrayBuffer: async () => BYTES };
  };
  return { calls, published, runNpm, fetchImpl };
}

function run(fakes, extra = {}) {
  return mirrorRelease({
    packages: [{ name: NAME }],
    primary: PRIMARY,
    mirror: NPMJS,
    backfill: false,
    runNpm: fakes.runNpm,
    fetchImpl: fakes.fetchImpl,
    log: () => {},
    workDir: mkdtempSync(join(tmpdir(), 'mirror-test-')),
    ...extra,
  });
}

test('versions are compared numerically', () => {
  assert.ok(compareVersions('0.51.10', '0.51.9') > 0);
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
});

test('a version newer than npmjs is mirrored with the exact bytes the primary serves', async () => {
  const fakes = fakeRegistries({
    primary: { [NAME]: ['0.51.10', '0.51.11'] },
    npmjs: { [NAME]: ['0.51.10'] },
  });
  const result = await run(fakes);

  assert.deepEqual(result, { mirrored: [`${NAME}@0.51.11`], skipped: [], failed: [] });
  assert.equal(fakes.published.length, 1);
  assert.ok(fakes.published[0].bytes.equals(BYTES));
  assert.equal(fakes.published[0].tag, 'latest');
});

test('nothing is published when npmjs already has every version', async () => {
  const fakes = fakeRegistries({
    primary: { [NAME]: ['0.51.10', '0.51.11'] },
    npmjs: { [NAME]: ['0.51.10', '0.51.11'] },
  });
  assert.deepEqual(await run(fakes), { mirrored: [], skipped: [], failed: [] });
  assert.equal(fakes.published.length, 0);
});

test('several missed releases are mirrored oldest first so latest ends on the newest', async () => {
  const fakes = fakeRegistries({
    primary: { [NAME]: ['0.51.13', '0.51.10', '0.51.12', '0.51.11'] },
    npmjs: { [NAME]: ['0.51.10'] },
  });
  const result = await run(fakes);
  assert.deepEqual(result.mirrored, [`${NAME}@0.51.11`, `${NAME}@0.51.12`, `${NAME}@0.51.13`]);
});

test('an older version missing from npmjs is NOT republished by default', async () => {
  // The primary caches what it proxied, so a version npmjs took down can
  // still be listed here. Missing-on-npmjs alone must not resurrect it.
  const fakes = fakeRegistries({
    primary: { [NAME]: ['0.51.8', '0.51.9', '0.51.10'] },
    npmjs: { [NAME]: ['0.51.8', '0.51.10'] },
  });
  const result = await run(fakes);
  assert.equal(fakes.published.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0], /0\.51\.9: older than npmjs's newest \(0\.51\.10\)/);
});

test('an explicit backfill fills the gap without moving latest backwards', async () => {
  const fakes = fakeRegistries({
    primary: { [NAME]: ['0.51.8', '0.51.9', '0.51.10'] },
    npmjs: { [NAME]: ['0.51.8', '0.51.10'] },
  });
  const result = await run(fakes, { backfill: true });
  assert.deepEqual(result.mirrored, [`${NAME}@0.51.9`]);
  assert.equal(fakes.published[0].tag, 'mirror-backfill');
});

test('an unreadable registry is a failure, never an empty registry', async () => {
  const fakes = fakeRegistries({
    primary: { [NAME]: ['0.51.10', '0.51.11'] },
    npmjs: {},
    unreadable: [NPMJS],
  });
  const result = await run(fakes);
  assert.equal(fakes.published.length, 0);
  assert.match(result.failed[0], /could not read versions/);
});

test('a package that does not exist on npmjs yet is mirrored in full', async () => {
  const fakes = fakeRegistries({ primary: { [NAME]: ['0.1.0'] }, npmjs: {} });
  assert.deepEqual((await run(fakes)).mirrored, [`${NAME}@0.1.0`]);
});

test('a failed publish stops that package so later versions cannot leapfrog it', async () => {
  const fakes = fakeRegistries({
    primary: { [NAME]: ['0.51.10', '0.51.11', '0.51.12'] },
    npmjs: { [NAME]: ['0.51.10'] },
    publishFails: () => true,
  });
  const result = await run(fakes);
  assert.deepEqual(result.mirrored, []);
  assert.deepEqual(result.failed, [`${NAME}@0.51.11: npm error code E403`]);
});

test('a tarball whose bytes do not match the primary metadata is refused', async () => {
  const fakes = fakeRegistries({
    primary: { [NAME]: ['0.51.10', '0.51.11'] },
    npmjs: { [NAME]: ['0.51.10'] },
  });
  const result = await run(fakes, {
    fetchImpl: async () => ({ ok: true, status: 200, arrayBuffer: async () => Buffer.from('tampered') }),
  });
  assert.equal(fakes.published.length, 0);
  assert.match(result.failed[0], /has sha1 .* but the primary's metadata says/);
});

test('a tarball URL outside the primary is refused before anything is fetched', async () => {
  const fakes = fakeRegistries({
    primary: { [NAME]: ['0.51.10', '0.51.11'] },
    npmjs: { [NAME]: ['0.51.10'] },
  });
  const inner = fakes.runNpm;
  let fetched = false;
  const result = await run(fakes, {
    runNpm: (args, options) =>
      args[2] === 'dist'
        ? JSON.stringify({ tarball: 'https://evil.example/x.tgz', shasum: SHA1 })
        : inner(args, options),
    fetchImpl: async () => {
      fetched = true;
      throw new Error('must not be called');
    },
  });
  assert.equal(fetched, false);
  assert.match(result.failed[0], /tarball outside itself/);
});

test('mirroring a registry onto itself is a no-op', async () => {
  const fakes = fakeRegistries({ primary: {}, npmjs: {} });
  const result = await run(fakes, { primary: NPMJS });
  assert.equal(fakes.calls.length, 0);
  assert.deepEqual(result, { mirrored: [], skipped: [], failed: [] });
});

test('the report warns on failures and never throws on an unwritable summary', () => {
  const lines = [];
  reportMirror(
    { mirrored: ['a@1.0.0'], skipped: [], failed: ['b@1.0.0: E403'] },
    {
      log: (line) => lines.push(line),
      env: { GITHUB_STEP_SUMMARY: '/nonexistent/summary' },
      appendSummary: () => {
        throw new Error('EACCES');
      },
    },
  );
  assert.match(lines[0], /1 mirrored, 0 skipped, 1 failed/);
  assert.match(lines[1], /^::warning::npmjs mirror incomplete/);
});
