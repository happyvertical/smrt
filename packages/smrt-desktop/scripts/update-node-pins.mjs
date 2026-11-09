#!/usr/bin/env node
// @ts-check
/**
 * Maintainer script: record the SHA-256 pins for one Node.js release in
 * `src/bundler/node-pins.ts`.
 *
 * MAINTAINER-ONLY. It needs the network (or local copies of the signed files)
 * and `gpg`. It is NOT run by `npm test`, by CI, or by `smrt desktop bundle`;
 * only the pure parts exported below (`parseShasums`, `selectPins`,
 * `parseGpgStatus`, `renderPinsBlock`, `mergePinsSource`) are unit tested,
 * offline (`src/bundler/update-node-pins.test.ts`).
 *
 * Why a script and committed pins (no GPG at bundle time): bundling must work
 * on any build host, including Windows, without a `gpg` binary, and an
 * unsigned `SHASUMS256.txt` fetched at bundle time is no provenance at all.
 * The signature is checked here, once, by a maintainer; the resulting hashes
 * are committed, and the pull request diff shows exactly what changed. Review
 * of that diff is the trust anchor.
 *
 * Procedure (what a maintainer runs):
 *
 *   1. Build a GnuPG home that contains ONLY the Node.js release keys, taken
 *      from https://github.com/nodejs/release-keys at a commit you have
 *      reviewed, and write the expected PRIMARY key fingerprints (40 hex
 *      chars, one per line, `#` comments allowed) to a file. Example:
 *        export GNUPGHOME="$(mktemp -d)"; chmod 700 "$GNUPGHOME"
 *        gpg --import release-keys/*.asc        # from the reviewed checkout
 *        gpg --list-keys --with-colons | awk -F: '$1=="fpr"{print $10}' ...
 *   2. Run:
 *        node packages/smrt-desktop/scripts/update-node-pins.mjs 26.8.1 \
 *          --gnupghome "$GNUPGHOME" --fingerprints release-key-fingerprints.txt
 *      It downloads (HTTPS, redirects refused, size-capped)
 *        https://nodejs.org/dist/v26.8.1/SHASUMS256.txt
 *        https://nodejs.org/dist/v26.8.1/SHASUMS256.txt.sig
 *      or reads local copies with `--shasums <file> --sig <file>`, runs
 *      `gpg --homedir <dir> --status-fd=1 --verify <sig> <shasums>`, requires a
 *      VALIDSIG whose primary-key fingerprint is in your fingerprints file,
 *      extracts the six lines this repo needs (macOS/Linux tarballs and the
 *      Windows `node.exe` files, as listed by `requiredDistFiles`), and
 *      rewrites ONLY the generated block of `src/bundler/node-pins.ts`
 *      (existing versions are kept). Add `--dry-run` to print the block.
 *   3. Review the diff and commit it. A pin is never edited by hand.
 *
 * `--unverified` skips the signature check and stamps the entry
 * "signature: NOT VERIFIED" so the gap is visible in review. Use it only to
 * stage a pin that a second maintainer will re-run with the real check.
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

export const BEGIN_MARKER =
  '// BEGIN GENERATED PINS (scripts/update-node-pins.mjs)';
export const END_MARKER = '// END GENERATED PINS';

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
 * @typedef {object} PinRecord
 * @property {string} version
 * @property {string[]} comment   comment lines (without the leading `//`)
 * @property {Array<[string, string]>} pins
 */

/**
 * Render the generated block (markers included).
 * @param {PinRecord[]} records  rendered in the order given
 * @returns {string}
 */
