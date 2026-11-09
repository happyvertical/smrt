#!/usr/bin/env node
// @ts-check
/**
 * Maintainer script: record the SHA-256 pins, and their provenance, for one
 * Node.js release in `src/bundler/node-pins.ts`.
 *
 * MAINTAINER-ONLY. It needs the network (or local copies of the signed files)
 * and `gpg`. It is NOT run by `npm test`, by CI, or by `smrt desktop bundle`;
 * only the pure parts exported below (`parseShasums`, `selectPins`,
 * `parseGpgStatus`, `renderPinsBlock`, `mergePinsSource`, `download` with an
 * injected fetch) are unit tested, offline (`src/bundler/update-node-pins.test.ts`).
 *
 * Why a script and committed pins (no GPG at bundle time): bundling must work
 * on any build host, including Windows, without a `gpg` binary, and an
 * unsigned `SHASUMS256.txt` fetched at bundle time is no provenance at all.
 * The signature is checked here, once, by a maintainer; the resulting hashes
 * and the provenance record (verification status, signer fingerprints, the
 * SHA-256 of the signed `SHASUMS256.txt`, the retrieval time) are committed,
 * and the pull request diff shows exactly what changed. Review of that diff is
 * the trust anchor. A bundle built with `--require-verified-pins` (the release
 * and signing path) refuses any pin whose record is not `gpg-verified`.
 *
 * STATUS: the committed 26.8.1 pin is `unverified`. Verifying it needs `gpg`,
 * which the machine that recorded it did not have. Run the commands below on
 * a machine with `gpg` and commit the diff.
 *
 * Commands (what a maintainer runs; replace 26.8.1 with the version):
 *
 *   1. Get the public Node.js release keys and review them. The keys are
 *      published at https://github.com/nodejs/release-keys ; pin the checkout
 *      to a commit you have reviewed against the "Release keys" list in the
 *      README of https://github.com/nodejs/node :
 *        git clone https://github.com/nodejs/release-keys
 *        git -C release-keys log -1            # note the commit in the PR text
 *        export GNUPGHOME="$(mktemp -d)"; chmod 700 "$GNUPGHOME"
 *        gpg --import release-keys/keys/*.asc  # layout: check the checkout
 *   2. Write the expected PRIMARY key fingerprints (40 hex characters, one per
 *      line, `#` comments allowed) of the releasers, from that GnuPG home:
 *        gpg --with-colons --list-keys \
 *          | awk -F: '$1=="pub"{p=1;next} p&&$1=="fpr"{print $10;p=0}' \
 *          > release-key-fingerprints.txt
 *      Review the file against the Node.js README list; the signature below
 *      only counts when its signer is in this file.
 *   3. Run the script. It downloads (HTTPS, redirects refused, size capped,
 *      30 s timeout)
 *        https://nodejs.org/dist/v26.8.1/SHASUMS256.txt
 *        https://nodejs.org/dist/v26.8.1/SHASUMS256.txt.sig
 *      or reads local copies with `--shasums <file> --sig <file>`, runs
 *        gpg --homedir "$GNUPGHOME" --status-fd=1 --verify \
 *            SHASUMS256.txt.sig SHASUMS256.txt
 *      requires a VALIDSIG whose primary-key fingerprint is in the file and
 *      no BADSIG/ERRSIG/EXPSIG/EXPKEYSIG/REVKEYSIG, extracts the six lines
 *      this repo needs (the macOS/Linux tarballs and the Windows `node.exe`
 *      files, as listed by `requiredDistFiles`) and rewrites ONLY the
 *      generated block of `src/bundler/node-pins.ts`, with
 *      `verification: 'gpg-verified'`, the signer fingerprints, the digest of
 *      `SHASUMS256.txt` and the retrieval time (existing versions are kept):
 *        node packages/smrt-desktop/scripts/update-node-pins.mjs 26.8.1 \
 *          --gnupghome "$GNUPGHOME" --fingerprints release-key-fingerprints.txt
 *      Add `--dry-run` to print the block instead of writing it.
 *   4. Cross-check the clear-signed copy by hand (optional, same keys):
 *        curl -fsSO https://nodejs.org/dist/v26.8.1/SHASUMS256.txt.asc
 *        gpg --homedir "$GNUPGHOME" --verify SHASUMS256.txt.asc
 *   5. Run `pnpm exec biome format --write packages/smrt-desktop/src/bundler/node-pins.ts`
 *      (it should change nothing), review the diff and commit it, quoting the
 *      release-keys commit. A pin is never edited by hand.
 *
 * `--unverified` skips the signature check and records
 * `verification: 'unverified'` (no fingerprints) so the gap is visible in
 * review and a release bundle refuses the pin. Use it only to stage a pin
 * that a maintainer with `gpg` will re-run with the real check.
 *
 * Node's per-version LICENSE (design section 2.5, Windows has no archive to
 * take it from) is not handled here; see the bundler design notes.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_PINS_FILE = resolve(
  SCRIPT_DIR,
  '..',
  'src',
  'bundler',
  'node-pins.ts',
);

const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const SHA256 = /^[0-9a-f]{64}$/;
export const DIST_BASE = 'https://nodejs.org/dist';
const MAX_FETCH_BYTES = 1024 * 1024;
/** Overall time one download (headers and body) may take. */
export const FETCH_TIMEOUT_MS = 30_000;

