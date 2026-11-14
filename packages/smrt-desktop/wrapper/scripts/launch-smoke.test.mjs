import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installTestHome } from '../../../vitest/src/test-home.ts';
import test from 'node:test';
import {
  appLocalDataDir,
  appLogDir,
  CARGO_LOCK,
  containsLaunchSecretShape,
  STAGE_RUN_DIR,
  parseReadyOrigin,
  parseWindowLine,
  processesUnder,
  redact,
  stagePlan,
  tokenFromSetupLocation,
  wrapperIdentifier,
} from './launch-smoke.mjs';

test('the wrapper identifier is the configured one unless a valid override is given', () => {
  const configured = 'placeholder.invalid.smrt-desktop-wrapper';
  assert.equal(wrapperIdentifier(configured, undefined), configured);
  assert.equal(
    wrapperIdentifier(configured, 'com.happyvertical.tricia.debug'),
    'com.happyvertical.tricia.debug',
  );
  for (const bad of ['', 'nodots', '../x', 'a/b.c', 'a b.c', '.a.b']) {
    assert.throws(() => wrapperIdentifier(configured, bad), /reverse-domain/, bad);
  }
});

test('the data root follows the platform conventions of Tauri app_local_data_dir', () => {
  const identifier = 'placeholder.invalid.smrt-desktop-wrapper';
  assert.equal(
    appLocalDataDir({
      platform: 'darwin',
      env: {},
      home: '/Users/u',
      identifier,
    }),
    `/Users/u/Library/Application Support/${identifier}`,
  );
  assert.equal(
    appLocalDataDir({ platform: 'linux', env: {}, home: '/home/u', identifier }),
    `/home/u/.local/share/${identifier}`,
  );
  assert.equal(
    appLocalDataDir({
      platform: 'linux',
      env: { XDG_DATA_HOME: '/data' },
      home: '/home/u',
      identifier,
    }),
    `/data/${identifier}`,
  );
  assert.throws(
    () => appLocalDataDir({ platform: 'win32', env: {}, home: 'C:\\u', identifier }),
    /LOCALAPPDATA/,
  );
});

test('the ready origin is read only from the exact loopback log line', () => {
  assert.equal(
    parseReadyOrigin('x\n[info] sidecar ready origin=http://127.0.0.1:49152 after 812ms\n'),
    'http://127.0.0.1:49152',
  );
  assert.equal(parseReadyOrigin('sidecar ready origin=http://evil.example:1 after 1ms'), null);
  assert.equal(parseReadyOrigin('sidecar ready origin=http://localhost:5 after 1ms'), null);
  assert.equal(parseReadyOrigin(''), null);
});

test('the window line names origin and route and never a token', () => {
  assert.deepEqual(
    parseWindowLine('window origin=http://127.0.0.1:5000 route=/api/_runtime/owner-link'),
    { origin: 'http://127.0.0.1:5000', route: '/api/_runtime/owner-link' },
  );
  assert.equal(parseWindowLine('window origin=http://127.0.0.1:5000 route=https://x'), null);
  assert.equal(parseWindowLine('nothing'), null);
});

test('only a /setup?token= location carries a token', () => {
  const token = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-AB';
  assert.equal(tokenFromSetupLocation(`/setup?token=${token}`), token);
  assert.equal(tokenFromSetupLocation('/'), null);
  assert.equal(tokenFromSetupLocation(`/other?token=${token}`), null);
  assert.equal(tokenFromSetupLocation(`/setup?token=${token}&x=1`), null);
  assert.equal(tokenFromSetupLocation(`https://evil.example/setup?token=${token}`), null);
  assert.equal(tokenFromSetupLocation('/setup?token=short'), null);
  assert.equal(tokenFromSetupLocation(undefined), null);
});

test('redact removes every occurrence of every secret', () => {
  assert.equal(
    redact('a SECRET b SECRET c other', ['SECRET', '', 'other']),
    'a [redacted] b [redacted] c [redacted]',
  );
});

test('smoke failure output uses the CLI credential and launch-link redactor', () => {
  const output = redact([
    'Error: data path exceeds the length budget',
    'Authorization: Bearer x',
    'http://127.0.0.1/setup?launch=unknown-launch-value&token=unknown-token-value',
    'https://user:password@example.invalid/path',
  ].join('\n'), []);
  assert.ok(output.includes('Error: data path exceeds the length budget'));
  assert.ok(output.includes('Bearer [redacted]'));
  for (const secret of ['unknown-launch-value', 'unknown-token-value', 'user:password']) {
    assert.ok(!output.includes(secret));
  }
});

