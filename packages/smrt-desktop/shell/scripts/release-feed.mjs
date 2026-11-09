#!/usr/bin/env node
// Release assets and the updater feed for .github/workflows/desktop-release.yml.
//
// Nothing is published by the build legs. Each leg stages its own signed
// output with `leg`; the publish job, after every leg built and verified,
// assembles one consistent set with `feed`. A leg that failed leaves no feed.
//
//   leg  --target <triple> --bundle-dir <tauri bundle dir> --overlay <json>
//        --pubkey-config <tauri.conf.json> --out <dir>
//        Finds exactly the expected installer (and updater archive with its
//        signature) for the target, verifies the signature against the
//        COMMITTED updater public key, copies them under safe, unique names
//        and writes <dir>/leg.json.
//   feed --legs <dir> --targets <t1,t2,...> --repo <owner/name> --tag <tag>
//        --pubkey-config <tauri.conf.json> --out <dir> [--date <RFC 3339>]
//        Reads <legs>/desktop-release-<target>/leg.json for every target,
//        refuses anything missing or inconsistent, verifies every updater
//        signature again against the committed public key, and writes
//        <out>/assets/* and <out>/latest.json.
//
// The updater signature (minisign) is produced by `tauri signer sign` in the
// signing leg. Both commands verify it with minisign.mjs against the public key
// committed in tauri.conf.json (plugins.updater.pubkey), so a signature that
// does not verify, or a private key that is not the pair of the committed
// public key, stops the leg and the publish. Node built-ins only. Exit 0 ok,
// 1 refused, 2 usage.

import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { verifyUpdaterSignature } from './minisign.mjs';
import { isSafeDisplayName, isSemver } from './release-preflight.mjs';

/**
 * Per target: the Tauri bundle sub-directories and file suffixes to expect,
 * and the updater platform keys. Linux ships a .deb only (AppImage is not
 * built in v1) and the updater cannot update a .deb, so it has no feed entry.
 */
const TARGETS = Object.freeze({
  'aarch64-apple-darwin': {
    installer: { dir: 'dmg', suffix: '.dmg' },
    updater: { dir: 'macos', suffix: '.app.tar.gz' },
    platforms: ['darwin-aarch64', 'darwin-aarch64-app'],
  },
  'x86_64-apple-darwin': {
    installer: { dir: 'dmg', suffix: '.dmg' },
    updater: { dir: 'macos', suffix: '.app.tar.gz' },
    platforms: ['darwin-x86_64', 'darwin-x86_64-app'],
  },
  'x86_64-pc-windows-msvc': {
    installer: { dir: 'nsis', suffix: '-setup.exe' },
    updater: { dir: 'nsis', suffix: '-setup.exe' },
    platforms: ['windows-x86_64', 'windows-x86_64-nsis'],
  },
  'x86_64-unknown-linux-gnu': {
    installer: { dir: 'deb', suffix: '.deb' },
    platforms: [],
  },
});

const ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/;
const OWNER_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const TAG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/;
const SIGNATURE = /^[A-Za-z0-9+/=]{16,8192}$/;
const MAX_JSON_BYTES = 1024 * 1024;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function regularFile(path) {
  const stat = lstatSync(path);
  if (!stat.isFile()) throw new Error('not a regular file');
  return stat;
}

/** The one regular file in `dir` whose name ends with `suffix`, or throw. */
function onlyFile(dir, suffix, exclude = '') {
  const names = readdirSync(dir).filter(
    (name) =>
      name.endsWith(suffix) && (exclude === '' || !name.endsWith(exclude)),
  );
  if (names.length !== 1) throw new Error(`expected exactly one *${suffix}`);
  regularFile(join(dir, names[0]));
  return join(dir, names[0]);
}

/** `<product>_<version>_<target><suffix>` with only safe characters. */
function assetName(productName, version, target, suffix) {
  const product = productName
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return `${product || 'app'}_${version}_${target}${suffix}`;
}

