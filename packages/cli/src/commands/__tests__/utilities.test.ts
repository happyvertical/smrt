import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveVitestEntrypoint } from '../utilities.js';

describe('utilities', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
    );
    tempDirs.length = 0;
  });

  it('resolves vitest from nested project directories without a local node_modules', async () => {
    const tempRoot = await mkdtemp(
      resolve(process.cwd(), '.tmp-resolve-vitest-'),
    );
    tempDirs.push(tempRoot);

    const nestedProjectDir = resolve(tempRoot, 'apps', 'example');
    await mkdir(nestedProjectDir, { recursive: true });
    await writeFile(
      resolve(nestedProjectDir, 'package.json'),
      JSON.stringify({ name: 'example', private: true }),
    );

    const vitestEntrypoint = resolveVitestEntrypoint(nestedProjectDir);

    await access(vitestEntrypoint);
    expect(vitestEntrypoint).toMatch(/vitest[\\/]vitest\.mjs$/);
  });
});
