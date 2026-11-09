// Run with: node --test scripts/release-feed.test.mjs
// Signatures and installers below are throwaway strings built in this file.

import assert from 'node:assert/strict';
import {
  existsSync,
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

import { makeKey, signBytes } from './minisign-fixture.mjs';
import { assembleFeed, main, stageLeg } from './release-feed.mjs';

const ALL = [
  'aarch64-apple-darwin',
  'x86_64-apple-darwin',
  'x86_64-pc-windows-msvc',
  'x86_64-unknown-linux-gnu',
];
// A throwaway key pair generated for this run: the "committed" public key and
// the key the fake signing step signs with.
const KEY = makeKey();
const OTHER_KEY = makeKey();
const SIG = signBytes(KEY, 'tar');
const WIN_SIG = signBytes(KEY, 'exe');
const OVERLAY = { productName: 'Acme Notes', version: '1.2.3' };

const dirs = [];
const tmp = (prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
});

const put = (root, path, text) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
};

/** A fake `target/<triple>/release/bundle` for one target. */
function fakeBundle(target, key = KEY) {
  const dir = tmp('bundle-');
  if (target.includes('apple')) {
    put(dir, 'dmg/Acme Notes_1.2.3_aarch64.dmg', 'dmg');
    put(dir, 'macos/Acme Notes.app.tar.gz', 'tar');
    put(dir, 'macos/Acme Notes.app.tar.gz.sig', `${signBytes(key, 'tar')}\n`);
  } else if (target.includes('windows')) {
    put(dir, 'nsis/Acme Notes_1.2.3_x64-setup.exe', 'exe');
    put(dir, 'nsis/Acme Notes_1.2.3_x64-setup.exe.sig', signBytes(key, 'exe'));
  } else {
    put(dir, 'deb/Acme Notes_1.2.3_amd64.deb', 'deb');
  }
  return dir;
}

function stagedLegs(targets = ALL, overlay = OVERLAY, key = KEY) {
  const legs = tmp('legs-');
  for (const target of targets) {
    stageLeg({
      target,
      bundleDir: fakeBundle(target, key),
      overlay,
      pubkey: KEY.pubkey,
      outDir: join(legs, `desktop-release-${target}`),
    });
  }
  return legs;
}

const feed = (legs, extra = {}) =>
  assembleFeed({
    legsDir: legs,
    targets: ALL,
    repo: 'happyvertical/smrt',
    tag: 'desktop-latest',
    outDir: tmp('out-'),
    date: '2026-11-09T00:00:00.000Z',
    pubkey: KEY.pubkey,
    ...extra,
  });

