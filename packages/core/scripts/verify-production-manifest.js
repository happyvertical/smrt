import { readFileSync } from 'node:fs';

/** Reject test authority even when prepack reuses an earlier CI build. */
export function verifyProductionManifest(manifestPath) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (
    manifest.artifactPurpose === 'test' ||
    !manifest.objects ||
    typeof manifest.objects !== 'object' ||
    Array.isArray(manifest.objects)
  ) {
    throw new Error(`Invalid production manifest: ${manifestPath}`);
  }
  for (const [identity, object] of Object.entries(manifest.objects)) {
    const path = String(object.filePath ?? '').replaceAll('\\', '/');
    if (
      /(?:^|\/)(?:__tests__|__test-[^/]+)(?:\/|$)/.test(path) ||
      /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path)
    ) {
      throw new Error(
        `Test fixture in production manifest: ${identity} (${path})`,
      );
    }
  }
}
