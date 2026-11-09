/**
 * Committed SHA-256 pins for the official Node.js binaries the bundler embeds
 * as the desktop sidecar, and the provenance of each pinned release.
 *
 * The table is keyed by exact version, then by the file name as it appears in
 * that version's `SHASUMS256.txt` (`node-v<ver>-<os>-<arch>.tar.gz` for macOS
 * and Linux, `win-<arch>/node.exe` for Windows). It is the trust anchor: the
 * bundler downloads Node only over HTTPS from a constant location, hashes the
 * WHOLE download, and refuses anything that is not pinned here. A version or
 * file that is absent from the table is refused (fail closed); there is no
 * override flag.
 *
 * Provenance. Each version also has a structured provenance record:
 * `verification` is `'gpg-verified'` only when a maintainer ran
 * `scripts/update-node-pins.mjs` with `gpg` and the Node.js release keys and
 * the `SHASUMS256.txt.sig` signature checked out; the record then carries the
 * primary-key fingerprint(s) that signed, the SHA-256 of the signed
 * `SHASUMS256.txt` and the retrieval time. Anything else is `'unverified'`
 * (the hashes were copied over TLS only). A record that says `gpg-verified`
 * without those facts is treated as unverified (`isGpgVerified`) and fails the
 * repository tests. A bundle built with `requireVerifiedPins` (the release and
 * signing path) refuses an unverified pin (`node_pin_unverified`); any other
 * bundle warns loudly. The provenance of the pin that was used is recorded in
 * `bundle-report.json` (`node.pin`).
 *
 * DO NOT edit the generated block by hand. Regenerate it with
 * `node packages/smrt-desktop/scripts/update-node-pins.mjs <version> ...`
 * (maintainer-only: needs network, or local copies of the signed files, and
 * `gpg`; see the script header). The pull request diff then shows exactly
 * which hashes changed and the reviewer is the trust anchor.
 *
 * STATUS: verification of 26.8.1 is BLOCKED. That entry was recorded by hand
 * from the TLS-served `SHASUMS256.txt` on a machine without `gpg`; it stays
 * `'unverified'` until the script is run with `gpg` (see the script header).
 */

import { NodeDistError } from './node-errors.js';

/** `version -> distFile -> lowercase hex SHA-256`. */
export type NodePinTable = Readonly<
  Record<string, Readonly<Record<string, string>>>
>;

/** How the pinned hashes of one release were checked. */
export type NodePinVerification = 'gpg-verified' | 'unverified';

export interface NodePinProvenance {
  readonly verification: NodePinVerification;
  /** The `https://nodejs.org/dist/...` URL of the `SHASUMS256.txt` used. */
  readonly source: string;
  /** UTC retrieval time, `YYYY-MM-DDTHH:MM:SSZ`. */
  readonly retrieved: string;
  /** SHA-256 of the exact `SHASUMS256.txt` the pins were taken from. */
  readonly shasumsSha256: string;
  /**
   * Upper-case primary-key fingerprints of the VALIDSIG lines gpg reported
   * for `SHASUMS256.txt.sig`. Empty for an unverified pin.
   */
  readonly signerFingerprints: readonly string[];
}

export type NodePinProvenanceTable = Readonly<
  Record<string, NodePinProvenance>
>;

// BEGIN GENERATED PINS (scripts/update-node-pins.mjs)
const NODE_PINS_DATA: NodePinTable = {
  '26.8.1': {
    'node-v26.8.1-darwin-arm64.tar.gz':
      '6e577fd0d9db776db82306629e441a9dace416702622aebdd171c9dfaa41f4d2',
    'node-v26.8.1-darwin-x64.tar.gz':
      'fe9c6dbf9c8e1b4443803d75e2a20366e420dae650c747dbb116b22975751baf',
    'node-v26.8.1-linux-arm64.tar.gz':
      'd5f973ce975e4bd03e6c2038260f7e9201615aa8e1ee293c72f8dcc2a6d9fddb',
    'node-v26.8.1-linux-x64.tar.gz':
      'b2b76660fa4ded4e0b2a41ee3c0c651cd52ea8170ead91ebac1e147ac3d55643',
    'win-arm64/node.exe':
      '8f359458741eaccce126ce45b1754e164b28849d05f7dfc2fdd1567054f47afc',
    'win-x64/node.exe':
      '5cba0ea928508c65ddadefc0681d2fb6d95f1f3beea4428f04397631140ee8e5',
  },
};
const NODE_PIN_PROVENANCE_DATA: NodePinProvenanceTable = {
  '26.8.1': {
    verification: 'unverified',
    source: 'https://nodejs.org/dist/v26.8.1/SHASUMS256.txt',
    retrieved: '2026-11-09T00:43:17Z',
    shasumsSha256:
      '4f1c377505ddc3a872821cd333b72d9743673a41c939508d877e8cd8d4379336',
    signerFingerprints: [],
  },
};
// END GENERATED PINS