describe('stageLeg', () => {
  it('stages the installer, updater archive and signature under safe names', () => {
    const out = tmp('leg-');
    const leg = stageLeg({
      target: 'aarch64-apple-darwin',
      bundleDir: fakeBundle('aarch64-apple-darwin'),
      overlay: OVERLAY,
      pubkey: KEY.pubkey,
      outDir: out,
    });
    assert.deepEqual(leg.assets.sort(), [
      'Acme-Notes_1.2.3_aarch64-apple-darwin.app.tar.gz',
      'Acme-Notes_1.2.3_aarch64-apple-darwin.app.tar.gz.sig',
      'Acme-Notes_1.2.3_aarch64-apple-darwin.dmg',
    ]);
    assert.equal(leg.updater.signature, SIG);
    assert.ok(existsSync(join(out, 'leg.json')));
  });

  it('stages a Windows installer once and a Linux deb without an updater', () => {
    const win = stageLeg({
      target: 'x86_64-pc-windows-msvc',
      bundleDir: fakeBundle('x86_64-pc-windows-msvc'),
      overlay: OVERLAY,
      pubkey: KEY.pubkey,
      outDir: tmp('leg-'),
    });
    assert.equal(win.assets.length, 2);
    const linux = stageLeg({
      target: 'x86_64-unknown-linux-gnu',
      bundleDir: fakeBundle('x86_64-unknown-linux-gnu'),
      overlay: OVERLAY,
      pubkey: KEY.pubkey,
      outDir: tmp('leg-'),
    });
    assert.equal(linux.updater, undefined);
  });

  it('refuses a missing signature, a duplicate artifact and a symlink', () => {
    const noSig = fakeBundle('x86_64-pc-windows-msvc');
    rmSync(join(noSig, 'nsis/Acme Notes_1.2.3_x64-setup.exe.sig'));
    assert.throws(() =>
      stageLeg({
        target: 'x86_64-pc-windows-msvc',
        bundleDir: noSig,
        overlay: OVERLAY,
        pubkey: KEY.pubkey,
        outDir: tmp('l-'),
      }),
    );

    const twice = fakeBundle('aarch64-apple-darwin');
    put(twice, 'dmg/Other.dmg', 'x');
    assert.throws(() =>
      stageLeg({
        target: 'aarch64-apple-darwin',
        bundleDir: twice,
        overlay: OVERLAY,
        pubkey: KEY.pubkey,
        outDir: tmp('l-'),
      }),
    );

    const link = fakeBundle('x86_64-unknown-linux-gnu');
    rmSync(join(link, 'deb/Acme Notes_1.2.3_amd64.deb'));
    symlinkSync('/etc/hosts', join(link, 'deb/x.deb'));
    assert.throws(() =>
      stageLeg({
        target: 'x86_64-unknown-linux-gnu',
        bundleDir: link,
        overlay: OVERLAY,
        pubkey: KEY.pubkey,
        outDir: tmp('l-'),
      }),
    );
  });

  it('refuses an unsafe signature, product name or version', () => {
    const bad = fakeBundle('x86_64-pc-windows-msvc');
    put(bad, 'nsis/Acme Notes_1.2.3_x64-setup.exe.sig', 'not base64 !!\n');
    assert.throws(() =>
      stageLeg({
        target: 'x86_64-pc-windows-msvc',
        bundleDir: bad,
        overlay: OVERLAY,
        pubkey: KEY.pubkey,
        outDir: tmp('l-'),
      }),
    );
    for (const overlay of [
      { productName: '../x', version: '1.0.0' },
      { productName: 'A', version: '1' },
    ]) {
      assert.throws(() =>
        stageLeg({
          target: 'aarch64-apple-darwin',
          bundleDir: fakeBundle('aarch64-apple-darwin'),
          overlay,
          pubkey: KEY.pubkey,
          outDir: tmp('l-'),
        }),
      );
    }
  });
});

describe('updater signatures against the committed public key', () => {
  const stage = (target, key, extra = {}) =>
    stageLeg({
      target,
      bundleDir: fakeBundle(target, key),
      overlay: OVERLAY,
      pubkey: KEY.pubkey,
      outDir: tmp('leg-'),
      ...extra,
    });

  it('refuses to stage a leg signed with a key that is not the committed pair', () => {
    assert.throws(
      () => stage('aarch64-apple-darwin', OTHER_KEY),
      /different key id/,
    );
    assert.throws(
      () => stage('x86_64-pc-windows-msvc', OTHER_KEY),
      /different key id/,
    );
  });

  it('refuses a same-key-id signature made with another private key', () => {
    const impostor = makeKey(KEY.keyId);
    assert.throws(
      () => stage('x86_64-pc-windows-msvc', impostor),
      /does not match/,
    );
  });

  it('refuses a signature over other bytes than the archive', () => {
    const bundle = fakeBundle('x86_64-pc-windows-msvc');
    put(bundle, 'nsis/Acme Notes_1.2.3_x64-setup.exe', 'tampered');
    assert.throws(
      () =>
        stageLeg({
          target: 'x86_64-pc-windows-msvc',
          bundleDir: bundle,
          overlay: OVERLAY,
          pubkey: KEY.pubkey,
          outDir: tmp('leg-'),
        }),
      /does not match/,
    );
  });

  it('refuses a missing or placeholder public key', () => {
    for (const pubkey of [undefined, '', 'PLACEHOLDER-NOT-A-KEY']) {
      assert.throws(() => stage('aarch64-apple-darwin', KEY, { pubkey }));
    }
  });

  it('refuses to assemble a feed from a leg signed by another key', () => {
    const legs = stagedLegs();
    // Replace the Windows leg with one signed by a different key pair; it was
    // staged without the pubkey check, as a compromised leg would be.
    const dir = join(legs, 'desktop-release-x86_64-pc-windows-msvc');
    const other = fakeBundle('x86_64-pc-windows-msvc', OTHER_KEY);
    rmSync(dir, { recursive: true });
    stageLeg({
      target: 'x86_64-pc-windows-msvc',
      bundleDir: other,
      overlay: OVERLAY,
      pubkey: OTHER_KEY.pubkey,
      outDir: dir,
    });
    const outDir = tmp('out-');
    assert.throws(() => feed(legs, { outDir }), /windows.*different key id/);
    assert.equal(existsSync(join(outDir, 'latest.json')), false);
    assert.equal(existsSync(join(outDir, 'assets')), false);
  });

  it('refuses a tampered archive after staging', () => {
    const legs = stagedLegs();
    put(
      legs,
      'desktop-release-aarch64-apple-darwin/Acme-Notes_1.2.3_aarch64-apple-darwin.app.tar.gz',
      'tampered',
    );
    assert.throws(() => feed(legs), /aarch64-apple-darwin updater signature/);
  });

  it('refuses a feed signature that differs from the uploaded .sig asset', () => {
    const legs = stagedLegs();
    put(
      legs,
      'desktop-release-aarch64-apple-darwin/Acme-Notes_1.2.3_aarch64-apple-darwin.app.tar.gz.sig',
      signBytes(KEY, 'tar', { trustedComment: 'timestamp:2\tfile:other.bin' }),
    );
    assert.throws(() => feed(legs), /not the signature in the descriptor/);
  });

  it('refuses a feed signature edited in the descriptor', () => {
    const legs = stagedLegs();
    const path = join(legs, 'desktop-release-x86_64-pc-windows-msvc/leg.json');
    const leg = JSON.parse(readFileSync(path, 'utf8'));
    leg.updater.signature = SIG;
    writeFileSync(path, JSON.stringify(leg));
    assert.throws(() => feed(legs), /updater signature/);
  });

  it('refuses a feed without a public key', () => {
    const legs = stagedLegs();
    assert.throws(() => feed(legs, { pubkey: undefined }), /public key/);
    assert.throws(() => feed(legs, { pubkey: 'PLACEHOLDER' }));
  });

  it('refuses legs that disagree on the product name', () => {
    const legs = stagedLegs(ALL.slice(0, 3));
    const dir = join(legs, 'desktop-release-x86_64-unknown-linux-gnu');
    stageLeg({
      target: 'x86_64-unknown-linux-gnu',
      bundleDir: fakeBundle('x86_64-unknown-linux-gnu'),
      overlay: { ...OVERLAY, productName: 'Other Product' },
      pubkey: KEY.pubkey,
      outDir: dir,
    });
    assert.throws(() => feed(legs), /product name/);
  });
});