/** Stage one leg. Returns the leg descriptor it wrote. */
export function stageLeg({ target, bundleDir, overlay, outDir, pubkey }) {
  if (!Object.hasOwn(TARGETS, target)) throw new Error('unsupported target');
  if (typeof pubkey !== 'string' || pubkey === '') {
    throw new Error('no committed updater public key to verify against');
  }
  const spec = TARGETS[target];
  const { productName, version } = overlay;
  if (!isSafeDisplayName(productName) || !isSemver(version)) {
    throw new Error('the config overlay has no safe product name and version');
  }
  mkdirSync(outDir, { recursive: true });
  const assets = [];
  const put = (from, suffix) => {
    const name = assetName(productName, version, target, suffix);
    if (!ASSET_NAME.test(name)) throw new Error('unsafe asset name');
    copyFileSync(from, join(outDir, name));
    assets.push(name);
    return name;
  };

  const leg = { target, version, productName, assets };
  put(
    onlyFile(
      join(bundleDir, spec.installer.dir),
      spec.installer.suffix,
      '.sig',
    ),
    spec.installer.suffix,
  );
  if (spec.updater) {
    const dir = join(bundleDir, spec.updater.dir);
    // On Windows the installer IS the updater artifact; staged once.
    const archive = onlyFile(dir, spec.updater.suffix, '.sig');
    const signature = readFileSync(
      onlyFile(dir, `${spec.updater.suffix}.sig`),
      'utf8',
    ).trim();
    if (!SIGNATURE.test(signature)) throw new Error('no usable signature');
    verifyUpdaterSignature({ pubkey, signature, file: archive });
    const name = assetName(productName, version, target, spec.updater.suffix);
    if (!assets.includes(name)) put(archive, spec.updater.suffix);
    put(`${archive}.sig`, `${spec.updater.suffix}.sig`);
    leg.updater = { asset: name, signature };
  }
  writeFileSync(join(outDir, 'leg.json'), `${JSON.stringify(leg, null, 2)}\n`);
  return leg;
}

function readLeg(legsDir, target) {
  const dir = join(legsDir, `desktop-release-${target}`);
  const file = join(dir, 'leg.json');
  if (regularFile(file).size > MAX_JSON_BYTES) throw new Error('too large');
  const leg = JSON.parse(readFileSync(file, 'utf8'));
  const spec = TARGETS[target];
  if (
    !isPlainObject(leg) ||
    leg.target !== target ||
    !isSafeDisplayName(leg.productName) ||
    !isSemver(leg.version) ||
    !Array.isArray(leg.assets) ||
    leg.assets.length === 0 ||
    !leg.assets.every(
      (name) => typeof name === 'string' && ASSET_NAME.test(name),
    )
  ) {
    throw new Error(`the ${target} leg descriptor is invalid`);
  }
  for (const name of leg.assets) regularFile(join(dir, name));
  if (spec.updater) {
    if (
      !isPlainObject(leg.updater) ||
      !leg.assets.includes(leg.updater.asset) ||
      !leg.assets.includes(`${leg.updater.asset}.sig`) ||
      typeof leg.updater.signature !== 'string' ||
      !SIGNATURE.test(leg.updater.signature)
    ) {
      throw new Error(`the ${target} leg has no updater archive and signature`);
    }
  } else if (leg.updater !== undefined) {
    throw new Error(`the ${target} leg must not carry an updater entry`);
  }
  return { leg, dir };
}

/**
 * Assemble the release set. Refuses unless every expected target produced a
 * complete leg and all legs agree on the version.
 */