function freezeTable(table: NodePinTable): NodePinTable {
  for (const files of Object.values(table)) Object.freeze(files);
  return Object.freeze(table);
}

export const NODE_PINS: NodePinTable = freezeTable(NODE_PINS_DATA);

function freezeProvenance(
  table: NodePinProvenanceTable,
): NodePinProvenanceTable {
  for (const record of Object.values(table)) {
    Object.freeze(record.signerFingerprints);
    Object.freeze(record);
  }
  return Object.freeze(table);
}

export const NODE_PIN_PROVENANCE: NodePinProvenanceTable = freezeProvenance(
  NODE_PIN_PROVENANCE_DATA,
);

const SHA256_HEX = /^[0-9a-f]{64}$/;

export function isSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && SHA256_HEX.test(value);
}

/** Pinned versions, newest first (numeric compare of major.minor.patch). */
export function pinnedVersions(pins: NodePinTable = NODE_PINS): string[] {
  const parts = (v: string) => v.split('.').map((n) => Number.parseInt(n, 10));
  return Object.keys(pins).sort((a, b) => {
    const pa = parts(a);
    const pb = parts(b);
    for (let i = 0; i < 3; i += 1) {
      const delta = (pb[i] ?? 0) - (pa[i] ?? 0);
      if (delta !== 0) return delta;
    }
    return 0;
  });
}

/**
 * The pinned SHA-256 for one distribution file. Throws a fixed-message
 * `NodeDistError` (`unpinned_version` / `unpinned_file`) when the version or
 * the file is not in the table, so an unknown version can never be used.
 * `pins` is a test seam; production callers use the committed table.
 */
export function lookupPin(
  version: string,
  filename: string,
  pins: NodePinTable = NODE_PINS,
): string {
  // `Object.hasOwn` keeps `__proto__` / `constructor` from reading inherited
  // members as a pin.
  if (!Object.hasOwn(pins, version))
    throw new NodeDistError('unpinned_version');
  const files = pins[version] as Readonly<Record<string, string>>;
  if (!Object.hasOwn(files, filename)) throw new NodeDistError('unpinned_file');
  const pin = files[filename];
  if (!isSha256Hex(pin)) throw new NodeDistError('unpinned_file');
  return pin;
}

const SOURCE_URL =
  /^https:\/\/nodejs\.org\/dist\/v\d+\.\d+\.\d+\/SHASUMS256\.txt$/;
const RETRIEVED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const FINGERPRINT = /^[0-9A-F]{40}$/;

/**
 * Why a provenance record cannot stand for what it claims, as fixed labels
 * (empty when it is sound). A `gpg-verified` record needs the signer
 * fingerprints, the `SHASUMS256.txt` digest, a retrieval time and the dist
 * URL; an `unverified` record must not claim signers. The repository test
 * runs this over the committed table, so hand-editing `unverified` to
 * `gpg-verified` fails the suite.
 */
export function pinProvenanceProblems(value: unknown): string[] {
  if (value === null || typeof value !== 'object') return ['not an object'];
  const record = value as Partial<Record<keyof NodePinProvenance, unknown>>;
  const problems: string[] = [];
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
  if (!isSha256Hex(record.shasumsSha256)) problems.push('shasumsSha256');
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

/** True only for a sound record that says `gpg-verified`. */
export function isGpgVerified(record: NodePinProvenance): boolean {
  return (
    record.verification === 'gpg-verified' &&
    pinProvenanceProblems(record).length === 0
  );
}

/**
 * The provenance record of a pinned version. Throws `unpinned_version` when
 * the version has no pin or no record. `table` is a test seam.
 */
export function lookupPinProvenance(
  version: string,
  table: NodePinProvenanceTable = NODE_PIN_PROVENANCE,
): NodePinProvenance {
  if (!Object.hasOwn(table, version)) {
    throw new NodeDistError('unpinned_version');
  }
  return table[version] as NodePinProvenance;
}