describe('assembleFeed', () => {
  it('writes one feed that points at every updater archive', () => {
    const outDir = tmp('out-');
    const result = feed(stagedLegs(), { outDir });
    assert.equal(result.version, '1.2.3');
    assert.deepEqual(Object.keys(result.platforms).sort(), [
      'darwin-aarch64',
      'darwin-aarch64-app',
      'darwin-x86_64',
      'darwin-x86_64-app',
      'windows-x86_64',
      'windows-x86_64-nsis',
    ]);
    assert.equal(
      result.platforms['darwin-aarch64'].url,
      'https://github.com/happyvertical/smrt/releases/download/desktop-latest/Acme-Notes_1.2.3_aarch64-apple-darwin.app.tar.gz',
    );
    assert.equal(result.platforms['windows-x86_64'].signature, WIN_SIG);
    assert.deepEqual(
      JSON.parse(readFileSync(join(outDir, 'latest.json'), 'utf8')),
      result,
    );
    assert.ok(
      existsSync(
        join(outDir, 'assets/Acme-Notes_1.2.3_x86_64-unknown-linux-gnu.deb'),
      ),
    );
  });

  it('publishes nothing when one leg is missing', () => {
    const legs = stagedLegs(ALL.slice(0, 3));
    const outDir = tmp('out-');
    assert.throws(() => feed(legs, { outDir }));
    assert.equal(existsSync(join(outDir, 'latest.json')), false);
  });

  it('refuses legs that disagree on the version', () => {
    const legs = stagedLegs(ALL.slice(0, 3));
    stageLeg({
      target: 'x86_64-unknown-linux-gnu',
      bundleDir: fakeBundle('x86_64-unknown-linux-gnu'),
      overlay: { ...OVERLAY, version: '9.9.9' },
      pubkey: KEY.pubkey,
      outDir: join(legs, 'desktop-release-x86_64-unknown-linux-gnu'),
    });
    assert.throws(() => feed(legs), /disagree/);
  });

  it('refuses a descriptor that was edited after staging', () => {
    const legs = stagedLegs();
    const path = join(legs, 'desktop-release-x86_64-pc-windows-msvc/leg.json');
    const leg = JSON.parse(readFileSync(path, 'utf8'));
    leg.assets.push('../../etc/passwd');
    writeFileSync(path, JSON.stringify(leg));
    assert.throws(() => feed(legs));

    const legs2 = stagedLegs();
    const path2 = join(legs2, 'desktop-release-aarch64-apple-darwin/leg.json');
    const leg2 = JSON.parse(readFileSync(path2, 'utf8'));
    delete leg2.updater;
    writeFileSync(path2, JSON.stringify(leg2));
    assert.throws(() => feed(legs2));
  });

  it('refuses an asset that is missing or a symlink', () => {
    const legs = stagedLegs();
    const dir = join(legs, 'desktop-release-x86_64-unknown-linux-gnu');
    const deb = join(dir, 'Acme-Notes_1.2.3_x86_64-unknown-linux-gnu.deb');
    rmSync(deb);
    assert.throws(() => feed(legs));
    symlinkSync('/etc/hosts', deb);
    assert.throws(() => feed(legs));
  });

  it('refuses an unsafe repo, tag, target list or duplicate asset', () => {
    const legs = stagedLegs();
    assert.throws(() => feed(legs, { repo: 'a/b c' }));
    assert.throws(() => feed(legs, { tag: '../x' }));
    assert.throws(() => feed(legs, { targets: [] }));
    assert.throws(() => feed(legs, { targets: ['x', ...ALL] }));
    assert.throws(() => feed(legs, { targets: [ALL[0], ALL[0]] }));
  });
});

