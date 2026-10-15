import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  importConsumerPackage,
  resolveConsumerPackageEntry,
} from './consumer-package.js';

describe('consumer package loading', () => {
  let projectRoot = '';

  afterEach(async () => {
    if (projectRoot) await rm(projectRoot, { force: true, recursive: true });
    projectRoot = '';
  });

  it('loads an ESM-only package from the invoking project node_modules', async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'smrt-cli-consumer-'));
    const packageRoot = join(
      projectRoot,
      'node_modules',
      '@happyvertical',
      'smrt-commerce',
    );
    await mkdir(join(packageRoot, 'dist'), { recursive: true });
    await writeFile(join(projectRoot, 'package.json'), '{"type":"module"}');
    await writeFile(
      join(packageRoot, 'package.json'),
      JSON.stringify({
        name: '@happyvertical/smrt-commerce',
        type: 'module',
        exports: { '.': { import: './dist/index.js' } },
      }),
    );
    await writeFile(
      join(packageRoot, 'dist/index.js'),
      'export const provider = "consumer-commerce";\n',
    );

    expect(
      await resolveConsumerPackageEntry(
        '@happyvertical/smrt-commerce',
        projectRoot,
      ),
    ).toBe(join(packageRoot, 'dist/index.js'));
    const provider = await importConsumerPackage<{ provider: string }>(
      '@happyvertical/smrt-commerce',
      projectRoot,
    );
    expect(provider.provider).toBe('consumer-commerce');
  });

  it('fails clearly when the invoking project did not install the provider', async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'smrt-cli-consumer-'));
    await writeFile(join(projectRoot, 'package.json'), '{}');
    await expect(
      resolveConsumerPackageEntry('@happyvertical/smrt-commerce', projectRoot),
    ).rejects.toThrow('is not installed');
  });
});
