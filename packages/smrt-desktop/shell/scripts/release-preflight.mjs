#!/usr/bin/env node
// Release preflight for .github/workflows/desktop-release.yml.
//
// Fails closed: the release and signing path may only start when every input
// it needs exists. Nothing is generated, defaulted or guessed here, and no
// value of a secret, key or certificate is ever read into a message: problems
// name the missing input only.
//
// Usage (each flag turns on one group of checks; at least one is required):
//   --secrets                 signing and updater secrets are in the environment
//   --config <tauri.conf>     the committed config carries a real updater key
//   --inputs <dir> <bridge>   the product inputs are safe repo-relative paths
//   --bundle <dir>            a `smrt desktop bundle` output that is complete,
//                             unmodified, has no file the digest list does not
//                             name, no symlink, and whose Node pin matches the
//                             COMMITTED pin record (see --node-pins)
//   --target <triple>         with --bundle: the Rust target it must be for
//   --node-pins <node-pins.ts>  with --bundle: the committed pin table of the
//                             TRUSTED checkout. The bundle's own report is only
//                             compared against it, never believed
//   --write-overlay <file>    with --bundle: write the Tauri config overlay
//                             (built from an allowlist, never copied)
//   --stage <dir>             with --bundle: copy exactly the verified files
//                             into <dir>/binaries and <dir>/resources
//
// Node built-ins only. Exit 0 = every check passed, 1 = at least one failed,
// 2 = usage error.

import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Names of the secrets the signing and notarization path needs. */
export const REQUIRED_SECRETS = Object.freeze([
  'APPLE_CERTIFICATE',
  'APPLE_CERTIFICATE_PASSWORD',
  'APPLE_SIGNING_IDENTITY',
  'APPLE_ID',
  'APPLE_PASSWORD',
  'APPLE_TEAM_ID',
  'TAURI_SIGNING_PRIVATE_KEY',
  'TAURI_SIGNING_PRIVATE_KEY_PASSWORD',
]);

const PLACEHOLDER = /placeholder|changeme|replace-?me|example/i;
const BUNDLE_ID = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
const MAX_JSON_BYTES = 8 * 1024 * 1024;

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function isPlaceholder(value) {
  if (!isNonEmptyString(value)) return true;
  const text = value.trim();
  return PLACEHOLDER.test(text) || text.toLowerCase().endsWith('.invalid');
}

/** Secrets that are absent or empty. Reads presence only, never echoes. */
export function checkSecrets(env) {
  return REQUIRED_SECRETS.filter((name) => !isNonEmptyString(env[name])).map(
    (name) => `missing secret ${name}`,
  );
}

/**
 * The committed config must carry a real updater public key. A Tauri updater
 * key is the base64 of a two-line minisign public key file:
 * `untrusted comment: ...` then 56 base64 characters starting `RW`.
 */
export function checkUpdaterPubkey(config) {
  const key = config?.plugins?.updater?.pubkey;
  if (!isNonEmptyString(key)) {
    return ['the Tauri config has no plugins.updater.pubkey'];
  }
  const bad = ['plugins.updater.pubkey is a placeholder or not a minisign key'];
  const compact = key.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact) || compact.length % 4 !== 0) {
    return bad;
  }
  const lines = Buffer.from(compact, 'base64')
    .toString('utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const [comment, payload] = lines;
  if (
    lines.length !== 2 ||
    !comment.startsWith('untrusted comment:') ||
    !/^RW[A-Za-z0-9+/]{54}$/.test(payload)
  ) {
    return bad;
  }
  return [];
}

function safeRelativePath(value) {
  if (!isNonEmptyString(value)) return false;
  if (value.includes('\\') || value.includes('\0') || value.startsWith('/')) {
    return false;
  }
  if (/^[A-Za-z]:/.test(value)) return false;
  return posix
    .normalize(value)
    .split('/')
    .every((segment) => segment !== '..');
}

/** The product inputs of a dispatch must be safe repo-relative paths. */
export function checkProductInputs(productDir, bridge) {
  const problems = [];
  if (!isNonEmptyString(productDir)) {
    problems.push('input product_dir is empty');
  } else if (!safeRelativePath(productDir)) {
    problems.push('input product_dir is not a safe repo-relative path');
  }
  if (!isNonEmptyString(bridge)) {
    problems.push('input bridge_path is empty');
  } else if (!safeRelativePath(bridge)) {
    problems.push('input bridge_path is not a safe repo-relative path');
  }
  return problems;
}

