import { describe, expect, it } from 'vitest';
import { NODE_DIST_MESSAGES, NodeDistError } from './node-errors.js';
import {
  isSha256Hex,
  lookupPin,
  NODE_PINS,
  pinnedVersions,
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
});