export function renderPinsBlock(records) {
  const lines = [BEGIN_MARKER, 'const NODE_PINS_DATA: NodePinTable = {'];
  for (const record of records) {
    assertVersion(record.version);
    for (const text of record.comment) lines.push(`  // ${text}`.trimEnd());
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
  lines.push('};', END_MARKER);
  return lines.join('\n');
}

/**
 * Read the records out of the generated block of an existing source file, so
 * older versions survive a regeneration.
 * @param {string} source
 * @returns {PinRecord[]}
 */
export function parsePinsBlock(source) {
  const start = source.indexOf(BEGIN_MARKER);
  const end = source.indexOf(END_MARKER);
  if (start === -1 || end === -1 || end < start) {
    throw new Error('node-pins.ts has no generated block');
  }
  const body = source.slice(start, end);
  /** @type {PinRecord[]} */
  const records = [];
  const re =
    /((?: {2}\/\/[^\n]*\n)*) {2}'(\d+\.\d+\.\d+)': \{\n((?: {4}'[^'\n]+':\n {6}'[0-9a-f]{64}',\n)+) {2}\},\n/g;
  let consumed = 0;
  for (let m = re.exec(body); m !== null; m = re.exec(body)) {
    const comment = (m[1] ?? '')
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => l.replace(/^ {2}\/\/ ?/, ''));
    /** @type {Array<[string, string]>} */
    const pins = [];
    const pinRe = / {4}'([^'\n]+)':\n {6}'([0-9a-f]{64})',\n/g;
    for (let p = pinRe.exec(m[3] ?? ''); p !== null; p = pinRe.exec(m[3] ?? '')) {
      pins.push([/** @type {string} */ (p[1]), /** @type {string} */ (p[2])]);
    }
    records.push({ version: /** @type {string} */ (m[2]), comment, pins });
    consumed += m[0].length;
  }
  // Everything between the two lines of the markers must have been understood.
  const framing = `${BEGIN_MARKER}\nconst NODE_PINS_DATA: NodePinTable = {\n`;
  if (!body.startsWith(framing) || body.length - framing.length - '};\n'.length !== consumed) {
    throw new Error('node-pins.ts generated block is not in the expected form');
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
 * The provenance comment for a freshly generated record.
 * @param {{ version: string; shasumsSha256: string; retrieved: string;
 *           source: string; signature: string }} info
 * @returns {string[]}
 */
export function provenanceComment(info) {
  return [
    info.version,
    `  source: ${info.source}`,
    `  retrieved: ${info.retrieved}`,
    `  SHASUMS256.txt sha256: ${info.shasumsSha256}`,
    `  signature: ${info.signature}`,
  ];
}

/* ------------------------------------------------------------------ */
/* Maintainer-only I/O below. Never imported by tests beyond this line. */
/* ------------------------------------------------------------------ */

/**
 * HTTPS GET with redirects refused and a size cap.
 * @param {string} url
 * @returns {Promise<Buffer>}
 */
async function download(url) {
  if (!url.startsWith('https://')) throw new Error('refusing a non-https URL');
  const response = await fetch(url, { redirect: 'error' });
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
}

/**
 * @param {string[]} argv
 * @returns {{ version: string; options: Map<string, string | true> }}
 */
export function parseArgs(argv) {
  const [version, ...rest] = argv;
  if (!version) throw new Error('usage: update-node-pins.mjs <version> [options]');
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

  let signature = 'NOT VERIFIED (--unverified)';
  if (!unverified) {
    const home = options.get('--gnupghome');
    const fingerprintsPath = options.get('--fingerprints');
    if (typeof home !== 'string' || typeof fingerprintsPath !== 'string') {
      throw new Error('--gnupghome and --fingerprints are required (or --unverified)');
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
      let status = '';
      try {
        status = execFileSync(
          'gpg',
          ['--homedir', home, '--status-fd=1', '--verify', sigFile, shasumsFile],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
        );
      } catch (error) {
        // gpg exits non-zero for a bad signature but still writes status lines.
        status = String(/** @type {{ stdout?: unknown }} */ (error).stdout ?? '');
      }
      const parsed = parseGpgStatus(status);
      if (!isTrustedSignature(parsed, trusted)) {
        throw new Error('signature check failed; refusing to record pins');
      }
      signature = `verified with gpg (primary key ${parsed.validPrimaryFingerprints[0]})`;
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  const pins = selectPins(version, parseShasums(shasums.toString('utf8')));
  const record = {
    version,
    comment: provenanceComment({
      version,
      source: typeof shasumsPath === 'string' ? `local copy of ${base}/SHASUMS256.txt` : `${base}/SHASUMS256.txt`,
      retrieved: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      shasumsSha256: createHash('sha256').update(shasums).digest('hex'),
      signature,
    }),
    pins,
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
  process.stdout.write(`recorded ${pins.length} pins for Node ${version} in ${out}\n`);
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
