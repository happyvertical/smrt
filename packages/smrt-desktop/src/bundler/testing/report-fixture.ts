import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type BundleReportV1, serializeBundleReport } from '../report.js';

export const sha = (c: string): string => c.repeat(64);

export function sampleBundleReport(): BundleReportV1 {
  return {
    version: 1,
    tool: { name: '@happyvertical/smrt-desktop', version: '0.60.14' },
    product: {
      productId: 'smrt-start',
      bundleId: 'com.happyvertical.smrt-start',
      displayName: 'SMRT Start',
      productVersion: '1.2.3',
      channel: 'stable',
    },
    target: 'aarch64-apple-darwin',
    host: {
      platform: 'darwin',
      arch: 'arm64',
      node: '26.8.1',
      pnpm: '11.25.0',
    },
    inputs: {
      packageJsonSha256: sha('1'),
      lockfileSha256: sha('2'),
      buildTreeSha256: sha('3'),
    },
    node: {
      version: '26.8.1',
      distFile: 'node-v26.8.1-darwin-arm64.tar.gz',
      archiveSha256: sha('4'),
      binarySha256: sha('5'),
      machine: 'arm64',
      pin: {
        verification: 'unverified',
        source: 'https://nodejs.org/dist/v26.8.1/SHASUMS256.txt',
        retrieved: '2026-11-09T00:43:17Z',
        shasumsSha256: sha('a'),
        signerFingerprints: [],
      },
    },
    bridge: { file: 'bridge/smrt-mcp-bridge.mjs', sha256: sha('6'), bytes: 10 },
    features: {
      enabled: ['ai-providers'],
      removedPackages: [],
      acknowledgedDynamicImports: [],
    },
    importScan: {
      filesReached: 9,
      loadTimeFiles: 4,
      unresolvedBareImports: 1,
      nonLiteralImports: 0,
      unscannedFiles: 0,
    },
    packages: [
      { name: 'a', version: '1.0.0', path: 'resources/app/node_modules/a' },
      { name: 'b', version: '1.0.0', path: 'resources/app/node_modules/b' },
    ],
    natives: [],
    nativeExceptions: [],
    pruned: {
      files: 1,
      bytes: 2,
      removedPackageFiles: 3,
      removedPackageBytes: 4,
    },
    files: {
      count: 2,
      bytes: 20,
      listSha256: sha('7'),
      tauriBundleSha256: sha('8'),
      breakdown: { nodeBinary: 10, nodeModules: 5, appBuild: 4, other: 1 },
    },
  };
}

/**
 * Lay out `dir` as the output of an earlier bundle run: the documented
 * top-level names with a schema-valid `bundle-report.json`.
 */
export function writeEarlierBundle(dir: string): void {
  mkdirSync(join(dir, 'binaries'), { recursive: true });
  mkdirSync(join(dir, 'resources'), { recursive: true });
  writeFileSync(join(dir, 'binaries', 'old-node'), 'old');
  writeFileSync(join(dir, 'resources', 'old.txt'), 'old');
  writeFileSync(join(dir, 'tauri.bundle.json'), '{}\n');
  writeFileSync(join(dir, 'bundle-files.sha256'), '');
  writeFileSync(
    join(dir, 'bundle-report.json'),
    serializeBundleReport(sampleBundleReport()),
  );
}
