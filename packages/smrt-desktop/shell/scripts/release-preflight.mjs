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
//                             unmodified and built from a gpg-verified Node pin
//   --target <triple>         with --bundle: the Rust target it must be for
//   --write-overlay <file>    with --bundle: write the Tauri config overlay
//                             (identity from the bundle, never invented)
//
// Node built-ins only. Exit 0 = every check passed, 1 = at least one failed,
// 2 = usage error.

import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';
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
const TRIPLES = new Set([
  'aarch64-apple-darwin',
  'x86_64-apple-darwin',
  'x86_64-unknown-linux-gnu',
  'aarch64-unknown-linux-gnu',
  'x86_64-pc-windows-msvc',
  'aarch64-pc-windows-msvc',
]);
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

/**
 * Verify a `smrt desktop bundle` output and return the Tauri config overlay
 * built from it. `files` is injectable for tests.
 *
 * Returns `{ problems, overlay }`; `overlay` is set only without problems.
 */
export function checkBundle(bundleDir, target, files = {}) {
  const loadJson = files.readJson ?? readJson;
  const hashFile = files.sha256File ?? sha256File;
  const readText = files.readText ?? ((p) => readFileSync(p, 'utf8'));
  const problems = [];
  const fail = (message) => {
    problems.push(message);
  };

  if (!TRIPLES.has(target)) {
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

  const pin = report?.node?.pin;
  if (
    pin?.verification !== 'gpg-verified' ||
    !Array.isArray(pin.signerFingerprints) ||
    pin.signerFingerprints.length === 0
  ) {
    fail(
      'the bundle was not built from a gpg-verified Node pin (run the bundler with --require-verified-pins)',
    );
  }
  if (report?.target !== target) {
    fail('the bundle was built for a different target');
  }

  const product = report?.product ?? {};
  const bundleId = product.bundleId;
  const displayName = product.displayName;
  const version = product.productVersion;
  if (
    isPlaceholder(bundleId) ||
    typeof bundleId !== 'string' ||
    !BUNDLE_ID.test(bundleId)
  ) {
    fail('the product bundle id is missing, invalid or a placeholder');
  }
  if (isPlaceholder(displayName)) {
    fail('the product display name is missing or a placeholder');
  }
  if (!isNonEmptyString(version)) {
    fail('the product version is missing');
  }

  const bundle = tauriBundle?.bundle;
  const external = bundle?.externalBin;
  if (
    !Array.isArray(external) ||
    external.length !== 1 ||
    typeof external[0] !== 'string' ||
    !external[0].startsWith('binaries/') ||
    !safeRelativePath(external[0]) ||
    bundle?.resources?.['resources/'] !== './'
  ) {
    fail('tauri.bundle.json does not carry the expected externalBin/resources');
  }

  const seen = new Set();
  for (const line of list.split('\n')) {
    if (line === '') continue;
    const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
    if (
      !match ||
      !safeRelativePath(match[2]) ||
      !/^(binaries|resources)\//.test(match[2])
    ) {
      fail('bundle-files.sha256 has a malformed or unsafe line');
      break;
    }
    seen.add(match[2]);
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
  }
  if (seen.size === 0) fail('bundle-files.sha256 lists no files');
  const sidecar = Array.isArray(external) ? external[0] : undefined;
  if (
    typeof sidecar === 'string' &&
    ![...seen].some((path) => path.startsWith(`${sidecar}-${target}`))
  ) {
    fail('the sidecar binary for the target is not in bundle-files.sha256');
  }

  if (problems.length > 0) return { problems };
  return {
    problems,
    overlay: {
      productName: displayName,
      identifier: bundleId,
      version,
      bundle: {
        ...bundle,
        createUpdaterArtifacts: true,
      },
    },
  };
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
  if (options.bundle && !options.target) {
    out('release preflight: usage error: --bundle needs --target\n');
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
  if (options.bundle) {
    const result = checkBundle(options.bundle, options.target);
    problems.push(...result.problems);
    overlay = result.overlay;
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
    if (!overlay) {
      out('release preflight: --write-overlay needs --bundle\n');
      return 2;
    }
    writeFileSync(
      options.writeOverlay,
      `${JSON.stringify(overlay, null, 2)}\n`,
    );
  }
  out('release preflight passed.\n');
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2), process.env);
}
