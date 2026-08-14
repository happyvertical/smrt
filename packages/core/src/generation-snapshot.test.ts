import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  loadVerifiedSmrtGenerationSnapshot,
  serializeSmrtGenerationSnapshot,
  sha256SmrtGenerationSnapshot,
} from './generation-snapshot.js';

describe('verified generation snapshots', () => {
  let projectRoot: string;
  const provenance = 'git-tree:0123456789abcdef';
  const manifest = {
    version: '1.0.0',
    timestamp: 0,
    packageName: '@fixture/app',
    objects: {
      '@fixture/app:LocalThing': {
        className: 'LocalThing',
        packageName: '@fixture/app',
        filePath: '',
      },
      '@fixture/dependency:ExternalThing': {
        className: 'ExternalThing',
        packageName: '@fixture/dependency',
        filePath: '/published/build/ExternalThing.ts',
      },
    },
  };

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'smrt-prebuilt-'));
    manifest.objects['@fixture/app:LocalThing'].filePath = join(
      projectRoot,
      'src/LocalThing.ts',
    );
    mkdirSync(join(projectRoot, 'src'), { recursive: true });
    writeFileSync(join(projectRoot, 'src/LocalThing.ts'), 'export {};\n');
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  function writeArtifact(
    contents = serializeSmrtGenerationSnapshot(manifest, provenance, {
      sourceRoot: projectRoot,
    }),
  ) {
    const path = join(projectRoot, 'context.json');
    writeFileSync(path, contents);
    return {
      path: 'context.json',
      sha256: sha256SmrtGenerationSnapshot(readFileSync(path)),
      provenance,
      sourceRoot: projectRoot,
    };
  }

  it('loads exact bytes with matching caller-provided provenance', () => {
    const options = writeArtifact();
    expect(
      loadVerifiedSmrtGenerationSnapshot<typeof manifest>(options, projectRoot),
    ).toEqual(manifest);
  });

  it('fails closed when the artifact is missing', () => {
    expect(() =>
      loadVerifiedSmrtGenerationSnapshot(
        {
          path: 'missing.json',
          sha256: `sha256:${'0'.repeat(64)}`,
          provenance,
          sourceRoot: projectRoot,
        },
        projectRoot,
      ),
    ).toThrow(/Unable to read generation snapshot/);
  });

  it('rejects artifact byte drift before parsing', () => {
    const options = writeArtifact();
    writeFileSync(join(projectRoot, 'context.json'), '{}\n');
    expect(() =>
      loadVerifiedSmrtGenerationSnapshot(options, projectRoot),
    ).toThrow(/digest mismatch/);
  });

  it('rejects malformed and structurally invalid artifacts', () => {
    const malformed = writeArtifact('{');
    expect(() =>
      loadVerifiedSmrtGenerationSnapshot(malformed, projectRoot),
    ).toThrow(/not valid JSON/);

    const invalid = writeArtifact(
      JSON.stringify({
        schemaVersion: 1,
        provenance,
        pathMode: 'source-root-relative',
        manifest: {},
      }),
    );
    expect(() =>
      loadVerifiedSmrtGenerationSnapshot(invalid, projectRoot),
    ).toThrow(/does not contain a valid manifest/);
  });

  it('rejects stale provenance even when artifact bytes match', () => {
    const options = writeArtifact();
    expect(() =>
      loadVerifiedSmrtGenerationSnapshot(
        { ...options, provenance: 'git-tree:different' },
        projectRoot,
      ),
    ).toThrow(/provenance mismatch/);
  });

  it('rejects a snapshot when its portable source file is absent', () => {
    const options = writeArtifact();
    rmSync(join(projectRoot, 'src/LocalThing.ts'));

    expect(() =>
      loadVerifiedSmrtGenerationSnapshot(options, projectRoot),
    ).toThrow(/source path is missing/);
  });

  it('requires canonical digest and non-empty provenance inputs', () => {
    const options = writeArtifact();
    expect(() =>
      loadVerifiedSmrtGenerationSnapshot(
        { ...options, sha256: options.sha256.slice(7) },
        projectRoot,
      ),
    ).toThrow(/sha256:<64 lowercase hex characters>/);
    expect(() =>
      loadVerifiedSmrtGenerationSnapshot(
        { ...options, provenance: '' },
        projectRoot,
      ),
    ).toThrow(/provenance is required/);
  });

  it('rebases portable source paths and selects plugin-specific views', () => {
    const options = writeArtifact();
    const nextRoot = mkdtempSync(join(tmpdir(), 'smrt-prebuilt-consumer-'));

    try {
      mkdirSync(join(nextRoot, 'src'), { recursive: true });
      writeFileSync(join(nextRoot, 'src/LocalThing.ts'), 'export {};\n');
      const rebasedOptions = { ...options, sourceRoot: nextRoot };
      const project = loadVerifiedSmrtGenerationSnapshot<typeof manifest>(
        rebasedOptions,
        projectRoot,
        'project',
      );
      const dependencies = loadVerifiedSmrtGenerationSnapshot<typeof manifest>(
        rebasedOptions,
        projectRoot,
        'dependencies',
      );

      expect(Object.keys(project.objects)).toEqual(['@fixture/app:LocalThing']);
      expect(project.objects['@fixture/app:LocalThing'].filePath).toBe(
        join(nextRoot, 'src/LocalThing.ts'),
      );
      expect(Object.keys(dependencies.objects)).toEqual([
        '@fixture/dependency:ExternalThing',
      ]);
      expect(
        dependencies.objects['@fixture/dependency:ExternalThing'].filePath,
      ).toBe('/published/build/ExternalThing.ts');
    } finally {
      rmSync(nextRoot, { recursive: true, force: true });
    }
  });
});