function readJson(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > MAX_JSON_BYTES) {
    throw new Error('not a regular file of a sane size');
  }
  return JSON.parse(readFileSync(path, 'utf8'));
}

function sha256File(path) {
  const stat = lstatSync(path);
  if (!stat.isFile()) throw new Error('not a regular file');
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SEMVER =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const NODE_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const SHA256 = /^[0-9a-f]{64}$/;
const FINGERPRINT = /^[0-9A-F]{40}$/;
// A display name becomes the product name, and with it installer and .app
// file names: no control characters and no path or shell-significant ones.
const DISPLAY_NAME = /^[^\p{Cc}\p{Zl}\p{Zp}/\\:*?"<>|]{1,128}$/u;
const MAX_TREE_ENTRIES = 100_000;

/**
 * How nodejs.org distributes Node per target, mirroring `TARGETS` in
 * `packages/smrt-desktop/src/bundler/targets.ts`: the file name as it appears
 * in the pin table, and the suffix of the Tauri sidecar file.
 */
const NODE_DIST = Object.freeze({
  'aarch64-apple-darwin': { dir: 'darwin-arm64', exe: false },
  'x86_64-apple-darwin': { dir: 'darwin-x64', exe: false },
  'x86_64-unknown-linux-gnu': { dir: 'linux-x64', exe: false },
  'aarch64-unknown-linux-gnu': { dir: 'linux-arm64', exe: false },
  'x86_64-pc-windows-msvc': { dir: 'win-x64', exe: true },
  'aarch64-pc-windows-msvc': { dir: 'win-arm64', exe: true },
});

/**
 * The dist file name the committed pin table uses for this target and Node
 * version, and the sidecar suffix. Own-property lookup only.
 */
function nodeDistFor(target, version) {
  if (!Object.hasOwn(NODE_DIST, target)) return undefined;
  const { dir, exe } = NODE_DIST[target];
  return {
    distFile: exe ? `${dir}/node.exe` : `node-v${version}-${dir}.tar.gz`,
    exeSuffix: exe ? '.exe' : '',
    // A bare node.exe is pinned itself, so for it the pin IS the binary digest.
    pinnedIsBinary: exe,
  };
}

/** Convert the generated TypeScript object literal to JSON and parse it. */
function parseGeneratedLiteral(block, name) {
  const match = new RegExp(
    `^const ${name}: [A-Za-z]+ = (\\{[\\s\\S]*?\\n\\});$`,
    'm',
  ).exec(block);
  if (!match) throw new Error(`${name} is not in the generated block`);
  const json = match[1]
    .replace(/^(\s*)([A-Za-z_][A-Za-z0-9_]*):/gm, '$1"$2":')
    .replace(/'([^'"\\\n]*)'/g, '"$1"')
    .replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(json);
}

/**
 * Read the committed Node pin table and its provenance out of
 * `packages/smrt-desktop/src/bundler/node-pins.ts` WITHOUT executing it. The
 * file is taken from the trusted checkout; the generated block is plain data
 * (`scripts/update-node-pins.mjs` writes it), so a small strict parser is
 * enough and anything unexpected throws.
 */
export function parseNodePins(source) {
  const block =
    /\/\/ BEGIN GENERATED PINS[^\n]*\n([\s\S]*?)\n\/\/ END GENERATED PINS/.exec(
      source,
    );
  if (!block) throw new Error('no generated pin block');
  const pins = parseGeneratedLiteral(block[1], 'NODE_PINS_DATA');
  const provenance = parseGeneratedLiteral(
    block[1],
    'NODE_PIN_PROVENANCE_DATA',
  );
  for (const [version, files] of Object.entries(pins)) {
    if (
      !NODE_VERSION.test(version) ||
      files === null ||
      typeof files !== 'object'
    ) {
      throw new Error('malformed pin table');
    }
    for (const digest of Object.values(files)) {
      if (!SHA256.test(digest)) throw new Error('malformed pin table');
    }
  }
  return { pins, provenance };
}

/** True when the COMMITTED record says the release's pins are gpg-verified. */
function committedGpgVerified(trust, version) {
  const record = Object.hasOwn(trust.provenance ?? {}, version)
    ? trust.provenance[version]
    : undefined;
  return (
    record?.verification === 'gpg-verified' &&
    Array.isArray(record.signerFingerprints) &&
    record.signerFingerprints.length > 0 &&
    record.signerFingerprints.every((fp) => FINGERPRINT.test(fp)) &&
    SHA256.test(record.shasumsSha256)
  );
}

/** True for a display name that is safe to become a product/file name. */
export function isSafeDisplayName(value) {
  return (
    typeof value === 'string' &&
    !isPlaceholder(value) &&
    DISPLAY_NAME.test(value) &&
    value === value.trim() &&
    !value.startsWith('.')
  );
}

/** True for a Semantic Version 2.0.0 string of sane length. */
export function isSemver(value) {
  return typeof value === 'string' && value.length <= 128 && SEMVER.test(value);
}

function hasExactKeys(value, keys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const own = Reflect.ownKeys(value);
  return own.length === keys.length && keys.every((key) => own.includes(key));
}

/**
 * Every regular file under `<bundleDir>/<root>` as a `/` relative path, found
 * with lstat so a symlink is never followed. Anything that is not a regular
 * file or a directory (symlink, fifo, socket, device) is a problem; names of
 * offending entries are never echoed.
 */
function walkTree(bundleDir, root, problems) {
  const found = [];
  let entries = 0;
  const visit = (relative) => {
    const dir = join(bundleDir, ...relative.split('/'));
    for (const name of readdirSync(dir)) {
      if (++entries > MAX_TREE_ENTRIES) {
        throw new Error('too many entries');
      }
      const path = `${relative}/${name}`;
      const stat = lstatSync(join(dir, name));
      if (stat.isDirectory()) visit(path);
      else if (stat.isFile()) found.push(path);
      else problems.add(`${root}/ holds a symlink or other non-regular file`);
    }
  };
  const top = lstatSync(join(bundleDir, root));
  if (!top.isDirectory()) throw new Error('not a directory');
  visit(root);
  return found;
}

/**
 * Verify a `smrt desktop bundle` output and return the Tauri config overlay
 * built from it. `files` is injectable for tests. `trust` carries the pin
 * record of the TRUSTED checkout (`parseNodePins`); without it nothing is
 * accepted.
 *
 * The bundle is the output of a job that runs product dependency code, so
 * nothing in it is believed: the Tauri fragment must match a closed schema and
 * is rebuilt from an allowlist, every file on disk must be listed with its
 * digest (and every listed file must exist), and the Node pin is compared
 * with the committed record rather than with the report's own claim.
 *
 * Returns `{ problems, overlay, verified }`; the last two are set only
 * without problems. `verified` lists the `{ path, sha256 }` of every file.
 */
export function checkBundle(bundleDir, target, files = {}, trust = {}) {
  const loadJson = files.readJson ?? readJson;
  const hashFile = files.sha256File ?? sha256File;
  const readText = files.readText ?? ((p) => readFileSync(p, 'utf8'));
  const problems = [];
  const fail = (message) => {
    problems.push(message);
  };

  if (!Object.hasOwn(NODE_DIST, target)) {
    fail('the expected target is not a supported Rust triple');
  }

  let report;
  let tauriBundle;
  let list;
  try {
    report = loadJson(join(bundleDir, 'bundle-report.json'));
    tauriBundle = loadJson(join(bundleDir, 'tauri.bundle.json'));
    list = readText(join(bundleDir, 'bundle-files.sha256'));
  } catch {
    return {
      problems: [
        ...problems,
        'the bundle is incomplete or unreadable (bundle-report.json, tauri.bundle.json and bundle-files.sha256 are required)',
      ],
    };
  }

  if (report?.target !== target) {
    fail('the bundle was built for a different target');
  }

  const product = report?.product ?? {};
  const { productId, bundleId, displayName } = product;
  const version = product.productVersion;
  if (!SLUG.test(productId ?? '') || productId.length > 64) {
    fail('the product id is missing or not a slug');
  }
  if (
    isPlaceholder(bundleId) ||
    typeof bundleId !== 'string' ||
    !BUNDLE_ID.test(bundleId)
  ) {
    fail('the product bundle id is missing, invalid or a placeholder');
  }
  if (!isSafeDisplayName(displayName)) {
    fail('the product display name is missing, unsafe or a placeholder');
  }
  if (!isSemver(version)) {
    fail('the product version is missing or not a semantic version');
  }

  // tauri.bundle.json is closed: exactly the one sidecar and the resources
  // directory the bundler writes. Any other key (signCommand, an NSIS
  // template, extra files, entitlements, ...) would reach the secret-holding
  // build, so it is refused rather than filtered.
  const sidecarName = `binaries/${productId}-node`;
  const external = tauriBundle?.bundle?.externalBin;
  if (
    !hasExactKeys(tauriBundle, ['bundle']) ||
    !hasExactKeys(tauriBundle.bundle, ['externalBin', 'resources']) ||
    !hasExactKeys(tauriBundle.bundle.resources, ['resources/']) ||
    tauriBundle.bundle.resources['resources/'] !== './' ||
    !Array.isArray(external) ||
    external.length !== 1 ||
    external[0] !== sidecarName
  ) {
    fail(
      'tauri.bundle.json is not exactly the expected externalBin and resources and nothing else',
    );
  }

  // Digest list: well formed, no duplicates, every digest right.
  const listed = new Map();
  for (const line of list.split('\n')) {
    if (line === '') continue;
    const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
    if (
      !match ||
      !safeRelativePath(match[2]) ||
      !/^(binaries|resources)\//.test(match[2]) ||
      listed.has(match[2])
    ) {
      fail('bundle-files.sha256 has a malformed, duplicate or unsafe line');
      break;
    }
    let digest;
    try {
      digest = hashFile(join(bundleDir, ...match[2].split('/')));
    } catch {
      fail('a file listed in bundle-files.sha256 is missing or not regular');
      break;
    }
    if (digest !== match[1]) {
      fail('a file differs from its digest in bundle-files.sha256');
      break;
    }
    listed.set(match[2], match[1]);
  }
  if (listed.size === 0) fail('bundle-files.sha256 lists no files');

  // The converse: nothing on disk that the list does not name. A file added
  // after the fact, or a symlink Tauri would follow into the signed bundle,
  // is refused. The bundle root itself is never copied beyond listed files.
  const tree = new Set();
  const treeProblems = new Set();
  try {
    for (const root of ['binaries', 'resources']) {
      for (const path of walkTree(bundleDir, root, treeProblems))
        tree.add(path);
    }
  } catch {
    fail('binaries/ or resources/ is missing or cannot be listed');
  }
  for (const message of treeProblems) fail(message);
  if (
    tree.size > 0 &&
    ([...tree].some((path) => !listed.has(path)) ||
      [...listed.keys()].some((path) => !tree.has(path)))
  ) {
    fail('the files on disk are not exactly the files in bundle-files.sha256');
  }

  // The Node sidecar: compared with the COMMITTED pin record, not the report.
  const node = report?.node;
  const nodeVersion = node?.version;
  const dist =
    typeof nodeVersion === 'string' && NODE_VERSION.test(nodeVersion)
      ? nodeDistFor(target, nodeVersion)
      : undefined;
  const sidecarFile = dist
    ? `${sidecarName}-${target}${dist.exeSuffix}`
    : undefined;
  if (!trust.nodePins) {
    fail('no committed Node pin record was supplied to compare against');
  } else if (!dist) {
    fail('the bundle names no usable Node version for this target');
  } else {
    const committed = Object.hasOwn(trust.nodePins.pins ?? {}, nodeVersion)
      ? trust.nodePins.pins[nodeVersion]
      : undefined;
    const pinned =
      committed && Object.hasOwn(committed, dist.distFile)
        ? committed[dist.distFile]
        : undefined;
    if (!pinned) {
      fail('the Node version or file is not in the committed pin table');
    } else {
      if (node.distFile !== dist.distFile || node.archiveSha256 !== pinned) {
        fail('the bundle Node archive digest is not the committed pin');
      }
      if (!committedGpgVerified(trust.nodePins, nodeVersion)) {
        fail(
          'the committed pin record for this Node version is not gpg-verified',
        );
      }
      const sidecarDigest = listed.get(sidecarFile);
      if (sidecarDigest === undefined) {
        fail('the sidecar binary for the target is not in bundle-files.sha256');
      } else if (node.binarySha256 !== sidecarDigest) {
        fail('the sidecar digest is not the digest the report records');
      } else if (dist.pinnedIsBinary && sidecarDigest !== pinned) {
        fail('the sidecar is not the pinned node.exe');
      }
    }
  }
  // The report's own claim stays a necessary (not sufficient) condition.
  const reported = node?.pin;
  if (
    reported?.verification !== 'gpg-verified' ||
    !Array.isArray(reported.signerFingerprints) ||
    reported.signerFingerprints.length === 0
  ) {
    fail(
      'the bundle was not built from a gpg-verified Node pin (run the bundler with --require-verified-pins)',
    );
  }

  if (problems.length > 0) return { problems };
  return {
    problems,
    verified: [...listed].map(([path, sha256]) => ({ path, sha256 })),
    overlay: {
      productName: displayName,
      identifier: bundleId,
      version,
      bundle: {
        externalBin: [sidecarName],
        resources: { 'resources/': './' },
        createUpdaterArtifacts: true,
      },
    },
  };
}

/**
 * Copy exactly the verified files into `<destDir>/binaries` and
 * `<destDir>/resources`. Each file is read once, hashed again and written with
 * `wx` (never over an existing path or through a symlink), so nothing that was
 * not verified, and nothing that changed since, reaches the build.
 */
export function stageBundle(bundleDir, verified, destDir) {
  for (const { path, sha256 } of verified) {
    const from = join(bundleDir, ...path.split('/'));
    const stat = lstatSync(from);
    if (!stat.isFile()) throw new Error('not a regular file');
    const bytes = readFileSync(from);
    if (createHash('sha256').update(bytes).digest('hex') !== sha256) {
      throw new Error('a file changed while being staged');
    }
    const to = join(destDir, ...path.split('/'));
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, bytes, {
      flag: 'wx',
      mode: stat.mode & 0o111 ? 0o755 : 0o644,
    });
  }
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${arg} needs a value`);
      return next;
    };
    switch (arg) {
      case '--secrets':
        options.secrets = true;
        break;
      case '--config':
        options.config = value();
        break;
      case '--inputs':
        options.productDir = value();
        options.bridge = value();
        break;
      case '--bundle':
        options.bundle = value();
        break;
      case '--target':
        options.target = value();
        break;
      case '--write-overlay':
        options.writeOverlay = value();
        break;
      case '--node-pins':
        options.nodePins = value();
        break;
      case '--stage':
        options.stage = value();
        break;
      default:
        throw new Error(`unknown option ${arg}`);
    }
  }
  return options;
}

/** Run the selected checks. Returns the process exit code. */
export function main(argv, env, io = {}) {
  const out = io.stderr ?? ((text) => process.stderr.write(text));
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    out(`release preflight: usage error: ${error.message}\n`);
    return 2;
  }
  if (
    !(
      options.secrets ||
      options.config ||
      options.productDir !== undefined ||
      options.bundle
    )
  ) {
    out('release preflight: usage error: no check selected\n');
    return 2;
  }
  if (options.bundle && (!options.target || !options.nodePins)) {
    out(
      'release preflight: usage error: --bundle needs --target and --node-pins\n',
    );
    return 2;
  }
  if ((options.writeOverlay || options.stage) && !options.bundle) {
    out(
      'release preflight: usage error: --write-overlay and --stage need --bundle\n',
    );
    return 2;
  }

  const problems = [];
  if (options.secrets) problems.push(...checkSecrets(env));
  if (options.config) {
    try {
      problems.push(...checkUpdaterPubkey(readJson(options.config)));
    } catch {
      problems.push('the Tauri config is unreadable or not JSON');
    }
  }
  if (options.productDir !== undefined) {
    problems.push(...checkProductInputs(options.productDir, options.bridge));
  }
  let overlay;
  let verified;
  if (options.bundle) {
    let nodePins;
    try {
      nodePins = parseNodePins(readFileSync(options.nodePins, 'utf8'));
    } catch {
      problems.push('the committed Node pin table is unreadable');
    }
    const result = checkBundle(
      options.bundle,
      options.target,
      {},
      { nodePins },
    );
    problems.push(...result.problems);
    overlay = result.overlay;
    verified = result.verified;
  }

  if (problems.length > 0) {
    out('release preflight FAILED: the signed release path was not started.\n');
    for (const problem of problems) out(`  - ${problem}\n`);
    out(
      'See "Release pipeline" in packages/smrt-desktop/shell/README.md for the owner inputs this needs.\n',
    );
    return 1;
  }
  if (options.writeOverlay) {
    writeFileSync(
      options.writeOverlay,
      `${JSON.stringify(overlay, null, 2)}\n`,
    );
  }
  if (options.stage) {
    try {
      stageBundle(options.bundle, verified, options.stage);
    } catch {
      out(
        'release preflight FAILED: the verified files could not be staged.\n',
      );
      return 1;
    }
  }
  out('release preflight passed.\n');
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2), process.env);
}
