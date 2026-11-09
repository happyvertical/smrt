// Run with: node --test scripts/release-preflight.test.mjs
// Every key and secret below is a throwaway test value built in this file;
// none of it is, or derives from, a real credential.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
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
  parseNodePins,
  REQUIRED_SECRETS,
  stageBundle,
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

const NODE_ARCHIVE = 'node-v26.8.1-darwin-arm64.tar.gz';
const NODE_ARCHIVE_SHA = 'ab'.repeat(32);
const NODE_BINARY = 'node-binary';
const sha = (text) => createHash('sha256').update(text).digest('hex');

/** A committed pin record in the shape `parseNodePins` returns. */
function trustedPins(overrides = {}) {
  return {
    nodePins: {
      pins: {
        '26.8.1': {
          [NODE_ARCHIVE]: NODE_ARCHIVE_SHA,
          'win-x64/node.exe': sha(NODE_BINARY),
        },
      },
      provenance: {
        '26.8.1': {
          verification: 'gpg-verified',
          source: 'https://nodejs.org/dist/v26.8.1/SHASUMS256.txt',
          retrieved: '2026-11-09T00:43:17Z',
          shasumsSha256: 'cd'.repeat(32),
          signerFingerprints: ['AB'.repeat(20)],
        },
      },
      ...overrides,
    },
  };
}

function writeBundle(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'preflight-'));
  dirs.push(dir);
  const files = {
    'binaries/acme-node-aarch64-apple-darwin': NODE_BINARY,
    'resources/sidecar-manifest.json': '{}',
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  const report = {
    target: TARGET,
    product: {
      productId: 'acme',
      bundleId: 'org.acme.notes',
      displayName: 'Acme Notes',
      productVersion: '1.2.3',
    },
    node: {
      version: '26.8.1',
      distFile: NODE_ARCHIVE,
      archiveSha256: NODE_ARCHIVE_SHA,
      binarySha256: sha(NODE_BINARY),
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
    .map(([path, text]) => `${sha(text)}  ${path}`)
    .join('\n');
  writeFileSync(join(dir, 'bundle-report.json'), JSON.stringify(report));
  writeFileSync(join(dir, 'tauri.bundle.json'), JSON.stringify(tauriBundle));
  writeFileSync(join(dir, 'bundle-files.sha256'), `${list}\n`);
  return dir;
}

const check = (dir, trust = trustedPins(), target = TARGET) =>
  checkBundle(dir, target, {}, trust);

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
    const { problems, overlay } = check(writeBundle());
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
    const { problems, overlay } = check(dir);
    assert.equal(overlay, undefined);
    assert.ok(problems.some((p) => p.includes('gpg-verified')));
  });

  it('refuses a verified claim without fingerprints', () => {
    const dir = writeBundle({
      report: {
        node: { pin: { verification: 'gpg-verified', signerFingerprints: [] } },
      },
    });
    assert.ok(check(dir).problems.length > 0);
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
      product.productId = 'acme';
      product.productVersion = '1.0.0';
      const { problems } = check(writeBundle({ report: { product } }));
      assert.ok(problems.length > 0, JSON.stringify(product));
    }
  });

  it('refuses a bundle for another target', () => {
    const dir = writeBundle({ report: { target: 'x86_64-apple-darwin' } });
    assert.ok(check(dir).problems.length > 0);
  });

  it('refuses a file that changed after the digest list was written', () => {
    const dir = writeBundle();
    writeFileSync(join(dir, 'resources/sidecar-manifest.json'), '{"x":1}');
    const { problems } = check(dir);
    assert.ok(problems.some((p) => p.includes('differs')));
  });

  it('refuses a missing file, an unsafe path and a missing sidecar', () => {
    const dir = writeBundle();
    rmSync(join(dir, 'resources/sidecar-manifest.json'));
    assert.ok(check(dir).problems.length > 0);

    const unsafe = writeBundle();
    writeFileSync(
      join(unsafe, 'bundle-files.sha256'),
      `${'0'.repeat(64)}  resources/../../x\n`,
    );
    assert.ok(check(unsafe).problems.length > 0);

    const bare = writeBundle();
    writeFileSync(join(bare, 'bundle-files.sha256'), '');
    assert.ok(check(bare).problems.length > 0);
  });

  it('refuses an incomplete bundle directory and a wrong tauri fragment', () => {
    assert.ok(check(join(tmpdir(), 'no-such-bundle')).problems.length > 0);
    const dir = writeBundle({
      tauriBundle: { bundle: { externalBin: ['x'] } },
    });
    assert.ok(check(dir).problems.length > 0);
  });
});

