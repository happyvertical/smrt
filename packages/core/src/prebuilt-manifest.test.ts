import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  loadVerifiedSmrtPrebuiltManifest,
  serializeSmrtPrebuiltManifest,
  sha256SmrtPrebuiltManifest,
} from './prebuilt-manifest.js';

describe('verified prebuilt manifests', () => {
  let projectRoot: string;
  const provenance = 'git-tree:0123456789abcdef';
  const manifest = {
    version: '1.0.0',
    timestamp: 0,
    packageName: '@fixture/app',
    objects: {},
  };

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'smrt-prebuilt-'));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  function writeArtifact(
    contents = serializeSmrtPrebuiltManifest(manifest, provenance),
  ) {
    const path = join(projectRoot, 'context.json');
    writeFileSync(path, contents);
    return {
      path: 'context.json',
      sha256: sha256SmrtPrebuiltManifest(readFileSync(path)),
      provenance,
    };
  }

  it('loads exact bytes with matching caller-provided provenance', () => {
    const options = writeArtifact();
    expect(
      loadVerifiedSmrtPrebuiltManifest<typeof manifest>(options, projectRoot),
    ).toEqual(manifest);
  });

  it('fails closed when the artifact is missing', () => {
    expect(() =>
      loadVerifiedSmrtPrebuiltManifest(
        {
          path: 'missing.json',
          sha256: `sha256:${'0'.repeat(64)}`,
          provenance,
        },
        projectRoot,
      ),
    ).toThrow(/Unable to read prebuilt manifest artifact/);
  });

  it('rejects artifact byte drift before parsing', () => {
    const options = writeArtifact();
    writeFileSync(join(projectRoot, 'context.json'), '{}\n');
    expect(() =>
      loadVerifiedSmrtPrebuiltManifest(options, projectRoot),
    ).toThrow(/digest mismatch/);
  });

  it('rejects malformed and structurally invalid artifacts', () => {
    const malformed = writeArtifact('{');
    expect(() =>
      loadVerifiedSmrtPrebuiltManifest(malformed, projectRoot),
    ).toThrow(/not valid JSON/);

    const invalid = writeArtifact(
      JSON.stringify({ schemaVersion: 1, provenance, manifest: {} }),
    );
    expect(() =>
      loadVerifiedSmrtPrebuiltManifest(invalid, projectRoot),
    ).toThrow(/does not contain a valid manifest/);
  });

  it('rejects stale provenance even when artifact bytes match', () => {
    const options = writeArtifact();
    expect(() =>
      loadVerifiedSmrtPrebuiltManifest(
        { ...options, provenance: 'git-tree:different' },
        projectRoot,
      ),
    ).toThrow(/provenance mismatch/);
  });

  it('requires canonical digest and non-empty provenance inputs', () => {
    const options = writeArtifact();
    expect(() =>
      loadVerifiedSmrtPrebuiltManifest(
        { ...options, sha256: options.sha256.slice(7) },
        projectRoot,
      ),
    ).toThrow(/sha256:<64 lowercase hex characters>/);
    expect(() =>
      loadVerifiedSmrtPrebuiltManifest(
        { ...options, provenance: '' },
        projectRoot,
      ),
    ).toThrow(/provenance is required/);
  });
});
