// Run with: node --test scripts/release-preflight.test.mjs
// Every key and secret below is a throwaway test value built in this file;
// none of it is, or derives from, a real credential.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  checkBundle,
  checkProductInputs,
  checkSecrets,
  checkUpdaterPubkey,
  main,
  REQUIRED_SECRETS,
} from './release-preflight.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const TARGET = 'aarch64-apple-darwin';

/** A structurally valid minisign public key built from filler bytes. */
function fakeMinisignPubkey() {
  const body = Buffer.concat([
    Buffer.from('Ed'),
    Buffer.alloc(8, 1),
    Buffer.alloc(32, 2),
  ]).toString('base64');
  return Buffer.from(
    `untrusted comment: minisign public key: 0102030405060708\n${body}\n`,
  ).toString('base64');
}

const secrets = () =>
  Object.fromEntries(REQUIRED_SECRETS.map((name) => [name, 'test-value']));

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
});

function writeBundle(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'preflight-'));
  dirs.push(dir);
  const files = {
    'binaries/acme-node-aarch64-apple-darwin': 'node',
    'resources/sidecar-manifest.json': '{}',
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  const report = {
    target: TARGET,
    product: {
      bundleId: 'org.acme.notes',
      displayName: 'Acme Notes',
      productVersion: '1.2.3',
    },
    node: {
      pin: {
        verification: 'gpg-verified',
        signerFingerprints: ['AB'.repeat(20)],
      },
    },
    ...overrides.report,
  };
  const tauriBundle = overrides.tauriBundle ?? {
    bundle: {
      externalBin: ['binaries/acme-node'],
      resources: { 'resources/': './' },
    },
  };
  const list = Object.entries(files)
    .map(
      ([path, text]) =>
        `${createHash('sha256').update(text).digest('hex')}  ${path}`,
    )
    .join('\n');
  writeFileSync(join(dir, 'bundle-report.json'), JSON.stringify(report));
  writeFileSync(join(dir, 'tauri.bundle.json'), JSON.stringify(tauriBundle));
  writeFileSync(join(dir, 'bundle-files.sha256'), `${list}\n`);
  return dir;
}

describe('secrets', () => {
  it('passes when every secret is present', () => {
    assert.deepEqual(checkSecrets(secrets()), []);
  });

  it('names each missing or empty secret and never a value', () => {
    const env = { ...secrets(), APPLE_ID: '  ', TAURI_SIGNING_PRIVATE_KEY: '' };
    delete env.APPLE_TEAM_ID;
    const problems = checkSecrets(env);
    assert.deepEqual(problems, [
      'missing secret APPLE_ID',
      'missing secret APPLE_TEAM_ID',
      'missing secret TAURI_SIGNING_PRIVATE_KEY',
    ]);
    assert.ok(problems.every((p) => !p.includes('test-value')));
  });

  it('fails with no environment at all', () => {
    assert.equal(checkSecrets({}).length, REQUIRED_SECRETS.length);
  });
});

describe('updater public key', () => {
  it('rejects the committed placeholder', () => {
    const config = JSON.parse(
      readFileSync(join(here, '..', 'tauri.conf.json'), 'utf8'),
    );
    assert.equal(checkUpdaterPubkey(config).length, 1);
  });

  it('rejects a missing, empty or non-key value', () => {
    for (const pubkey of [undefined, '', '   ', 'bm90IGEga2V5', 'RWQ=', 7]) {
      const config = { plugins: { updater: { pubkey } } };
      assert.equal(checkUpdaterPubkey(config).length, 1, String(pubkey));
    }
    assert.equal(checkUpdaterPubkey({}).length, 1);
  });

  it('accepts a structurally valid minisign key', () => {
    const config = { plugins: { updater: { pubkey: fakeMinisignPubkey() } } };
    assert.deepEqual(checkUpdaterPubkey(config), []);
  });
});

describe('product inputs', () => {
  it('accepts repo-relative paths', () => {
    assert.deepEqual(checkProductInputs('apps/notes', 'apps/notes/b.mjs'), []);
  });

  it('rejects empty, absolute, parent and drive paths', () => {
    for (const bad of ['', '/etc', '../x', 'a/../../x', 'C:\\x', 'a\\b']) {
      assert.ok(checkProductInputs(bad, 'b.mjs').length > 0, bad);
      assert.ok(checkProductInputs('a', bad).length > 0, bad);
    }
  });
});