export function assembleFeed({
  legsDir,
  targets,
  repo,
  tag,
  outDir,
  date,
  pubkey,
}) {
  if (!OWNER_REPO.test(repo) || !TAG.test(tag)) {
    throw new Error('repo or tag is not a plain name');
  }
  if (typeof pubkey !== 'string' || pubkey === '') {
    throw new Error('no committed updater public key to verify against');
  }
  if (
    targets.length === 0 ||
    new Set(targets).size !== targets.length ||
    !targets.every((target) => Object.hasOwn(TARGETS, target))
  ) {
    throw new Error('the expected targets are empty, repeated or unsupported');
  }
  const legs = targets.map((target) => readLeg(legsDir, target));
  const { version } = legs[0].leg;
  if (legs.some(({ leg }) => leg.version !== version)) {
    throw new Error('the legs disagree on the version');
  }
  const { productName } = legs[0].leg;
  if (legs.some(({ leg }) => leg.productName !== productName)) {
    throw new Error('the legs disagree on the product name');
  }
  // Before anything is copied or written: every updater signature must verify
  // against the committed public key, and the .sig asset that will be
  // uploaded must be the very signature the feed carries.
  for (const { leg, dir } of legs) {
    if (!leg.updater) continue;
    try {
      verifyUpdaterSignature({
        pubkey,
        signature: leg.updater.signature,
        file: join(dir, leg.updater.asset),
      });
      const sigAsset = readFileSync(
        join(dir, `${leg.updater.asset}.sig`),
        'utf8',
      ).trim();
      if (sigAsset !== leg.updater.signature) {
        throw new Error('the .sig asset is not the signature in the descriptor');
      }
    } catch (error) {
      throw new Error(`the ${leg.target} updater signature: ${error.message}`);
    }
  }
  const assetsDir = join(outDir, 'assets');
  mkdirSync(assetsDir, { recursive: true });
  const seen = new Set();
  const platforms = {};
  for (const { leg, dir } of legs) {
    for (const name of leg.assets) {
      if (seen.has(name)) throw new Error('two legs produced the same asset');
      seen.add(name);
      copyFileSync(join(dir, name), join(assetsDir, name));
    }
    if (leg.updater) {
      const entry = {
        signature: leg.updater.signature,
        url: `https://github.com/${repo}/releases/download/${tag}/${leg.updater.asset}`,
      };
      for (const key of TARGETS[leg.target].platforms) platforms[key] = entry;
    }
  }
  const feed = {
    version,
    notes: 'Rolling desktop build.',
    pub_date: date ?? new Date().toISOString(),
    platforms,
  };
  writeFileSync(
    join(outDir, 'latest.json'),
    `${JSON.stringify(feed, null, 2)}\n`,
  );
  return feed;
}

/** The committed `plugins.updater.pubkey`; a missing option is a refusal. */
function committedPubkey(configPath) {
  if (configPath === undefined) {
    throw new Error('--pubkey-config is required (the committed Tauri config)');
  }
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  return config?.plugins?.updater?.pubkey;
}

function parseOptions(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key?.startsWith('--') || value === undefined) {
      throw new Error(`bad option ${key}`);
    }
    options[key.slice(2)] = value;
  }
  return options;
}

export function main(argv, io = {}) {
  const out = io.stderr ?? ((text) => process.stderr.write(text));
  const [command, ...rest] = argv;
  let options;
  try {
    options = parseOptions(rest);
  } catch (error) {
    out(`release feed: usage error: ${error.message}\n`);
    return 2;
  }
  const need = (...names) => names.every((name) => options[name] !== undefined);
  try {
    if (
      command === 'leg' &&
      need('target', 'bundle-dir', 'overlay', 'out', 'pubkey-config')
    ) {
      const overlay = JSON.parse(readFileSync(options.overlay, 'utf8'));
      stageLeg({
        target: options.target,
        bundleDir: options['bundle-dir'],
        overlay,
        outDir: options.out,
        pubkey: committedPubkey(options['pubkey-config']),
      });
    } else if (
      command === 'feed' &&
      need('legs', 'targets', 'repo', 'tag', 'out', 'pubkey-config')
    ) {
      assembleFeed({
        legsDir: options.legs,
        targets: options.targets.split(','),
        repo: options.repo,
        tag: options.tag,
        outDir: options.out,
        date: options.date,
        pubkey: committedPubkey(options['pubkey-config']),
      });
    } else {
      out('release feed: usage error: unknown command or missing option\n');
      return 2;
    }
  } catch (error) {
    out(`release feed FAILED: ${error.message}\n`);
    return 1;
  }
  out('release feed ok.\n');
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