export const BEGIN_MARKER =
  '// BEGIN GENERATED PINS (scripts/update-node-pins.mjs)';
export const END_MARKER = '// END GENERATED PINS';
const PINS_OPEN = 'const NODE_PINS_DATA: NodePinTable = {';
const PROVENANCE_OPEN =
  'const NODE_PIN_PROVENANCE_DATA: NodePinProvenanceTable = {';

/**
 * The files in SHASUMS256.txt this repo pins: one per supported target
 * (`src/bundler/targets.ts`); a test keeps the two lists equal.
 * @param {string} version
 * @returns {string[]}
 */
export function requiredDistFiles(version) {
  assertVersion(version);
  return [
    `node-v${version}-darwin-arm64.tar.gz`,
    `node-v${version}-darwin-x64.tar.gz`,
    `node-v${version}-linux-arm64.tar.gz`,
    `node-v${version}-linux-x64.tar.gz`,
    'win-arm64/node.exe',
    'win-x64/node.exe',
  ];
}

/** @param {string} version */
function assertVersion(version) {
  if (typeof version !== 'string' || !VERSION.test(version)) {
    throw new Error('version must be a plain major.minor.patch');
  }
}

/**
 * Parse `SHASUMS256.txt` (`<64 hex>  <name>` per line, two spaces). Rejects
 * malformed lines, duplicate names and uppercase hashes.
 * @param {string} text
 * @returns {Map<string, string>} file name -> sha256
 */
export function parseShasums(text) {
  /** @type {Map<string, string>} */
  const entries = new Map();
  for (const rawLine of text.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line === '') continue;
    const match = /^([0-9a-f]{64}) {2}(\S.*)$/.exec(line);
    if (!match) throw new Error('SHASUMS256.txt has a malformed line');
    const [, hash, name] = /** @type {RegExpExecArray} */ (match);
    if (entries.has(/** @type {string} */ (name))) {
      throw new Error('SHASUMS256.txt lists a file twice');
    }
    entries.set(/** @type {string} */ (name), /** @type {string} */ (hash));
  }
  return entries;
}

/**
 * The pins for `version`, sorted by file name. Throws when a required file is
 * missing so a partial table is never written.
 * @param {string} version
 * @param {Map<string, string>} entries
 * @returns {Array<[string, string]>}
 */
