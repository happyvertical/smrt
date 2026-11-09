import { readFileSync } from 'node:fs';
import { parseBundleManifest } from '../install/bundle-manifest.js';
import type { VerifiedInstallation } from '../install/locate.js';
import { parseSidecarManifest } from '../sidecar-manifest.js';

/**
 * Test-only helpers for the rendezvous tests. Not part of the published API.
 */

export const PRODUCT = 'smrt-notes';
export const BUNDLE = 'com.happyvertical.smrt-notes';
export const ORIGIN = 'http://127.0.0.1:49152';
export const SHELL_EXECUTABLE = '/opt/smrt-notes/smrt-notes';

const example = (name: string) =>
  readFileSync(new URL(`../../examples/${name}`, import.meta.url), 'utf8');

/** A `VerifiedInstallation` whose private state directory is `shellDirectory`. */
export function installationFixture(
  shellDirectory: string,
): VerifiedInstallation {
  return {
    platform: process.platform,
    bundle: parseBundleManifest(example('smrt-bundle.json')),
    sidecar: parseSidecarManifest(example('node26-sidecar.json')),
    installRoot: '/opt/smrt-notes',
    executableDir: '/opt/smrt-notes',
    resourceDir: '/opt/smrt-notes/resources',
    shellExecutable: SHELL_EXECUTABLE,
    shellDirectory,
    nodePath: '/opt/smrt-notes/smrt-start-node',
    bridgePath: '/opt/smrt-notes/resources/bridge/smrt-mcp-bridge.mjs',
    healthRoute: '/api/_runtime/health',
  };
}