describe('bundle: closed tauri.bundle.json (overlay allowlist)', () => {
  const base = () => ({
    externalBin: ['binaries/acme-node'],
    resources: { 'resources/': './' },
  });
  const refused = (tauriBundle) => {
    const { problems, overlay } = check(writeBundle({ tauriBundle }));
    assert.equal(overlay, undefined, JSON.stringify(tauriBundle));
    assert.ok(
      problems.some((p) => p.includes('tauri.bundle.json')),
      JSON.stringify(tauriBundle),
    );
  };

  it('refuses a Windows signCommand, an NSIS template and macOS files', () => {
    refused({ bundle: { ...base(), windows: { signCommand: 'curl x | sh' } } });
    refused({
      bundle: { ...base(), windows: { nsis: { template: '!system "x"' } } },
    });
    refused({
      bundle: { ...base(), macOS: { files: { 'Contents/x': '/etc/passwd' } } },
    });
    refused({
      bundle: {
        ...base(),
        linux: { deb: { files: { '/usr/bin/x': '../../secret' } } },
      },
    });
    refused({
      bundle: {
        ...base(),
        macOS: { hardenedRuntime: false, entitlements: 'x' },
      },
    });
  });

  it('refuses extra keys at the top level and inside resources', () => {
    refused({ ...{ bundle: base() }, build: { beforeBuildCommand: 'x' } });
    refused({
      bundle: { ...base(), resources: { 'resources/': './', '/etc': 'x' } },
    });
    refused({ bundle: { ...base(), createUpdaterArtifacts: false } });
    refused({ bundle: { ...base(), active: true } });
  });

  it('refuses prototype keys and a changed sidecar or resources shape', () => {
    refused(JSON.parse('{"__proto__":{"x":1},"bundle":{}}'));
    const withProto = JSON.parse(
      '{"bundle":{"externalBin":["binaries/acme-node"],"resources":{"resources/":"./"},"__proto__":{"a":1}}}',
    );
    refused(withProto);
    refused({
      bundle: { ...base(), externalBin: ['binaries/acme-node', 'x'] },
    });
    refused({ bundle: { ...base(), externalBin: ['binaries/other-node'] } });
    refused({ bundle: { ...base(), externalBin: ['/usr/bin/node'] } });
    refused({ bundle: { ...base(), resources: { 'resources/': '../' } } });
    refused({ bundle: { ...base(), resources: ['resources/'] } });
  });

  it('builds the overlay from the allowlist alone', () => {
    const { overlay } = check(writeBundle());
    assert.deepEqual(overlay.bundle, {
      externalBin: ['binaries/acme-node'],
      resources: { 'resources/': './' },
      createUpdaterArtifacts: true,
    });
    assert.deepEqual(Object.keys(overlay).sort(), [
      'bundle',
      'identifier',
      'productName',
      'version',
    ]);
  });

  it('refuses unsafe product names and versions', () => {
    for (const displayName of [
      '../Evil',
      'A/B',
      ' A',
      '.hidden',
      'A\nB',
      'A:B',
    ]) {
      const product = {
        productId: 'acme',
        bundleId: 'org.acme.notes',
        displayName,
        productVersion: '1.0.0',
      };
      assert.ok(
        check(writeBundle({ report: { product } })).problems.length > 0,
      );
    }
    for (const productVersion of ['1', '1.0', '../1.0.0', '1.0.0 x', '']) {
      const product = {
        productId: 'acme',
        bundleId: 'org.acme.notes',
        displayName: 'A',
        productVersion,
      };
      assert.ok(
        check(writeBundle({ report: { product } })).problems.length > 0,
      );
    }
  });
});