export function selectPins(version, entries) {
  const pins = [];
  for (const file of requiredDistFiles(version)) {
    const hash = entries.get(file);
    if (hash === undefined || !SHA256.test(hash)) {
      throw new Error('SHASUMS256.txt lacks a required distribution file');
    }
    pins.push(/** @type {[string, string]} */ ([file, hash]));
  }
  return pins.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Parse `gpg --status-fd` output. Returns the primary-key fingerprints of
 * every VALIDSIG line and whether a BADSIG/ERRSIG/EXPSIG/REVKEYSIG/EXPKEYSIG
 * line was seen. The signature is acceptable only when `bad` is false and a
 * `validPrimaryFingerprints` entry is in the maintainer's fingerprint list.
 * @param {string} status
 * @returns {{ validPrimaryFingerprints: string[]; bad: boolean }}
 */
export function parseGpgStatus(status) {
  /** @type {string[]} */
  const valid = [];
  let bad = false;
  for (const line of status.split('\n')) {
    if (!line.startsWith('[GNUPG:] ')) continue;
    const fields = line.slice('[GNUPG:] '.length).trim().split(/\s+/);
    const keyword = fields[0];
    if (keyword === 'VALIDSIG') {
      // VALIDSIG <fpr> <date> <ts> <expire> <ver> <rsvd> <pk-algo> <hash-algo>
      //          <class> <primary-key-fpr>
      const primary = fields[10];
      if (primary !== undefined && /^[0-9A-Fa-f]{40,64}$/.test(primary)) {
        valid.push(primary.toUpperCase());
      }
    } else if (
      keyword === 'BADSIG' ||
      keyword === 'ERRSIG' ||
      keyword === 'EXPSIG' ||
      keyword === 'EXPKEYSIG' ||
      keyword === 'REVKEYSIG'
    ) {
      bad = true;
    }
  }
  return { validPrimaryFingerprints: valid, bad };
}

/**
 * Parse a fingerprints file: one hex fingerprint per line, spaces allowed
 * inside, `#` starts a comment.
 * @param {string} text
 * @returns {string[]} upper-case fingerprints
 */
export function parseFingerprints(text) {
  /** @type {string[]} */
  const result = [];
  for (const raw of text.split('\n')) {
    const line = (raw.split('#')[0] ?? '').replace(/\s+/g, '');
    if (line === '') continue;
    if (!/^[0-9A-Fa-f]{40,64}$/.test(line)) {
      throw new Error('fingerprints file has a malformed line');
    }
    result.push(line.toUpperCase());
  }
  return result;
}

/**
 * True when the status shows a good signature by a trusted primary key.
 * @param {{ validPrimaryFingerprints: string[]; bad: boolean }} parsed
 * @param {string[]} trusted
 */
export function isTrustedSignature(parsed, trusted) {
  const set = new Set(trusted);
  return (
    !parsed.bad &&
    parsed.validPrimaryFingerprints.length > 0 &&
    parsed.validPrimaryFingerprints.every((fpr) => set.has(fpr))
  );
}

/**
 * @typedef {object} Provenance
 * @property {'gpg-verified' | 'unverified'} verification
 * @property {string} source          the `SHASUMS256.txt` URL
 * @property {string} retrieved       `YYYY-MM-DDTHH:MM:SSZ`
 * @property {string} shasumsSha256   digest of the exact file the pins came from
 * @property {string[]} signerFingerprints  upper-case primary fingerprints
 */

/**
 * @typedef {object} PinRecord
 * @property {string} version
 * @property {Array<[string, string]>} pins
 * @property {Provenance} provenance
 */

const SOURCE_URL =
  /^https:\/\/nodejs\.org\/dist\/v\d+\.\d+\.\d+\/SHASUMS256\.txt$/;
const RETRIEVED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const FINGERPRINT = /^[0-9A-F]{40}$/;

/**
 * Why a provenance record cannot stand for what it claims (fixed labels;
 * empty when it is sound). Mirrors `pinProvenanceProblems` in `node-pins.ts`;
 * a test keeps the two in step.
 * @param {unknown} value
 * @returns {string[]}
 */
export function provenanceProblems(value) {
  if (value === null || typeof value !== 'object') return ['not an object'];
  const record = /** @type {Record<string, unknown>} */ (value);
  /** @type {string[]} */
  const problems = [];
  const verification = record.verification;
  if (verification !== 'gpg-verified' && verification !== 'unverified') {
    problems.push('verification');
  }
  if (typeof record.source !== 'string' || !SOURCE_URL.test(record.source)) {
    problems.push('source');
  }
  if (
    typeof record.retrieved !== 'string' ||
    !RETRIEVED.test(record.retrieved)
  ) {
    problems.push('retrieved');
  }
  if (
    typeof record.shasumsSha256 !== 'string' ||
    !SHA256.test(record.shasumsSha256)
  ) {
    problems.push('shasumsSha256');
  }
  const fingerprints = record.signerFingerprints;
  const fingerprintsOk =
    Array.isArray(fingerprints) &&
    fingerprints.every(
      (fpr) => typeof fpr === 'string' && FINGERPRINT.test(fpr),
    ) &&
    new Set(fingerprints).size === fingerprints.length;
  if (!fingerprintsOk) problems.push('signerFingerprints');
  else if (verification === 'gpg-verified' && fingerprints.length === 0) {
    problems.push('signerFingerprints');
  } else if (verification === 'unverified' && fingerprints.length > 0) {
    problems.push('signerFingerprints');
  }
  return problems;
}

/**
 * Render the generated block (markers included): the pin table, then the
 * provenance table, in the exact form the formatter leaves alone.
 * @param {PinRecord[]} records  rendered in the order given
 * @returns {string}
 */
export function renderPinsBlock(records) {
  const lines = [BEGIN_MARKER, PINS_OPEN];
  for (const record of records) {
    assertVersion(record.version);
    lines.push(`  '${record.version}': {`);
    for (const [file, hash] of record.pins) {
      if (!/^[A-Za-z0-9._/-]+$/.test(file) || !SHA256.test(hash)) {
        throw new Error('refusing to render a malformed pin');
      }
      // A 64-char hash always forces the formatter's two-line form.
      lines.push(`    '${file}':`, `      '${hash}',`);
    }
    lines.push('  },');
  }
  lines.push('};', PROVENANCE_OPEN);
  for (const record of records) {
    if (provenanceProblems(record.provenance).length > 0) {
      throw new Error('refusing to render a malformed provenance record');
    }
    const { provenance } = record;
    lines.push(
      `  '${record.version}': {`,
      `    verification: '${provenance.verification}',`,
      `    source: '${provenance.source}',`,
      `    retrieved: '${provenance.retrieved}',`,
      '    shasumsSha256:',
      `      '${provenance.shasumsSha256}',`,
    );
    const fingerprints = provenance.signerFingerprints;
    if (fingerprints.length === 0) lines.push('    signerFingerprints: [],');
    else if (fingerprints.length === 1) {
      // One 40-character entry fits the formatter's line width.
      lines.push(`    signerFingerprints: ['${fingerprints[0]}'],`);
    } else {
      lines.push('    signerFingerprints: [');
      for (const fpr of fingerprints) lines.push(`      '${fpr}',`);
      lines.push('    ],');
    }
    lines.push('  },');
  }
  lines.push('};', END_MARKER);
  return lines.join('\n');
}

/**
 * Read the records out of the generated block of an existing source file, so
 * older versions survive a regeneration. Strict: anything that is not exactly
 * the generated form throws.
 * @param {string} source
 * @returns {PinRecord[]}
 */
export function parsePinsBlock(source) {
  const start = source.indexOf(BEGIN_MARKER);
  const end = source.indexOf(END_MARKER);
  if (start === -1 || end === -1 || end < start) {
    throw new Error('node-pins.ts has no generated block');
  }
  const lines = source.slice(start, end).split('\n');
  let at = 0;
  const bad = () => new Error('node-pins.ts generated block is not in the expected form');
  /** @param {string} expected */
  const expect = (expected) => {
    if (lines[at] !== expected) throw bad();
    at += 1;
  };
  /** @param {RegExp} pattern @returns {RegExpExecArray} */
  const take = (pattern) => {
    const match = pattern.exec(lines[at] ?? '');
    if (match === null) throw bad();
    at += 1;
    return match;
  };
  const peekIs = (/** @type {string} */ line) => lines[at] === line;

  expect(BEGIN_MARKER);
  expect(PINS_OPEN);
  /** @type {Map<string, Array<[string, string]>>} */
  const pinsByVersion = new Map();
  while (!peekIs('};')) {
    const version = /** @type {string} */ (
      take(/^ {2}'(\d+\.\d+\.\d+)': \{$/)[1]
    );
    if (pinsByVersion.has(version)) throw bad();
    /** @type {Array<[string, string]>} */
    const pins = [];
    while (!peekIs('  },')) {
      const file = /** @type {string} */ (take(/^ {4}'([^'\n]+)':$/)[1]);
      const hash = /** @type {string} */ (take(/^ {6}'([0-9a-f]{64})',$/)[1]);
      pins.push([file, hash]);
    }
    if (pins.length === 0) throw bad();
    expect('  },');
    pinsByVersion.set(version, pins);
  }
  expect('};');
  expect(PROVENANCE_OPEN);
  /** @type {PinRecord[]} */
  const records = [];
  while (!peekIs('};')) {
    const version = /** @type {string} */ (
      take(/^ {2}'(\d+\.\d+\.\d+)': \{$/)[1]
    );
    const verification = /** @type {string} */ (
      take(/^ {4}verification: '([a-z-]+)',$/)[1]
    );
    const sourceUrl = /** @type {string} */ (take(/^ {4}source: '([^'\n]+)',$/)[1]);
    const retrieved = /** @type {string} */ (
      take(/^ {4}retrieved: '([^'\n]+)',$/)[1]
    );
    expect('    shasumsSha256:');
    const shasumsSha256 = /** @type {string} */ (
      take(/^ {6}'([0-9a-f]{64})',$/)[1]
    );
    /** @type {string[]} */
    const signerFingerprints = [];
    const single = /^ {4}signerFingerprints: \[(?:'([0-9A-F]{40})')?\],$/.exec(
      lines[at] ?? '',
    );
    if (single !== null) {
      at += 1;
      if (single[1] !== undefined) signerFingerprints.push(single[1]);
    } else {
      expect('    signerFingerprints: [');
      while (!peekIs('    ],')) {
        signerFingerprints.push(
          /** @type {string} */ (take(/^ {6}'([0-9A-F]{40})',$/)[1]),
        );
      }
      expect('    ],');
      if (signerFingerprints.length < 2) throw bad();
    }
    expect('  },');
    const pins = pinsByVersion.get(version);
    if (pins === undefined) throw bad();
    pinsByVersion.delete(version);
    const provenance = {
      verification: /** @type {'gpg-verified' | 'unverified'} */ (
        verification
      ),
      source: sourceUrl,
      retrieved,
      shasumsSha256,
      signerFingerprints,
    };
    if (provenanceProblems(provenance).length > 0) throw bad();
    records.push({ version, pins, provenance });
  }
  expect('};');
  // Every version must have both halves, and only the closing blank remains.
  if (pinsByVersion.size > 0 || at !== lines.length - 1 || lines[at] !== '') {
    throw bad();
  }
  return records;
}

/** @param {string} a @param {string} b */
function compareVersionsDesc(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    const delta = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

/**
 * Replace (or add) one version's record in a node-pins.ts source and return
 * the new source. Versions are written newest first.
 * @param {string} source
 * @param {PinRecord} record
 * @returns {string}
 */
export function mergePinsSource(source, record) {
  const records = parsePinsBlock(source).filter(
    (existing) => existing.version !== record.version,
  );
  records.push(record);
  records.sort((a, b) => compareVersionsDesc(a.version, b.version));
  const start = source.indexOf(BEGIN_MARKER);
  const end = source.indexOf(END_MARKER) + END_MARKER.length;
  return source.slice(0, start) + renderPinsBlock(records) + source.slice(end);
}

/**
 * The provenance record for a freshly generated entry. A verified record
 * carries the signer fingerprints; an unverified one never does.
 * @param {{ version: string; shasumsSha256: string; retrieved: string;
 *           signerFingerprints: string[] }} info
 * @returns {Provenance}
 */
export function buildProvenance(info) {
  assertVersion(info.version);
  const verified = info.signerFingerprints.length > 0;
  return {
    verification: verified ? 'gpg-verified' : 'unverified',
    source: `${DIST_BASE}/v${info.version}/SHASUMS256.txt`,
    retrieved: info.retrieved,
    shasumsSha256: info.shasumsSha256,
    signerFingerprints: [...new Set(info.signerFingerprints)].sort(),
  };
}

/* ------------------------------------------------------------------ */
/* Maintainer-only I/O below.                                           */
/* ------------------------------------------------------------------ */

/**
 * HTTPS GET with redirects refused, a size cap and an overall timeout (the
 * connection and the whole body). `fetchImpl` is a test seam.
 * @param {string} url
 * @param {{ fetchImpl?: typeof fetch; timeoutMs?: number }} [options]
 * @returns {Promise<Buffer>}
 */
export async function download(url, options = {}) {
  if (!url.startsWith('https://')) throw new Error('refusing a non-https URL');
  const fetchImpl = options.fetchImpl ?? fetch;
  const signal = AbortSignal.timeout(options.timeoutMs ?? FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { redirect: 'error', signal });
    if (response.status !== 200 || response.body === null) {
      throw new Error(`download failed with HTTP ${response.status}`);
    }
    const chunks = [];
    let total = 0;
    for await (const chunk of response.body) {
      total += chunk.length;
      if (total > MAX_FETCH_BYTES) throw new Error('download too large');
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  } catch (error) {
    if (signal.aborted) throw new Error('download timed out');
    throw error;
  }
}

/**
 * @param {string[]} argv
 * @returns {{ version: string; options: Map<string, string | true> }}
 */
export function parseArgs(argv) {
  const [version, ...rest] = argv;
  if (!version) {
    throw new Error('usage: update-node-pins.mjs <version> [options]');
  }
  assertVersion(version);
  /** @type {Map<string, string | true>} */
  const options = new Map();
  const flags = new Set(['--dry-run', '--unverified']);
  const valued = new Set([
    '--gnupghome',
    '--fingerprints',
    '--shasums',
    '--sig',
    '--out',
  ]);
  for (let i = 0; i < rest.length; i += 1) {
    const arg = /** @type {string} */ (rest[i]);
    if (flags.has(arg)) options.set(arg, true);
    else if (valued.has(arg)) {
      const value = rest[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`${arg} needs a value`);
      }
      options.set(arg, value);
      i += 1;
    } else throw new Error(`unknown option ${arg}`);
  }
  return { version, options };
}

/** @param {string} home @param {string} sigFile @param {string} shasumsFile */
function runGpgVerify(home, sigFile, shasumsFile) {
  try {
    execFileSync('gpg', ['--version'], { stdio: 'ignore' });
  } catch {
    throw new Error(
      'gpg is not installed; run this on a machine with gpg (or use --unverified, which a release bundle refuses)',
    );
  }
  try {
    return execFileSync(
      'gpg',
      ['--homedir', home, '--status-fd=1', '--verify', sigFile, shasumsFile],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
  } catch (error) {
    // gpg exits non-zero for a bad signature but still writes status lines.
    return String(/** @type {{ stdout?: unknown }} */ (error).stdout ?? '');
  }
}

async function main() {
  const { version, options } = parseArgs(process.argv.slice(2));
  const shasumsPath = options.get('--shasums');
  const sigPath = options.get('--sig');
  const base = `${DIST_BASE}/v${version}`;
  const shasums =
    typeof shasumsPath === 'string'
      ? readFileSync(shasumsPath)
      : await download(`${base}/SHASUMS256.txt`);
  const unverified = options.get('--unverified') === true;

  /** @type {string[]} */
  let signerFingerprints = [];
  if (!unverified) {
    const home = options.get('--gnupghome');
    const fingerprintsPath = options.get('--fingerprints');
    if (typeof home !== 'string' || typeof fingerprintsPath !== 'string') {
      throw new Error(
        '--gnupghome and --fingerprints are required (or --unverified)',
      );
    }
    const trusted = parseFingerprints(readFileSync(fingerprintsPath, 'utf8'));
    if (trusted.length === 0) throw new Error('fingerprints file is empty');
    const sig =
      typeof sigPath === 'string'
        ? readFileSync(sigPath)
        : await download(`${base}/SHASUMS256.txt.sig`);
    const work = mkdtempSync(join(tmpdir(), 'node-pins-'));
    try {
      const shasumsFile = join(work, 'SHASUMS256.txt');
      const sigFile = join(work, 'SHASUMS256.txt.sig');
      writeFileSync(shasumsFile, shasums);
      writeFileSync(sigFile, sig);
      const parsed = parseGpgStatus(runGpgVerify(home, sigFile, shasumsFile));
      if (!isTrustedSignature(parsed, trusted)) {
        throw new Error('signature check failed; refusing to record pins');
      }
      signerFingerprints = parsed.validPrimaryFingerprints;
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  const pins = selectPins(version, parseShasums(shasums.toString('utf8')));
  const record = {
    version,
    pins,
    provenance: buildProvenance({
      version,
      retrieved: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      shasumsSha256: createHash('sha256').update(shasums).digest('hex'),
      signerFingerprints,
    }),
  };
  const out = resolve(
    typeof options.get('--out') === 'string'
      ? /** @type {string} */ (options.get('--out'))
      : DEFAULT_PINS_FILE,
  );
  const next = mergePinsSource(readFileSync(out, 'utf8'), record);
  if (options.get('--dry-run') === true) {
    process.stdout.write(`${renderPinsBlock(parsePinsBlock(next))}\n`);
    return;
  }
  const temp = `${out}.tmp-${process.pid}`;
  writeFileSync(temp, next, { flag: 'wx' });
  renameSync(temp, out);
  process.stdout.write(
    `recorded ${pins.length} pins for Node ${version} (${record.provenance.verification}) in ${out}\n`,
  );
  process.stdout.write('review the diff, then run biome format on the file\n');
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    process.stderr.write(`update-node-pins: ${error.message}\n`);
    process.exitCode = 1;
  });
}
