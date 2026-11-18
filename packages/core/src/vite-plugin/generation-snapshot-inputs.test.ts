/**
 * A generation snapshot serialized with `projectRoot` digests every input of
 * the project scan, not only model source files: the source set (so an added
 * model counts), package.json, recipe help files, and dependency manifests.
 * Reuse fails closed when any of them changed since the snapshot was made.
 * Dev rescans also fire on a recipe help file edit (#3596).
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  loadVerifiedSmrtGenerationSnapshot,
  readSmrtGenerationInputs,
  serializeSmrtGenerationSnapshot,
  sha256SmrtGenerationSnapshot,
} from '../generation-snapshot.js';
import { smrtPlugin } from './index.js';

const CORE = '@happyvertical/smrt-core';
const PROVIDER = '@acme/snapshot-provider';
const provenance = 'git-tree:snapshot-inputs';

const ORDER = `import { SmrtObject, smrt } from '${CORE}';

@smrt({ api: { include: ['list', 'get'] } })
export class SnapshotOrder extends SmrtObject {
  status: string = 'draft';
  notes: string = '';
}
`;

const RECIPE = `import { SmrtRecipe } from '${CORE}';
import { SnapshotOrder } from './models/SnapshotOrder.js';

export class SnapshotSalesRecipe extends SmrtRecipe {
  static id = 'snapshot.sales';
  static label = 'Sales';
  static summary = 'Take orders.';
  static models = [SnapshotOrder];
  static help = './sales.recipe.md';
}
`;

let projectRoot: string;

function write(path: string, content: string): void {
  const full = join(projectRoot, path);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
}

function scanPlugin(extra: Record<string, unknown> = {}) {
  return smrtPlugin({
    include: ['src/**/*.ts'],
    generateTypes: false,
    ...extra,
  });
}

async function runConfigResolved(plugin: unknown): Promise<void> {
  await (plugin as any).configResolved({
    root: projectRoot,
    build: {},
    plugins: [{ name: 'smrt-consumer' }],
  });
}

/** Serialize the current `.smrt/manifest.json` with every recorded input. */
function snapshot() {
  const manifest = JSON.parse(
    readFileSync(join(projectRoot, '.smrt/manifest.json'), 'utf-8'),
  );
  const contents = serializeSmrtGenerationSnapshot(manifest, provenance, {
    sourceRoot: projectRoot,
    projectRoot,
  });
  writeFileSync(join(projectRoot, 'snapshot.json'), contents);
  return {
    path: 'snapshot.json',
    sha256: sha256SmrtGenerationSnapshot(contents),
    provenance,
    sourceRoot: projectRoot,
  };
}

beforeEach(async () => {
  projectRoot = mkdtempSync(join(tmpdir(), 'smrt-snapshot-inputs-'));
  write(
    'package.json',
    JSON.stringify({ name: '@fixture/snapshot-inputs', version: '1.0.0' }),
  );
  write('src/models/SnapshotOrder.ts', ORDER);
  write('src/recipes.ts', RECIPE);
  write('src/sales.recipe.md', 'Set {field:status} before you ship.\n');
  write(
    `node_modules/${PROVIDER}/package.json`,
    JSON.stringify({
      name: PROVIDER,
      version: '1.0.0',
      exports: { './manifest.json': './dist/manifest.json' },
    }),
  );
  write(
    `node_modules/${PROVIDER}/dist/manifest.json`,
    JSON.stringify({ moduleType: 'smrt', packageName: PROVIDER, objects: {} }),
  );
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  await runConfigResolved(scanPlugin());
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('generation snapshot inputs', () => {
  it('records every scan input beside the local manifest', () => {
    const inputs = readSmrtGenerationInputs(projectRoot);
    expect(inputs.sources).toEqual([
      join(projectRoot, 'src/models/SnapshotOrder.ts'),
      join(projectRoot, 'src/recipes.ts'),
    ]);
    expect(inputs.files).toEqual([
      join(projectRoot, 'package.json'),
      join(projectRoot, 'src/sales.recipe.md'),
    ]);
    expect(Object.keys(inputs.dependencies)).toEqual([PROVIDER]);
  });

  it('reuses an unchanged snapshot', async () => {
    const generationSnapshot = snapshot();
    await expect(
      runConfigResolved(scanPlugin({ generationSnapshot })),
    ).resolves.toBeUndefined();
    expect(
      Object.keys(
        loadVerifiedSmrtGenerationSnapshot<{ objects: object }>(
          generationSnapshot,
          projectRoot,
        ).objects,
      ),
    ).toContain('@fixture/snapshot-inputs:SnapshotOrder');
  });

  it.each([
    [
      'an added model',
      () =>
        write(
          'src/models/SnapshotRefund.ts',
          ORDER.replaceAll('SnapshotOrder', 'SnapshotRefund'),
        ),
      /source set changed.*added: .*SnapshotRefund\.ts/,
    ],
    [
      'a package.json edit',
      () =>
        write(
          'package.json',
          JSON.stringify({
            name: '@fixture/snapshot-inputs',
            version: '1.0.0',
            exports: { '.': './dist/index.js' },
          }),
        ),
      /input changed: .*package\.json/,
    ],
    [
      'a recipe help file edit',
      () => write('src/sales.recipe.md', 'Set {field:notes} instead.\n'),
      /input changed: .*sales\.recipe\.md/,
    ],
    [
      'a rebuilt dependency manifest',
      () =>
        write(
          `node_modules/${PROVIDER}/dist/manifest.json`,
          JSON.stringify({
            moduleType: 'smrt',
            packageName: PROVIDER,
            objects: { [`${PROVIDER}:Added`]: { className: 'Added' } },
          }),
        ),
      /dependency manifest changed for @acme\/snapshot-provider/,
    ],
  ])('refuses to reuse a snapshot after %s', async (_label, change, error) => {
    const generationSnapshot = snapshot();
    change();
    await expect(
      runConfigResolved(scanPlugin({ generationSnapshot })),
    ).rejects.toThrow(error);
  });

  it('keeps verifying a snapshot serialized without projectRoot against model sources only', () => {
    const manifest = JSON.parse(
      readFileSync(join(projectRoot, '.smrt/manifest.json'), 'utf-8'),
    );
    const contents = serializeSmrtGenerationSnapshot(manifest, provenance, {
      sourceRoot: projectRoot,
    });
    expect(JSON.parse(contents)).not.toHaveProperty('inputs');
    writeFileSync(join(projectRoot, 'legacy.json'), contents);
    write('src/sales.recipe.md', 'Changed.\n');
    expect(() =>
      loadVerifiedSmrtGenerationSnapshot(
        {
          path: 'legacy.json',
          sha256: sha256SmrtGenerationSnapshot(contents),
          provenance,
          sourceRoot: projectRoot,
        },
        projectRoot,
      ),
    ).not.toThrow();
  });
});
