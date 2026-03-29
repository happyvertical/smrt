import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverSmrtPackages } from '../discover-smrt-packages.js';

describe('discoverSmrtPackages', () => {
  let testDir: string | null = null;

  afterEach(() => {
    if (testDir) {
      rmSync(testDir, { recursive: true, force: true });
      testDir = null;
    }
  });

  it('should prefer the outermost package root when dist/package.json exists', () => {
    testDir = mkdtempSync(join(tmpdir(), 'smrt-discovery-'));
    const originalCwd = process.cwd();
    const packageName = '@happyvertical/smrt-example';
    const packageDir = join(
      testDir,
      'node_modules',
      '@happyvertical',
      'smrt-example',
    );
    const distDir = join(packageDir, 'dist');

    mkdirSync(distDir, { recursive: true });

    writeFileSync(
      join(testDir, 'package.json'),
      JSON.stringify(
        {
          name: 'smrt-discovery-consumer',
          type: 'module',
          dependencies: {
            [packageName]: '1.0.0',
          },
        },
        null,
        2,
      ),
    );

    writeFileSync(
      join(packageDir, 'package.json'),
      JSON.stringify(
        {
          name: packageName,
          type: 'module',
          main: './dist/index.js',
        },
        null,
        2,
      ),
    );

    writeFileSync(
      join(distDir, 'package.json'),
      JSON.stringify(
        {
          name: packageName,
          type: 'module',
          main: './index.js',
        },
        null,
        2,
      ),
    );

    writeFileSync(join(distDir, 'index.js'), 'export {};\n');
    writeFileSync(
      join(distDir, 'manifest.json'),
      JSON.stringify(
        {
          moduleType: 'smrt',
          version: '1.0.0',
          objects: {},
        },
        null,
        2,
      ),
    );

    process.chdir(testDir);

    try {
      const packages = discoverSmrtPackages({ noCache: true });
      expect(packages).toContain(packageName);
    } finally {
      process.chdir(originalCwd);
    }
  });
});
