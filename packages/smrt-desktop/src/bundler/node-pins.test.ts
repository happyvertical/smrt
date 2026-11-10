import { describe, expect, it } from 'vitest';
import { NODE_DIST_MESSAGES, NodeDistError } from './node-errors.js';
import {
  isGpgVerified,
  isSha256Hex,
  lookupPin,
  lookupPinProvenance,
  NODE_PIN_PROVENANCE,
  NODE_PINS,
  type NodePinProvenance,
  pinnedVersions,
  pinProvenanceProblems,
} from './node-pins.js';
import { nodeDistFile, TARGETS } from './targets.js';

describe('node-pins', () => {
  it('covers every dist file of every supported target for each pinned version', () => {
    const versions = pinnedVersions();
    expect(versions.length).toBeGreaterThan(0);
    for (const version of versions) {
      for (const spec of TARGETS) {
        const pin = lookupPin(version, nodeDistFile(spec, version));
        expect(isSha256Hex(pin)).toBe(true);
      }
      const files = Object.keys(NODE_PINS[version] as object);
      expect(files).toHaveLength(TARGETS.length);
    }
  });

  it('only contains 64-char lowercase hex pins, keyed by version-consistent names', () => {
    for (const [version, files] of Object.entries(NODE_PINS)) {
      expect(version).toMatch(/^\d+\.\d+\.\d+$/);
      for (const [file, hash] of Object.entries(files)) {
        expect(hash).toMatch(/^[0-9a-f]{64}$/);
        if (file.endsWith('.tar.gz')) {
          expect(file.startsWith(`node-v${version}-`)).toBe(true);
        } else {
          expect(file).toMatch(/^win-(?:x64|arm64)\/node\.exe$/);
        }
      }
    }
  });

  it('is immutable at runtime', () => {
    expect(Object.isFrozen(NODE_PINS)).toBe(true);
    for (const files of Object.values(NODE_PINS)) {
      expect(Object.isFrozen(files)).toBe(true);
    }
  });

  it('refuses an unpinned version or file with fixed errors', () => {
    expect(() => lookupPin('0.0.0', 'win-x64/node.exe')).toThrow(
      expect.objectContaining({ code: 'unpinned_version' }),
    );
    const version = pinnedVersions()[0] as string;
    expect(() => lookupPin(version, 'node-v0-other.tar.gz')).toThrow(
      expect.objectContaining({ code: 'unpinned_file' }),
    );
    try {
      lookupPin('0.0.0', 'x');
    } catch (error) {
      expect(error).toBeInstanceOf(NodeDistError);
      expect((error as Error).message).toBe(
        NODE_DIST_MESSAGES.unpinned_version,
      );
    }
  });

  it('does not read inherited object members as pins', () => {
    for (const version of [
      '__proto__',
      'constructor',
      'toString',
      'hasOwnProperty',
    ]) {
      expect(() => lookupPin(version, 'win-x64/node.exe')).toThrow(
        expect.objectContaining({ code: 'unpinned_version' }),
      );
    }
    const version = pinnedVersions()[0] as string;
    expect(() => lookupPin(version, '__proto__')).toThrow(
      expect.objectContaining({ code: 'unpinned_file' }),
    );
  });

  it('rejects a malformed pin value in an injected table', () => {
    expect(() => lookupPin('1.0.0', 'f', { '1.0.0': { f: 'ABC' } })).toThrow(
      expect.objectContaining({ code: 'unpinned_file' }),
    );
  });

  it('sorts versions newest first numerically', () => {
    expect(
      pinnedVersions({
        '26.9.0': {},
        '26.10.0': {},
        '26.8.1': {},
        '25.1.0': {},
      }),
    ).toEqual(['26.10.0', '26.9.0', '26.8.1', '25.1.0']);
  });

  it('has a sound provenance record for exactly the pinned versions', () => {
    expect(Object.keys(NODE_PIN_PROVENANCE).sort()).toEqual(
      Object.keys(NODE_PINS).sort(),
    );
    for (const [version, record] of Object.entries(NODE_PIN_PROVENANCE)) {
      expect(pinProvenanceProblems(record), version).toEqual([]);
      expect(record.source).toBe(
        `https://nodejs.org/dist/v${version}/SHASUMS256.txt`,
      );
      expect(Object.isFrozen(record)).toBe(true);
    }
  });

  it('fails the suite when a pin says gpg-verified without its evidence', () => {
    // This is the gate: hand-editing a pin to 'gpg-verified' without the
    // signer fingerprints and the SHASUMS256.txt digest is caught here, and
    // `isGpgVerified` (what the release path trusts) refuses it as well.
    for (const [version, record] of Object.entries(NODE_PIN_PROVENANCE)) {
      if (record.verification !== 'gpg-verified') continue;
      expect(record.signerFingerprints.length, version).toBeGreaterThan(0);
      expect(isSha256Hex(record.shasumsSha256), version).toBe(true);
      expect(isGpgVerified(record), version).toBe(true);
    }
    const unverified = NODE_PIN_PROVENANCE['26.8.1'] as NodePinProvenance;
    const flipped: NodePinProvenance = {
      ...unverified,
      verification: 'gpg-verified',
    };
    expect(pinProvenanceProblems(flipped)).toContain('signerFingerprints');
    expect(isGpgVerified(flipped)).toBe(false);
    expect(
      isGpgVerified({ ...flipped, signerFingerprints: ['A'.repeat(40)] }),
    ).toBe(true);
    expect(
      pinProvenanceProblems({
        ...flipped,
        signerFingerprints: ['A'.repeat(40)],
        shasumsSha256: '',
      }),
    ).toContain('shasumsSha256');
    expect(
      pinProvenanceProblems({
        ...unverified,
        signerFingerprints: ['A'.repeat(40)],
      }),
    ).toContain('signerFingerprints');
  });

  // Verification of 26.8.1 is BLOCKED on a machine with gpg (see the header of
  // scripts/update-node-pins.mjs). Until then it stays 'unverified', and no
  // other unverified pin may be added: once a maintainer verifies 26.8.1 this
  // list only shrinks.
  it('keeps the unverified pins to the one known, tracked entry', () => {
    const known = new Set(['26.8.1']);
    const unverified = Object.entries(NODE_PIN_PROVENANCE)
      .filter(([, record]) => record.verification !== 'gpg-verified')
      .map(([version]) => version);
    for (const version of unverified) expect(known.has(version)).toBe(true);
    expect(NODE_PIN_PROVENANCE['26.8.1']?.verification).toBe('unverified');
    expect(
      isGpgVerified(NODE_PIN_PROVENANCE['26.8.1'] as NodePinProvenance),
    ).toBe(false);
  });

  it('looks provenance up like pins and refuses an unpinned version', () => {
    const version = pinnedVersions()[0] as string;
    expect(lookupPinProvenance(version)).toBe(NODE_PIN_PROVENANCE[version]);
    expect(() => lookupPinProvenance('0.0.0')).toThrow(
      expect.objectContaining({ code: 'unpinned_version' }),
    );
    expect(() => lookupPinProvenance('__proto__')).toThrow(
      expect.objectContaining({ code: 'unpinned_version' }),
    );
  });
});
