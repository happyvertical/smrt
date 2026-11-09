/**
 * Committed SHA-256 pins for the official Node.js binaries the bundler embeds
 * as the desktop sidecar.
 *
 * The table is keyed by exact version, then by the file name as it appears in
 * that version's `SHASUMS256.txt` (`node-v<ver>-<os>-<arch>.tar.gz` for macOS
 * and Linux, `win-<arch>/node.exe` for Windows). It is the trust anchor: the
 * bundler downloads Node only over HTTPS from a constant location, hashes the
 * WHOLE download, and refuses anything that is not pinned here. A version or
 * file that is absent from the table is refused (fail closed); there is no
 * override flag.
 *
 * DO NOT edit the generated block by hand. Regenerate it with
 * `node packages/smrt-desktop/scripts/update-node-pins.mjs <version> ...`
 * (maintainer-only: needs network, or local copies of the signed files, and
 * `gpg`; see the script header). The pull request diff then shows exactly
 * which hashes changed and the reviewer is the trust anchor. Each version
 * carries its provenance (source, retrieval time, SHASUMS256.txt digest,
 * signature status) in the comment above it.
 *
 * The 26.8.1 entry was recorded by hand from the TLS-served SHASUMS256.txt
 * (see its provenance comment) BEFORE the signature had been checked; the
 * first maintainer run of the script replaces it with a gpg-verified entry.
 */

import { NodeDistError } from './node-errors.js';

/** `version -> distFile -> lowercase hex SHA-256`. */
export type NodePinTable = Readonly<
  Record<string, Readonly<Record<string, string>>>
>;

// BEGIN GENERATED PINS (scripts/update-node-pins.mjs)
const NODE_PINS_DATA: NodePinTable = {
  // 26.8.1
  //   source: https://nodejs.org/dist/v26.8.1/SHASUMS256.txt
  //   retrieved: 2026-11-09T00:43:17Z (curl -fsS, HTTPS, HTTP 200, no redirect)
  //   SHASUMS256.txt sha256: 4f1c377505ddc3a872821cd333b72d9743673a41c939508d877e8cd8d4379336
  //   signature: NOT VERIFIED (recorded by hand; re-run update-node-pins.mjs)
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
// END GENERATED PINS

function freezeTable(table: NodePinTable): NodePinTable {
  for (const files of Object.values(table)) Object.freeze(files);
  return Object.freeze(table);
}

export const NODE_PINS: NodePinTable = freezeTable(NODE_PINS_DATA);

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