describe('bundle: every file on disk is verified', () => {
  const treeProblem = (dir) => {
    const { problems, overlay } = check(dir);
    assert.equal(overlay, undefined);
    return problems;
  };

  it('refuses a file the digest list does not name', () => {
    const dir = writeBundle();
    writeFileSync(join(dir, 'resources/extra.js'), 'evil');
    assert.ok(treeProblem(dir).some((p) => p.includes('exactly the files')));
  });

  it('refuses an unlisted file in a nested directory', () => {
    const dir = writeBundle();
    mkdirSync(join(dir, 'binaries/sub'));
    writeFileSync(join(dir, 'binaries/sub/x'), 'evil');
    assert.ok(treeProblem(dir).length > 0);
  });

  it('refuses a symlink, to a file or a directory, anywhere in the tree', () => {
    const toFile = writeBundle();
    symlinkSync('/etc/hosts', join(toFile, 'resources/hosts'));
    assert.ok(treeProblem(toFile).some((p) => p.includes('symlink')));

    const toDir = writeBundle();
    symlinkSync('/etc', join(toDir, 'resources/etc'));
    assert.ok(treeProblem(toDir).some((p) => p.includes('symlink')));

    const nested = writeBundle();
    mkdirSync(join(nested, 'resources/a'));
    symlinkSync('../sidecar-manifest.json', join(nested, 'resources/a/b'));
    assert.ok(treeProblem(nested).some((p) => p.includes('symlink')));
  });

  it('refuses a listed file replaced by a symlink with the same content', () => {
    const dir = writeBundle();
    writeFileSync(join(dir, 'resources/real.json'), '{}');
    rmSync(join(dir, 'resources/sidecar-manifest.json'));
    symlinkSync('real.json', join(dir, 'resources/sidecar-manifest.json'));
    assert.ok(treeProblem(dir).length > 0);
  });

  it('refuses a symlinked binaries/ or resources/ root', () => {
    const dir = writeBundle();
    const real = mkdtempSync(join(tmpdir(), 'preflight-real-'));
    dirs.push(real);
    mkdirSync(join(real, 'resources'));
    writeFileSync(join(real, 'resources/sidecar-manifest.json'), '{}');
    rmSync(join(dir, 'resources'), { recursive: true });
    symlinkSync(join(real, 'resources'), join(dir, 'resources'));
    assert.ok(treeProblem(dir).length > 0);
  });

  it('refuses a digest-list entry that is missing on disk', () => {
    const dir = writeBundle();
    rmSync(join(dir, 'resources/sidecar-manifest.json'));
    assert.ok(treeProblem(dir).length > 0);
  });

  it('refuses a duplicate digest-list line', () => {
    const dir = writeBundle();
    const line = `${sha('{}')}  resources/sidecar-manifest.json\n`;
    const path = join(dir, 'bundle-files.sha256');
    writeFileSync(path, readFileSync(path, 'utf8') + line);
    assert.ok(treeProblem(dir).some((p) => p.includes('duplicate')));
  });
});

describe('bundle: the root holds only the expected entries', () => {
  const rootProblems = (dir) => {
    const { problems, overlay } = check(dir);
    assert.equal(overlay, undefined);
    return problems;
  };

  it('refuses an unexpected top-level file', () => {
    const dir = writeBundle();
    writeFileSync(join(dir, 'extra.json'), '{}');
    assert.ok(rootProblems(dir).some((p) => p.includes('unexpected entry')));
  });

  it('refuses an unexpected top-level directory', () => {
    const dir = writeBundle();
    mkdirSync(join(dir, 'tauri.conf.d'));
    assert.ok(rootProblems(dir).some((p) => p.includes('unexpected entry')));
  });

  it('refuses a symlink at the root, even one named like a real entry', () => {
    const named = writeBundle();
    writeFileSync(join(named, 'real.json'), '{}');
    rmSync(join(named, 'tauri.bundle.json'));
    symlinkSync('real.json', join(named, 'tauri.bundle.json'));
    assert.ok(rootProblems(named).some((p) => p.includes('symlink')));

    const other = writeBundle();
    symlinkSync('../../packages/smrt-desktop/shell', join(other, 'x'));
    assert.ok(rootProblems(other).some((p) => p.includes('symlink')));
  });

  it('refuses a symlink in a nested directory', () => {
    const dir = writeBundle();
    mkdirSync(join(dir, 'binaries/sub'));
    symlinkSync('/etc', join(dir, 'binaries/sub/etc'));
    assert.ok(rootProblems(dir).some((p) => p.includes('symlink')));
  });

  it('refuses a directory for a metadata file and a file for binaries/', () => {
    const meta = writeBundle();
    rmSync(join(meta, 'bundle-report.json'));
    mkdirSync(join(meta, 'bundle-report.json'));
    assert.ok(rootProblems(meta).some((p) => p.includes('regular file')));

    const bin = writeBundle();
    rmSync(join(bin, 'binaries'), { recursive: true });
    writeFileSync(join(bin, 'binaries'), 'x');
    assert.ok(rootProblems(bin).some((p) => p.includes('real directory')));
  });

  it('refuses a bundle root that is itself a symlink', () => {
    const real = writeBundle();
    const holder = mkdtempSync(join(tmpdir(), 'preflight-link-'));
    dirs.push(holder);
    const link = join(holder, 'bundle');
    symlinkSync(real, link);
    assert.ok(rootProblems(link).some((p) => p.includes('real directory')));
  });

  it('reports nothing about names it refuses', () => {
    const dir = writeBundle();
    writeFileSync(join(dir, 'secret-looking-name'), 'x');
    assert.ok(!rootProblems(dir).join('\n').includes('secret-looking-name'));
  });
});