describe('bundle', () => {
  it('accepts a verified, intact bundle and builds the overlay from it', () => {
    const { problems, overlay } = checkBundle(writeBundle(), TARGET);
    assert.deepEqual(problems, []);
    assert.equal(overlay.productName, 'Acme Notes');
    assert.equal(overlay.identifier, 'org.acme.notes');
    assert.equal(overlay.version, '1.2.3');
    assert.deepEqual(overlay.bundle.externalBin, ['binaries/acme-node']);
    assert.equal(overlay.bundle.createUpdaterArtifacts, true);
  });

  it('refuses an unverified Node pin', () => {
    const dir = writeBundle({
      report: {
        node: { pin: { verification: 'unverified', signerFingerprints: [] } },
      },
    });
    const { problems, overlay } = checkBundle(dir, TARGET);
    assert.equal(overlay, undefined);
    assert.ok(problems.some((p) => p.includes('gpg-verified')));
  });

  it('refuses a verified claim without fingerprints', () => {
    const dir = writeBundle({
      report: {
        node: { pin: { verification: 'gpg-verified', signerFingerprints: [] } },
      },
    });
    assert.ok(checkBundle(dir, TARGET).problems.length > 0);
  });

  it('refuses placeholder and empty product identity', () => {
    for (const product of [
      { bundleId: '', displayName: 'A', productVersion: '1' },
      {
        bundleId: 'placeholder.invalid.shell',
        displayName: 'A',
        productVersion: '1',
      },
      { bundleId: 'com.example.app', displayName: 'A', productVersion: '1' },
      {
        bundleId: 'org.acme.notes',
        displayName: 'Placeholder Product',
        productVersion: '1',
      },
      { bundleId: 'org.acme.notes', displayName: '', productVersion: '1' },
      { bundleId: 'notadomain', displayName: 'A', productVersion: '1' },
    ]) {
      const { problems } = checkBundle(
        writeBundle({ report: { product } }),
        TARGET,
      );
      assert.ok(problems.length > 0, JSON.stringify(product));
    }
  });

  it('refuses a bundle for another target', () => {
    const dir = writeBundle({ report: { target: 'x86_64-apple-darwin' } });
    assert.ok(checkBundle(dir, TARGET).problems.length > 0);
  });

  it('refuses a file that changed after the digest list was written', () => {
    const dir = writeBundle();
    writeFileSync(join(dir, 'resources/sidecar-manifest.json'), '{"x":1}');
    const { problems } = checkBundle(dir, TARGET);
    assert.ok(problems.some((p) => p.includes('differs')));
  });

  it('refuses a missing file, an unsafe path and a missing sidecar', () => {
    const dir = writeBundle();
    rmSync(join(dir, 'resources/sidecar-manifest.json'));
    assert.ok(checkBundle(dir, TARGET).problems.length > 0);

    const unsafe = writeBundle();
    writeFileSync(
      join(unsafe, 'bundle-files.sha256'),
      `${'0'.repeat(64)}  resources/../../x\n`,
    );
    assert.ok(checkBundle(unsafe, TARGET).problems.length > 0);

    const bare = writeBundle();
    writeFileSync(join(bare, 'bundle-files.sha256'), '');
    assert.ok(checkBundle(bare, TARGET).problems.length > 0);
  });

  it('refuses an incomplete bundle directory and a wrong tauri fragment', () => {
    assert.ok(
      checkBundle(join(tmpdir(), 'no-such-bundle'), TARGET).problems.length > 0,
    );
    const dir = writeBundle({
      tauriBundle: { bundle: { externalBin: ['x'] } },
    });
    assert.ok(checkBundle(dir, TARGET).problems.length > 0);
  });
});

describe('main', () => {
  const run = (argv, env = {}) => {
    let text = '';
    const code = main(argv, env, { stderr: (t) => (text += t) });
    return { code, text };
  };

  it('is a usage error without a check', () => {
    assert.equal(run([]).code, 2);
    assert.equal(run(['--bogus']).code, 2);
    assert.equal(run(['--bundle', 'x']).code, 2);
  });

  it('fails closed on the committed placeholder config', () => {
    const { code, text } = run([
      '--config',
      join(here, '..', 'tauri.conf.json'),
    ]);
    assert.equal(code, 1);
    assert.match(text, /FAILED/);
    assert.match(text, /Release pipeline/);
  });

  it('fails closed when the config cannot be read', () => {
    assert.equal(run(['--config', join(tmpdir(), 'nope.json')]).code, 1);
  });

  it('passes and writes the overlay for a complete input set', () => {
    const dir = writeBundle();
    const overlay = join(dir, 'overlay.json');
    const { code } = run(
      [
        '--secrets',
        '--bundle',
        dir,
        '--target',
        TARGET,
        '--write-overlay',
        overlay,
      ],
      secrets(),
    );
    assert.equal(code, 0);
    assert.equal(
      JSON.parse(readFileSync(overlay, 'utf8')).identifier,
      'org.acme.notes',
    );
  });

  it('writes no overlay when a check fails', () => {
    const dir = writeBundle();
    const overlay = join(dir, 'overlay.json');
    const { code, text } = run(
      [
        '--secrets',
        '--bundle',
        dir,
        '--target',
        TARGET,
        '--write-overlay',
        overlay,
      ],
      {},
    );
    assert.equal(code, 1);
    assert.match(text, /missing secret APPLE_CERTIFICATE\n/);
    assert.throws(() => readFileSync(overlay));
  });
});
