import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  compareVersions,
  DEFAULT_CONCURRENCY,
  describeNpmError,
  mirrorRelease,
  reportMirror,
  resolveConcurrency,
  runProcess,
} from './mirror-release-to-npmjs.mjs';

const PRIMARY = 'https://npm.happyvertical.com/';
const NPMJS = 'https://registry.npmjs.org/';
const NAME = '@happyvertical/smrt-core';
const BYTES = Buffer.from('the exact tarball the primary serves');
const SHA1 = createHash('sha1').update(BYTES).digest('hex');

function registryOf(args) {
  return args[args.indexOf('--registry') + 1];
}

// A fake pair of registries: `primary`/`npmjs` map package name -> versions.
function fakeRegistries({
  primary,
  npmjs,
  publishFails = () => false,
  unreadable = [],
  shasumOnNpmjs,
}) {
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
    if (args[0] === 'view' && args[2] === 'dist.shasum') {
      return registry === PRIMARY ? SHA1 : (shasumOnNpmjs ?? SHA1);
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
    ...extra,
  });
}

async function withIsolatedTmpdir(run) {
  const previous = process.env.TMPDIR;
  const directory = mkdtempSync(join(tmpdir(), 'mirror-test-tmp-'));
  process.env.TMPDIR = directory;
  try {
    assert.equal(tmpdir(), directory);
    return await run(directory);
  } finally {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
    rmSync(directory, { recursive: true, force: true });
  }
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
  assert.deepEqual(result.failed, [`${NAME}@0.51.11: E403 — more detail`]);
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

test('mirroring a registry onto itself is a no-op', { concurrency: false }, async () => {
  await withIsolatedTmpdir(async (directory) => {
    const fakes = fakeRegistries({ primary: {}, npmjs: {} });
    const result = await run(fakes, { primary: NPMJS });
    assert.equal(fakes.calls.length, 0);
    assert.deepEqual(result, { mirrored: [], skipped: [], failed: [] });
    assert.deepEqual(readdirSync(directory), []);
  });
});

test('a caller-owned work directory is preserved', async () => {
  const fakes = fakeRegistries({
    primary: { [NAME]: ['0.51.11'] },
    npmjs: {},
  });
  const workDir = mkdtempSync(join(tmpdir(), 'mirror-test-'));
  try {
    const sentinel = join(workDir, 'caller-owned');
    writeFileSync(sentinel, 'preserve me');
    const result = await run(fakes, { workDir });
    assert.deepEqual(result.mirrored, [`${NAME}@0.51.11`]);
    assert.ok(existsSync(workDir));
    assert.equal(readFileSync(sentinel, 'utf8'), 'preserve me');
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('an internally-owned work directory is removed when logging throws', { concurrency: false }, async () => {
  await withIsolatedTmpdir(async (directory) => {
    await assert.rejects(
      mirrorRelease({
        packages: [],
        primary: PRIMARY,
        mirror: NPMJS,
        log: () => {
          throw new Error('injected log failure');
        },
      }),
      /injected log failure/,
    );
    assert.deepEqual(readdirSync(directory), []);
  });
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

test('the same version with different bytes on the two registries is reported', async () => {
  const registries = {
    primary: { [NAME]: ['0.51.10', '0.51.11'] },
    npmjs: { [NAME]: ['0.51.10', '0.51.11'] },
  };
  const same = fakeRegistries(registries);
  assert.deepEqual(
    (await run(same, { packages: [{ name: NAME, version: '0.51.11' }] })).failed,
    [],
  );

  const diverged = fakeRegistries({ ...registries, shasumOnNpmjs: 'a'.repeat(40) });
  const result = await run(diverged, { packages: [{ name: NAME, version: '0.51.11' }] });
  assert.equal(diverged.published.length, 0);
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0], /0\.51\.11: DIVERGED — primary sha1 .* npmjs sha1 a{40}/);
});

test('the checksum comparison is skipped for a version npmjs does not have yet', async () => {
  const fakes = fakeRegistries({
    primary: { [NAME]: ['0.51.10', '0.51.11'] },
    npmjs: { [NAME]: ['0.51.10'] },
    shasumOnNpmjs: 'must-not-be-read',
  });
  const result = await run(fakes, { packages: [{ name: NAME, version: '0.51.11' }] });
  assert.deepEqual(result.failed, []);
  assert.ok(!fakes.calls.some((args) => args[2] === 'dist.shasum'));
});

test('a version npmjs permanently refuses is skipped so later versions still mirror', async () => {
  // A takedown of npmjs's newest release: the primary still lists 0.51.11,
  // npmjs has reserved the number, and 0.51.12 must not be held hostage.
  const fakes = fakeRegistries({
    primary: { [NAME]: ['0.51.10', '0.51.11', '0.51.12'] },
    npmjs: { [NAME]: ['0.51.10'] },
    publishFails: (args) => args[1].endsWith('0.51.11.tgz'),
  });
  const inner = fakes.runNpm;
  const result = await run(fakes, {
    runNpm: (args, options) => {
      try {
        return inner(args, options);
      } catch (error) {
        if (args[0] === 'publish') {
          throw new Error(
            'npm error code E403\nnpm error 403 You cannot publish over the previously published versions: 0.51.11.',
          );
        }
        throw error;
      }
    },
  });

  assert.deepEqual(result.mirrored, [`${NAME}@0.51.12`]);
  assert.deepEqual(result.failed, []);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0], /0\.51\.11: npmjs permanently refuses this version/);
  assert.equal(fakes.published.at(-1).tag, 'latest');
});

test('a redirected tarball download is refused, not followed', async () => {
  const fakes = fakeRegistries({
    primary: { [NAME]: ['0.51.10', '0.51.11'] },
    npmjs: { [NAME]: ['0.51.10'] },
  });
  let init;
  const result = await run(fakes, {
    fetchImpl: async (url, options) => {
      init = options;
      return { ok: false, status: 302, arrayBuffer: async () => Buffer.from('elsewhere') };
    },
  });
  assert.equal(init.redirect, 'manual');
  assert.equal(fakes.published.length, 0);
  assert.match(result.failed[0], /redirected the download .* \(HTTP 302\); refusing to follow it/);
});

test('the version this run released is compared, not only the checkout version', async () => {
  // In a release run the mirror job's checkout is still the previous version.
  const diverged = fakeRegistries({
    primary: { [NAME]: ['0.51.10', '0.51.11'] },
    npmjs: { [NAME]: ['0.51.10', '0.51.11'] },
    shasumOnNpmjs: 'b'.repeat(40),
  });
  const onlyCheckout = await run(diverged, { packages: [{ name: NAME, version: '0.51.9' }] });
  assert.deepEqual(onlyCheckout.failed, []);

  const withRelease = await run(diverged, {
    packages: [{ name: NAME, version: '0.51.9' }],
    releaseVersion: '0.51.11',
  });
  assert.equal(withRelease.failed.length, 1);
  assert.match(withRelease.failed[0], /0\.51\.11: DIVERGED/);
});

test('npm failures report the error code and the real cause, not a leading warning', () => {
  assert.deepEqual(
    describeNpmError(
      new Error(
        '[WARN] Failed to replace env in config: ${NODE_AUTH_TOKEN}\nnpm warn publish npm auto-corrected some errors\nnpm error code E401\nnpm error 401 Unauthorized - PUT https://registry.npmjs.org/@happyvertical%2fsmrt-ui',
      ),
    ),
    { code: 'E401', detail: '401 Unauthorized - PUT https://registry.npmjs.org/@happyvertical%2fsmrt-ui' },
  );
  const timedOut = new Error('npm publish was stopped (SIGTERM) after 600s');
  timedOut.code = 'TIMEOUT';
  assert.deepEqual(describeNpmError(timedOut), {
    code: 'TIMEOUT',
    detail: 'npm publish was stopped (SIGTERM) after 600s',
  });
  assert.equal(describeNpmError(new Error('HTTP 502 from the primary')).code, null);
});

test('the report prints every failure to the log as well as the summary', () => {
  const lines = [];
  let summary = '';
  reportMirror(
    { mirrored: [], skipped: [], failed: ['a@1.0.0: E401 — Unauthorized', 'b@2.0.0: E429 — Too Many Requests'] },
    {
      log: (line) => lines.push(line),
      env: { GITHUB_STEP_SUMMARY: '/summary' },
      appendSummary: (_file, text) => {
        summary += text;
      },
    },
  );
  assert.ok(lines.some((line) => line.includes('a@1.0.0: E401 — Unauthorized')));
  assert.ok(lines.some((line) => line.includes('b@2.0.0: E429 — Too Many Requests')));
  assert.match(summary, /- a@1\.0\.0: E401 — Unauthorized/);
  assert.match(summary, /- b@2\.0\.0: E429 — Too Many Requests/);
});

test('the concurrency setting falls back to the default and is capped', () => {
  assert.equal(resolveConcurrency(undefined), DEFAULT_CONCURRENCY);
  assert.equal(resolveConcurrency('0'), DEFAULT_CONCURRENCY);
  assert.equal(resolveConcurrency('nope'), DEFAULT_CONCURRENCY);
  assert.equal(resolveConcurrency('3'), 3);
  assert.equal(resolveConcurrency('500'), 16);
});

test('packages mirror concurrently while each keeps its versions in order', async () => {
  const names = ['@happyvertical/a', '@happyvertical/b', '@happyvertical/c', '@happyvertical/d'];
  const primary = Object.fromEntries(names.map((name) => [name, ['1.0.0', '1.0.1', '1.0.2', '1.0.3']]));
  const npmjs = Object.fromEntries(names.map((name) => [name, ['1.0.0']]));
  const fakes = fakeRegistries({ primary, npmjs });
  const order = [];
  let inFlight = 0;
  let peak = 0;
  const result = await run(fakes, {
    packages: names.map((name) => ({ name })),
    concurrency: 3,
    runNpm: async (args, options) => {
      if (args[0] !== 'publish') return fakes.runNpm(args, options);
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      order.push(/_happyvertical_(\w)-(.+)\.tgz$/.exec(args[1]).slice(1).join('@'));
      return fakes.runNpm(args, options);
    },
  });

  assert.equal(peak, 3);
  assert.equal(result.failed.length, 0);
  // Reported in package order regardless of completion order.
  assert.deepEqual(
    result.mirrored,
    names.flatMap((name) => ['1.0.1', '1.0.2', '1.0.3'].map((v) => `${name}@${v}`)),
  );
  for (const letter of ['a', 'b', 'c', 'd']) {
    assert.deepEqual(
      order.filter((spec) => spec.startsWith(`${letter}@`)),
      ['1.0.1', '1.0.2', '1.0.3'].map((v) => `${letter}@${v}`),
    );
  }
});

test('one package failing does not stop the others in the pool', async () => {
  const names = ['@happyvertical/a', '@happyvertical/b'];
  const fakes = fakeRegistries({
    primary: Object.fromEntries(names.map((name) => [name, ['1.0.0', '1.0.1']])),
    npmjs: Object.fromEntries(names.map((name) => [name, ['1.0.0']])),
    publishFails: (args) => args[1].includes('_happyvertical_a-'),
  });
  const result = await run(fakes, { packages: names.map((name) => ({ name })), concurrency: 2 });
  assert.deepEqual(result.mirrored, ['@happyvertical/b@1.0.1']);
  assert.deepEqual(result.failed, ['@happyvertical/a@1.0.1: E403 — more detail']);
});

test('every failure is logged the moment it is recorded, not only in the final report', async () => {
  const lines = [];
  const diverged = fakeRegistries({
    primary: { [NAME]: ['0.51.10', '0.51.11'] },
    npmjs: { [NAME]: ['0.51.10', '0.51.11'] },
    shasumOnNpmjs: 'c'.repeat(40),
  });
  await run(diverged, { packages: [{ name: NAME, version: '0.51.11' }], log: (line) => lines.push(line) });
  assert.ok(lines.some((line) => /^❌ npmjs mirror failed: .*0\.51\.11: DIVERGED/.test(line)));

  const unreadable = fakeRegistries({ primary: { [NAME]: ['0.51.10'] }, npmjs: {}, unreadable: [NPMJS] });
  lines.length = 0;
  await run(unreadable, { log: (line) => lines.push(line) });
  assert.ok(lines.some((line) => /^❌ npmjs mirror failed: .*could not read versions: EAI_AGAIN/.test(line)));

  const publishFails = fakeRegistries({
    primary: { [NAME]: ['0.51.10', '0.51.11'] },
    npmjs: { [NAME]: ['0.51.10'] },
    publishFails: () => true,
  });
  lines.length = 0;
  await run(publishFails, { log: (line) => lines.push(line) });
  assert.ok(lines.includes(`❌ npmjs mirror failed: ${NAME}@0.51.11: E403 — more detail`));
});

test('a child that ignores SIGTERM is killed and reported as TIMEOUT', async () => {
  const started = Date.now();
  await assert.rejects(
    runProcess(
      process.execPath,
      ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); console.error('npm warn stuck')"],
      { timeoutMs: 300, killGraceMs: 300 },
    ),
    (error) => {
      assert.equal(error.code, 'TIMEOUT');
      assert.equal(describeNpmError(error).code, 'TIMEOUT');
      assert.match(error.message, /was stopped \(SIGKILL\)/);
      return true;
    },
  );
  assert.ok(Date.now() - started < 5000);
});

test('a finished child resolves with its output, and a 404 can be an answer', async () => {
  assert.equal(await runProcess(process.execPath, ['-e', "console.log(' ok ')"], { timeoutMs: 5000 }), 'ok');
  assert.equal(
    await runProcess(process.execPath, ['-e', "console.error('npm error code E404'); process.exit(1)"], {
      timeoutMs: 5000,
      allowNotFound: true,
    }),
    null,
  );
  await assert.rejects(
    runProcess(process.execPath, ['-e', "console.error('npm error code E403'); process.exit(1)"], { timeoutMs: 5000 }),
    /E403/,
  );
});
