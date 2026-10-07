import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { clearConfigCache, loadConfig } from './loader.browser.js';

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('browser config loader (#2838)', () => {
  afterEach(() => {
    clearConfigCache();
  });

  it('resolves to an empty config, like a project with no config file', async () => {
    await expect(loadConfig()).resolves.toEqual({});
    expect(globalThis.__smrtLoaderCachedConfig).toEqual({});
  });

  it('does not populate the cache when caching is off', async () => {
    await expect(loadConfig({ cache: false })).resolves.toEqual({});
    expect(globalThis.__smrtLoaderCachedConfig ?? null).toBeNull();
  });

  it('refuses an explicit file instead of reporting it absent', async () => {
    await expect(
      loadConfig({ configPath: './smrt.config.ts' }),
    ).rejects.toThrow(/cannot be read in a browser/);
  });

  it('clears the shared cache', async () => {
    await loadConfig();
    clearConfigCache();
    expect(globalThis.__smrtLoaderCachedConfig).toBeNull();
  });
});

describe('package.json browser field', () => {
  it('swaps loader.js for a build that exists', () => {
    const manifest = JSON.parse(
      readFileSync(resolve(packageDir, 'package.json'), 'utf8'),
    ) as { browser?: Record<string, string> };
    expect(manifest.browser).toEqual({
      './dist/loader.js': './dist/loader.browser.js',
    });
    for (const name of ['loader', 'loader.browser']) {
      expect(existsSync(resolve(packageDir, 'src', `${name}.ts`))).toBe(true);
    }
  });
});