describe('bundle: the Node sidecar against the committed pin', () => {
  const nodeReport = (changes) => ({
    node: {
      version: '26.8.1',
      distFile: NODE_ARCHIVE,
      archiveSha256: NODE_ARCHIVE_SHA,
      binarySha256: sha(NODE_BINARY),
      pin: {
        verification: 'gpg-verified',
        signerFingerprints: ['AB'.repeat(20)],
      },
      ...changes,
    },
  });

  it('ignores a self-attested gpg-verified claim when the committed record is not', () => {
    const trust = trustedPins({
      provenance: {
        '26.8.1': {
          verification: 'unverified',
          source: 'x',
          retrieved: 'x',
          shasumsSha256: 'cd'.repeat(32),
          signerFingerprints: [],
        },
      },
    });
    const { problems } = check(writeBundle(), trust);
    assert.ok(problems.some((p) => p.includes('committed pin record')));
  });

  it('refuses a committed record that claims gpg without fingerprints', () => {
    const trust = trustedPins();
    trust.nodePins.provenance['26.8.1'].signerFingerprints = [];
    assert.ok(check(writeBundle(), trust).problems.length > 0);
    const bad = trustedPins();
    bad.nodePins.provenance['26.8.1'].signerFingerprints = [
      'not-a-fingerprint',
    ];
    assert.ok(check(writeBundle(), bad).problems.length > 0);
  });

  it('refuses an archive digest that is not the committed pin', () => {
    const dir = writeBundle({
      report: nodeReport({ archiveSha256: 'ee'.repeat(32) }),
    });
    assert.ok(
      check(dir).problems.some((p) => p.includes('not the committed pin')),
    );
  });

  it('refuses a version, dist file or target the pin table does not hold', () => {
    for (const changes of [
      { version: '99.0.0' },
      { distFile: 'node-v26.8.1-darwin-x64.tar.gz' },
      { version: '__proto__' },
      { version: '26.8.1/../x' },
    ]) {
      assert.ok(
        check(writeBundle({ report: nodeReport(changes) })).problems.length > 0,
        JSON.stringify(changes),
      );
    }
    // an empty pin table: nothing is accepted
    assert.ok(
      check(writeBundle(), trustedPins({ pins: {} })).problems.some((p) =>
        p.includes('committed pin table'),
      ),
    );
  });

  it('refuses to run without a committed record at all', () => {
    const { problems } = checkBundle(writeBundle(), TARGET, {}, {});
    assert.ok(problems.some((p) => p.includes('committed Node pin record')));
  });

  it('refuses a swapped Node archive whose digests were recomputed', () => {
    const dir = writeBundle();
    writeFileSync(join(dir, 'binaries/acme-node-aarch64-apple-darwin'), 'evil');
    writeFileSync(
      join(dir, 'bundle-files.sha256'),
      `${sha('evil')}  binaries/acme-node-aarch64-apple-darwin\n${sha('{}')}  resources/sidecar-manifest.json\n`,
    );
    const report = JSON.parse(
      readFileSync(join(dir, 'bundle-report.json'), 'utf8'),
    );
    report.node.binarySha256 = sha('evil');
    report.node.archiveSha256 = sha('evil');
    writeFileSync(join(dir, 'bundle-report.json'), JSON.stringify(report));
    assert.ok(check(dir).problems.some((p) => p.includes('committed pin')));
  });

  // KNOWN LIMIT, documented in the README: on macOS and Linux the committed
  // table pins the .tar.gz archive, not the extracted binary, and the job
  // that extracts it is the untrusted one. A swapped binary that keeps the
  // genuine archive digest in its report therefore passes. Windows does not
  // have this gap (next test). This test fails the day the gap is closed.
  it('does not prove an extracted tar.gz binary (known limit)', () => {
    const dir = writeBundle();
    writeFileSync(join(dir, 'binaries/acme-node-aarch64-apple-darwin'), 'evil');
    writeFileSync(
      join(dir, 'bundle-files.sha256'),
      `${sha('evil')}  binaries/acme-node-aarch64-apple-darwin\n${sha('{}')}  resources/sidecar-manifest.json\n`,
    );
    const report = JSON.parse(
      readFileSync(join(dir, 'bundle-report.json'), 'utf8'),
    );
    report.node.binarySha256 = sha('evil');
    writeFileSync(join(dir, 'bundle-report.json'), JSON.stringify(report));
    assert.deepEqual(check(dir).problems, []);
  });

  it('proves the binary itself on Windows, where node.exe is the pinned file', () => {
    const files = {
      'binaries/acme-node-x86_64-pc-windows-msvc.exe': NODE_BINARY,
      'resources/sidecar-manifest.json': '{}',
    };
    const win = (binary) => {
      const dir = writeBundle({
        report: {
          target: 'x86_64-pc-windows-msvc',
          node: {
            version: '26.8.1',
            distFile: 'win-x64/node.exe',
            archiveSha256: sha(NODE_BINARY),
            binarySha256: sha(binary),
            pin: {
              verification: 'gpg-verified',
              signerFingerprints: ['AB'.repeat(20)],
            },
          },
        },
      });
      rmSync(join(dir, 'binaries'), { recursive: true });
      mkdirSync(join(dir, 'binaries'));
      writeFileSync(
        join(dir, 'binaries/acme-node-x86_64-pc-windows-msvc.exe'),
        binary,
      );
      writeFileSync(
        join(dir, 'bundle-files.sha256'),
        `${sha(binary)}  binaries/acme-node-x86_64-pc-windows-msvc.exe\n${sha(files['resources/sidecar-manifest.json'])}  resources/sidecar-manifest.json\n`,
      );
      return check(dir, trustedPins(), 'x86_64-pc-windows-msvc');
    };
    assert.deepEqual(win(NODE_BINARY).problems, []);
    assert.ok(win('evil').problems.some((p) => p.includes('pinned node.exe')));
  });
});