describe('main', () => {
  const config = (pubkey) => {
    const dir = tmp('conf-');
    const path = join(dir, 'tauri.conf.json');
    writeFileSync(path, JSON.stringify({ plugins: { updater: { pubkey } } }));
    return path;
  };
  const run = (argv) => {
    let text = '';
    const code = main(argv, { stderr: (t) => (text += t) });
    return { code, text };
  };

  it('is a usage error for an unknown command or missing options', () => {
    assert.equal(run([]).code, 2);
    assert.equal(run(['leg', '--target']).code, 2);
    assert.equal(run(['feed', '--legs', 'x']).code, 2);
  });

  it('needs --pubkey-config and refuses a config that is not the signing pair', () => {
    const legs = stagedLegs();
    const base = [
      'feed',
      '--legs',
      legs,
      '--targets',
      ALL.join(','),
      '--repo',
      'happyvertical/smrt',
      '--tag',
      'desktop-latest',
    ];
    const none = run([...base, '--out', tmp('out-')]);
    assert.equal(none.code, 2); // a usage error: the key is not optional
    assert.match(none.text, /usage error/);
    assert.equal(existsSync(join(tmp('x-'), 'latest.json')), false);
    const wrong = run([
      ...base,
      '--pubkey-config',
      config(OTHER_KEY.pubkey),
      '--out',
      tmp('out-'),
    ]);
    assert.equal(wrong.code, 1);
    assert.match(wrong.text, /different key id/);
    const placeholder = run([
      ...base,
      '--pubkey-config',
      config('PLACEHOLDER-NOT-A-KEY'),
      '--out',
      tmp('out-'),
    ]);
    assert.equal(placeholder.code, 1);
    const outDir = tmp('out-');
    const ok = run([
      ...base,
      '--pubkey-config',
      config(KEY.pubkey),
      '--out',
      outDir,
    ]);
    assert.equal(ok.code, 0);
    assert.ok(existsSync(join(outDir, 'latest.json')));
  });

  it('stages a leg through the CLI only with the committed key pair', () => {
    const overlay = join(tmp('overlay-'), 'overlay.json');
    writeFileSync(overlay, JSON.stringify(OVERLAY));
    const args = (key) => [
      'leg',
      '--target',
      'x86_64-pc-windows-msvc',
      '--bundle-dir',
      fakeBundle('x86_64-pc-windows-msvc', key),
      '--overlay',
      overlay,
      '--pubkey-config',
      config(KEY.pubkey),
      '--out',
      tmp('leg-'),
    ];
    assert.equal(run(args(KEY)).code, 0);
    const bad = run(args(OTHER_KEY));
    assert.equal(bad.code, 1);
    assert.match(bad.text, /different key id/);
  });

  it('exits 1 and writes no feed when a leg is missing', () => {
    const outDir = tmp('out-');
    const { code, text } = run([
      'feed',
      '--legs',
      tmp('empty-'),
      '--targets',
      ALL.join(','),
      '--repo',
      'happyvertical/smrt',
      '--tag',
      'desktop-latest',
      '--pubkey-config',
      config(KEY.pubkey),
      '--out',
      outDir,
    ]);
    assert.equal(code, 1);
    assert.match(text, /FAILED/);
    assert.equal(existsSync(join(outDir, 'latest.json')), false);
  });
});
