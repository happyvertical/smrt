import assert from 'node:assert/strict';
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