describe('parseNodePins', () => {
  it('reads the committed pin table and provenance', () => {
    const source = readFileSync(
      join(here, '..', '..', 'src', 'bundler', 'node-pins.ts'),
      'utf8',
    );
    const { pins, provenance } = parseNodePins(source);
    const versions = Object.keys(pins);
    assert.ok(versions.length > 0);
    for (const version of versions) {
      assert.ok(Object.keys(pins[version]).length > 0);
      assert.ok(provenance[version]);
    }
  });

  it('fails closed on the committed pin record while it is unverified', () => {
    const source = readFileSync(
      join(here, '..', '..', 'src', 'bundler', 'node-pins.ts'),
      'utf8',
    );
    const trust = { nodePins: parseNodePins(source) };
    const verified = Object.values(trust.nodePins.provenance).some(
      (record) => record.verification === 'gpg-verified',
    );
    const { problems } = check(writeBundle(), trust);
    assert.ok(problems.length > 0);
    assert.equal(
      problems.some((p) => p.includes('committed pin record')),
      !verified,
    );
  });

  it('throws on a missing block and on anything that is not plain data', () => {
    assert.throws(() => parseNodePins('const x = 1;'));
    assert.throws(() =>
      parseNodePins(
        "// BEGIN GENERATED PINS (x)\nconst NODE_PINS_DATA: NodePinTable = {\n  '1.0.0': { 'f': fetch('x') },\n};\n// END GENERATED PINS",
      ),
    );
    assert.throws(() =>
      parseNodePins(
        "// BEGIN GENERATED PINS (x)\nconst NODE_PINS_DATA: NodePinTable = {\n  '1.0.0': { 'f': 'nothex' },\n};\nconst NODE_PIN_PROVENANCE_DATA: NodePinProvenanceTable = {\n};\n// END GENERATED PINS",
      ),
    );
  });
});