test('a failed wrapper prints only a redacted, bounded log tail and handles split stderr credentials', {
  skip: process.platform === 'win32', // The fixture is a POSIX executable script.
}, () => {
  const root = mkdtempSync(join(tmpdir(), 'smrt-smoke-failure-'));
  const script = new URL('./launch-smoke.mjs', import.meta.url);
  const bundle = join(root, 'bundle');
  const wrapper = join(root, 'wrapper');
  try {
    mkdirSync(join(bundle, 'resources'), { recursive: true });
    mkdirSync(join(bundle, 'binaries'));
    writeFileSync(join(bundle, 'bundle-report.json'), JSON.stringify({ product: { productId: 'fixture' } }));
    writeFileSync(join(bundle, 'resources', 'sidecar-manifest.json'), JSON.stringify({
      healthRoute: '/health', ownerClaimRoute: '/claim',
    }));
    writeFileSync(join(bundle, 'binaries', 'fixture-node-test-triple'), 'unused sidecar fixture');
    writeFileSync(wrapper, `#!/usr/bin/env node
      import { mkdirSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      import { appLogDir } from ${JSON.stringify(script.href)};
      const log = appLogDir({ platform: process.platform, env: process.env,
        home: process.env.HOME, identifier: 'placeholder.invalid.smrt-desktop-wrapper' });
      mkdirSync(log, { recursive: true });
      writeFileSync(join(log, 'supervisor.log'), 'old-head-marker\\n' + 'ordinary diagnostic\\n'.repeat(1000)
        + 'http://127.0.0.1/setup?launch=unknown-launch-value\\nrecent-diagnostic\\n');
      process.stderr.write('Bearer split-');
      setTimeout(() => process.stderr.end('credential-suffix\\n'), 30);
      process.exitCode = 7;
    `, { mode: 0o700 });
    const result = spawnSync(process.execPath, [fileURLToPath(script),
      '--wrapper', wrapper, '--bundle', bundle, '--triple', 'test-triple', '--timeout-ms', '10000',
    ], { encoding: 'utf8', timeout: 15000 });
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes('--- wrapper log tail ---'));
    assert.ok(result.stderr.includes('recent-diagnostic'));
    assert.ok(result.stderr.includes('Bearer [redacted]'));
    for (const forbidden of ['old-head-marker', 'unknown-launch-value', 'credential-suffix']) {
      assert.ok(!result.stderr.includes(forbidden), forbidden);
    }
    const tail = result.stderr.split('--- wrapper log tail ---\n')[1].split('--- wrapper stderr ---')[0];
    assert.ok(Buffer.byteLength(tail.trimEnd()) <= 8192);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('processes of the bundle are found from ps and from the Windows listing', () => {
  const ps = [
    '  100 /usr/sbin/cron',
    '  200 /tmp/stage/generic-smrt-app-node app/build/index.js',
    '  201 /tmp/stage/smrt-desktop-wrapper',
    '  300 /tmp/stage-other/node x',
  ].join('\n');
  assert.deepEqual(processesUnder(ps, '/tmp/stage/', 'ps'), [200, 201]);
  assert.deepEqual(processesUnder('', '/tmp/stage', 'ps'), []);
  const json = JSON.stringify([
    { ProcessId: 4, ExecutablePath: null, CommandLine: null },
    { ProcessId: 9, ExecutablePath: 'C:\\stage\\app-node.exe', CommandLine: null },
  ]);
  assert.deepEqual(processesUnder(json, 'C:\\stage', 'json'), [9]);
  assert.deepEqual(
    processesUnder(JSON.stringify({ ProcessId: 5, CommandLine: 'C:\\stage\\x' }), 'C:\\stage', 'json'),
    [5],
  );
});

test('the stage plan names the product scoped sidecar for the triple', () => {
  assert.deepEqual(
    stagePlan({ productId: 'generic-smrt-app', triple: 'x86_64-pc-windows-msvc', windows: true }),
    {
      sidecarFrom: 'binaries/generic-smrt-app-node-x86_64-pc-windows-msvc.exe',
      sidecarTo: 'generic-smrt-app-node.exe',
      resourcesFrom: 'resources',
    },
  );
  assert.equal(
    stagePlan({ productId: 'p', triple: 't', windows: false }).sidecarTo,
    'p-node',
  );
});

test('the stage mimics a cargo output directory, which Tauri treats as the resource root', () => {
  assert.deepEqual(STAGE_RUN_DIR, ['target', 'debug']);
  assert.equal(CARGO_LOCK, '.cargo-lock');
});

test('a 64-hex run is the shape of the launch secret', () => {
  assert.equal(containsLaunchSecretShape(`x ${'ab'.repeat(32)} y`), true);
  assert.equal(containsLaunchSecretShape('A'.repeat(64)), true);
  assert.equal(containsLaunchSecretShape('ab'.repeat(31)), false);
  assert.equal(containsLaunchSecretShape('ab'.repeat(33)), false);
  assert.equal(
    containsLaunchSecretShape(
      'window origin=http://127.0.0.1:5000 route=/api/_runtime/owner-link',
    ),
    false,
  );
});


test('macOS logs use Library Logs independently of application data', () => {
  assert.equal(appLogDir({ platform: 'darwin', env: {}, home: '/Users/u', identifier: 'com.test.app' }), '/Users/u/Library/Logs/com.test.app');
});


test('the isolated Windows profile bases exist before Tauri resolves first-run data and log paths', () => {
  const dispose = installTestHome();
  try {
    const identifier = 'com.happyvertical.smoke-test';
    const options = { platform: 'win32', env: process.env, home: process.env.HOME, identifier };
    assert.ok(existsSync(process.env.LOCALAPPDATA));
    assert.ok(existsSync(process.env.APPDATA));
    const data = appLocalDataDir(options);
    assert.equal(data, join(process.env.LOCALAPPDATA, identifier));
    assert.equal(appLogDir(options), join(data, 'logs'));
    assert.equal(existsSync(data), false, 'creating OS bases must preserve a fresh app installation');
  } finally {
    dispose();
  }
});

test('smoke-support redaction equals the CLI redactor (the copy cannot drift)', async () => {
  const cli = await import('../../../cli/src/app/errors.ts');
  const support = await import('./smoke-support.mjs');
  const corpus = [
    'Authorization: Bearer x',
    'Bearer abcdefghijklmnop and Bearer s',
    'http://127.0.0.1/setup?launch=unknown-launch-value&token=unknown-token-value',
    'https://user:password@example.invalid/path and scheme://@host',
    'plain text [redacted] already masked [redacted]ish',
    'SECRET_VALUE_12345 appears twice SECRET_VALUE_12345',
    'multi\nline\nwith ?key=abc123 and &password=p%20w',
  ];
  const env = { DEMO_TOKEN: 'SECRET_VALUE_12345', MY_URL: 'u', PATH: '/usr/bin' };
  for (const text of corpus) {
    for (const strict of [true, false]) {
      assert.equal(
        support.redactSecrets(text, env, { strict }),
        cli.redactSecrets(text, env, { strict }),
        text,
      );
    }
  }
  const long = `${'é'.repeat(50)}\n${'x'.repeat(40)}\n${'ü'.repeat(30)}`;
  for (const bytes of [10, 40, 64, 500]) {
    assert.equal(support.boundedTail(long, bytes), cli.boundedTail(long, bytes));
  }
});

test('smoke-support isolates and restores the home directory', async () => {
  const { installIsolatedHome } = await import('./smoke-support.mjs');
  const before = process.env.HOME;
  const dispose = installIsolatedHome();
  assert.notEqual(process.env.HOME, before);
  assert.ok(existsSync(process.env.HOME));
  const home = process.env.HOME;
  dispose();
  assert.equal(process.env.HOME, before);
  assert.ok(!existsSync(home));
});

test('launch-smoke imports nothing from outside the wrapper directory', async () => {
  const { readFileSync } = await import('node:fs');
  for (const name of ['launch-smoke.mjs', 'smoke-support.mjs']) {
    const source = readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');
    const specifiers = [...source.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
    for (const specifier of specifiers) {
      assert.ok(
        specifier.startsWith('node:') || specifier === './smoke-support.mjs',
        `${name} imports ${specifier}`,
      );
    }
  }
});