describe('stageBundle', () => {
  it('copies exactly the verified files and marks binaries/ executable', () => {
    const dir = writeBundle();
    const { verified } = check(dir);
    // An artifact drops the executable bit: nothing here is executable.
    chmodSync(join(dir, 'binaries/acme-node-aarch64-apple-darwin'), 0o644);
    writeFileSync(join(dir, 'resources/unlisted'), 'x');
    const dest = mkdtempSync(join(tmpdir(), 'stage-'));
    dirs.push(dest);
    stageBundle(dir, verified, dest);
    assert.equal(
      readFileSync(join(dest, 'resources/sidecar-manifest.json'), 'utf8'),
      '{}',
    );
    assert.equal(existsSync(join(dest, 'resources/unlisted')), false);
    assert.ok(
      lstatSync(join(dest, 'binaries/acme-node-aarch64-apple-darwin')).mode &
        0o100,
    );
    assert.equal(
      lstatSync(join(dest, 'resources/sidecar-manifest.json')).mode & 0o111,
      0,
    );
  });

  it('refuses a file that changed after verification and an existing target', () => {
    const dir = writeBundle();
    const { verified } = check(dir);
    const dest = mkdtempSync(join(tmpdir(), 'stage-'));
    dirs.push(dest);
    writeFileSync(join(dir, 'resources/sidecar-manifest.json'), '{"x":1}');
    assert.throws(() => stageBundle(dir, verified, dest));

    writeFileSync(join(dir, 'resources/sidecar-manifest.json'), '{}');
    mkdirSync(join(dest, 'resources'));
    writeFileSync(join(dest, 'resources/sidecar-manifest.json'), 'old');
    assert.throws(() => stageBundle(dir, verified, dest));
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

  const pinsFile = () => {
    const dir = mkdtempSync(join(tmpdir(), 'pins-'));
    dirs.push(dir);
    const path = join(dir, 'node-pins.ts');
    writeFileSync(
      path,
      `// BEGIN GENERATED PINS (scripts/update-node-pins.mjs)
const NODE_PINS_DATA: NodePinTable = {
  '26.8.1': {
    '${NODE_ARCHIVE}':
      '${NODE_ARCHIVE_SHA}',
  },
};
const NODE_PIN_PROVENANCE_DATA: NodePinProvenanceTable = {
  '26.8.1': {
    verification: 'gpg-verified',
    source: 'https://nodejs.org/dist/v26.8.1/SHASUMS256.txt',
    retrieved: '2026-11-09T00:43:17Z',
    shasumsSha256:
      '${'cd'.repeat(32)}',
    signerFingerprints: [
      '${'AB'.repeat(20)}',
    ],
  },
};
// END GENERATED PINS
`,
    );
    return path;
  };

  it('needs the committed pin table with a bundle', () => {
    assert.equal(run(['--bundle', 'x', '--target', TARGET]).code, 2);
    assert.equal(run(['--stage', 'x']).code, 2);
  });

  it('fails closed when the committed pin table cannot be read', () => {
    const { code, text } = run([
      '--bundle',
      writeBundle(),
      '--target',
      TARGET,
      '--node-pins',
      join(tmpdir(), 'no-such-pins.ts'),
    ]);
    assert.equal(code, 1);
    assert.match(text, /pin table is unreadable/);
  });

  it('passes, writes the overlay and stages only verified files', () => {
    const dir = writeBundle();
    writeFileSync(join(dir, 'resources/unlisted'), 'x');
    const overlay = join(dir, 'overlay.json');
    const stage = mkdtempSync(join(tmpdir(), 'stage-'));
    dirs.push(stage);
    // the unlisted file must fail it
    const bad = run(
      [
        '--bundle',
        dir,
        '--target',
        TARGET,
        '--node-pins',
        pinsFile(),
        '--write-overlay',
        overlay,
        '--stage',
        stage,
      ],
      secrets(),
    );
    assert.equal(bad.code, 1);
    assert.equal(existsSync(overlay), false);
    assert.equal(existsSync(join(stage, 'resources')), false);

    rmSync(join(dir, 'resources/unlisted'));
    const { code } = run(
      [
        '--secrets',
        '--bundle',
        dir,
        '--target',
        TARGET,
        '--node-pins',
        pinsFile(),
        '--write-overlay',
        overlay,
        '--stage',
        stage,
      ],
      secrets(),
    );
    assert.equal(code, 0);
    assert.equal(
      JSON.parse(readFileSync(overlay, 'utf8')).identifier,
      'org.acme.notes',
    );
    assert.equal(
      readFileSync(join(stage, 'resources/sidecar-manifest.json'), 'utf8'),
      '{}',
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
        '--node-pins',
        pinsFile(),
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
