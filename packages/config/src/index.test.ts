import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearCache,
  getConfig,
  getModuleConfig,
  getPackageConfig,
  loadConfig,
  setConfig,
} from './index.js';
import {
  clearRuntimeConfig,
  getRuntimeConfig,
  mergeConfigs,
} from './merge.js';

describe('mergeConfigs', () => {
  it('should not merge null values', () => {
    const result = mergeConfigs(
      { db: { url: ':memory:' }, enabled: true },
      { db: null, enabled: null },
      {},
    );
    expect(result.db).toEqual({ url: ':memory:' });
    expect(result.enabled).toBe(true);
  });

  it('should merge non-null values', () => {
    const result = mergeConfigs(
      { maxItems: 100, enabled: true },
      { maxItems: 200 },
      {},
    );
    expect(result.maxItems).toBe(200);
    expect(result.enabled).toBe(true);
  });

  it('should merge falsy values that are not null', () => {
    const result = mergeConfigs(
      { enabled: true, count: 100, name: 'default' },
      { enabled: false, count: 0, name: '' },
      {},
    );
    expect(result.enabled).toBe(false);
    expect(result.count).toBe(0);
    expect(result.name).toBe('');
  });

  it('does not alias input arrays/objects into the merged result (#1579)', () => {
    const defaults = { features: { list: ['a'] }, kept: { tags: ['k'] } };
    const fileConfig = { extra: { items: ['x'] } };
    const merged = mergeConfigs(defaults, fileConfig, {});

    // Mutating either input after the merge must not change the result.
    defaults.features.list.push('b');
    defaults.kept.tags.push('z');
    fileConfig.extra.items.push('y');
    expect(merged.features.list).toEqual(['a']);
    expect(merged.kept.tags).toEqual(['k']);
    expect(merged.extra.items).toEqual(['x']);

    // ...and mutating the result must not leak back into the inputs.
    (merged.features.list as string[]).push('c');
    expect(defaults.features.list).toEqual(['a', 'b']);
  });

  it('setConfig does not alias the caller input into the runtime store (#1579)', () => {
    clearRuntimeConfig();
    const input = { modules: { demo: { allow: ['one'] } } };
    setConfig(input as Parameters<typeof setConfig>[0]);
    // Mutating the original input must not change the stored runtime config.
    input.modules.demo.allow.push('two');
    const store = getRuntimeConfig() as typeof input;
    expect(store.modules.demo.allow).toEqual(['one']);
    clearRuntimeConfig();
  });

  it('preserves function-valued config by reference, not DataCloneError (#1579)', () => {
    // `modules`/`packages` are `Record<string, unknown>`, so a JS smrt.config
    // may hold callbacks. structuredClone would throw DataCloneError on these;
    // the custom deep clone passes non-plain leaves through by reference.
    const factory = () => 'built';
    const merged = mergeConfigs(
      { modules: {} as Record<string, unknown> },
      { modules: { demo: { factory } } },
      {},
    );
    const demo = (merged.modules as Record<string, { factory: () => string }>)
      .demo;
    expect(demo.factory).toBe(factory);
    expect(demo.factory()).toBe('built');
  });
});

describe('@smrt/config', () => {
  const testDir = join(process.cwd(), '.test-config');
  const configPath = join(testDir, 'smrt.config.js');

  beforeEach(() => {
    // Create test directory
    mkdirSync(testDir, { recursive: true });

    // Clear cache before each test
    clearCache();
  });

  afterEach(() => {
    // Clean up test directory
    rmSync(testDir, { recursive: true, force: true });

    // Clear cache after each test
    clearCache();
  });

  describe('loadConfig', () => {
    it('should load config from smrt.config.js', async () => {
      // Create a test config file
      const configContent = `
        export default {
          smrt: {
            logLevel: 'debug',
            cacheDir: '.cache'
          },
          modules: {
            'test-module': {
              enabled: true,
              maxItems: 100
            }
          }
        };
      `;

      writeFileSync(configPath, configContent, 'utf-8');

      const config = await loadConfig({ configPath, cache: false });

      expect(config.smrt?.logLevel).toBe('debug');
      expect(config.smrt?.cacheDir).toBe('.cache');
      expect(config.modules?.['test-module']).toEqual({
        enabled: true,
        maxItems: 100,
      });
    });

    it('should return empty config when file not found', async () => {
      const config = await loadConfig({
        configPath: join(testDir, 'nonexistent.js'),
        cache: false,
      });

      expect(config).toEqual({});
    });

    it('throws when a config file exists but fails to parse (#1579)', async () => {
      // Unterminated object literal — a syntax error, not a missing file. The
      // loader must surface this rather than silently falling back to {}.
      const badPath = join(testDir, 'broken.config.mjs');
      writeFileSync(badPath, 'export default { smrt: { logLevel:', 'utf-8');

      await expect(
        loadConfig({ configPath: badPath, cache: false }),
      ).rejects.toThrow(/Failed to load smrt config/);
    });

    it('loads a TypeScript smrt.config.ts (#1783)', async () => {
      // Genuinely TS-only syntax (interface, type annotation, `as const`,
      // `satisfies`, and a runtime `process.env` read) — a plain-JSON or
      // untranspiled read would choke on all of these. The SvelteKit template
      // ships its config as `smrt.config.ts`, so the loader must transpile it.
      const tsConfigPath = join(testDir, 'smrt.config.ts');
      process.env.SMRT_TEST_DB_URL = './from-env.db';
      const tsConfigContent = `
        interface DatabaseConfig {
          type: string;
          url: string;
        }
        const dbType: string = 'sqlite';
        export default {
          smrt: {
            logLevel: 'debug' as const,
          },
          packages: {
            cli: {
              database: {
                type: dbType,
                url: process.env.SMRT_TEST_DB_URL ?? './fallback.db',
              } satisfies DatabaseConfig,
            },
          },
        };
      `;
      writeFileSync(tsConfigPath, tsConfigContent, 'utf-8');

      try {
        const config = await loadConfig({
          configPath: tsConfigPath,
          cache: false,
        });

        expect(config.smrt?.logLevel).toBe('debug');
        const cli = config.packages?.cli as
          | { database?: { type?: string; url?: string } }
          | undefined;
        expect(cli?.database?.type).toBe('sqlite');
        expect(cli?.database?.url).toBe('./from-env.db');
      } finally {
        process.env.SMRT_TEST_DB_URL = undefined;
      }
    });

    it('discovers smrt.config.ts via search (#1783)', async () => {
      // The CLI loads config with no explicit path (cosmiconfig search), so the
      // TS extension must be in searchPlaces, not just loadable by path.
      const tsConfigPath = join(testDir, 'smrt.config.ts');
      writeFileSync(
        tsConfigPath,
        `export default { smrt: { logLevel: 'warn' as const } };`,
        'utf-8',
      );

      const config = await loadConfig({
        searchFrom: testDir,
        cache: false,
      });

      expect(config.smrt?.logLevel).toBe('warn');
    });

    it('searchParents: false anchors stopDir to searchFrom, not cwd', async () => {
      // A config exists in the PARENT (testDir) but not in the child searchFrom.
      // With searchParents: false the upward walk must stop at searchFrom (the
      // search root) and NOT climb to the parent — even though searchFrom is
      // outside the cwd tree. Regression for the stopDir=cwd bug.
      writeFileSync(
        join(testDir, 'smrt.config.ts'),
        `export default { smrt: { logLevel: 'error' as const } };`,
        'utf-8',
      );
      const childDir = join(testDir, 'nested', 'child');
      mkdirSync(childDir, { recursive: true });

      const config = await loadConfig({
        searchFrom: childDir,
        searchParents: false,
        cache: false,
      });

      // Parent's config must NOT leak in — no config found from childDir.
      expect(config).toEqual({});
    });
  });

  describe('getModuleConfig', () => {
    it('should merge defaults with file config', async () => {
      // Use unique file path to avoid Node.js ESM module caching
      const testConfigPath = join(testDir, 'smrt-merge-module.config.js');
      const configContent = `
        export default {
          modules: {
            'test-module': {
              maxItems: 200
            }
          }
        };
      `;

      writeFileSync(testConfigPath, configContent, 'utf-8');
      clearCache();
      await loadConfig({ configPath: testConfigPath, cache: false });

      const config = getModuleConfig('test-module', {
        enabled: true,
        maxItems: 100,
      });

      expect(config.enabled).toBe(true);
      expect(config.maxItems).toBe(200); // From file
    });

    it('should inherit global smrt config', async () => {
      // Use unique file path to avoid Node.js ESM module caching
      const testConfigPath = join(testDir, 'smrt-inherit-module.config.js');
      const configContent = `
        export default {
          smrt: {
            logLevel: 'debug'
          },
          modules: {
            'test-module': {
              maxItems: 200
            }
          }
        };
      `;

      writeFileSync(testConfigPath, configContent, 'utf-8');
      clearCache();
      await loadConfig({ configPath: testConfigPath, cache: false });

      const config = getModuleConfig('test-module', {
        logLevel: 'info',
        maxItems: 100,
      });

      expect(config.logLevel).toBe('debug'); // From global
      expect(config.maxItems).toBe(200); // From module
    });

    it('should return defaults when no config loaded', () => {
      const config = getModuleConfig('test-module', {
        enabled: true,
        maxItems: 100,
      });

      expect(config).toEqual({
        enabled: true,
        maxItems: 100,
      });
    });
  });

  describe('getPackageConfig', () => {
    it('should merge defaults with file config', async () => {
      // Use unique file path to avoid Node.js ESM module caching
      const testConfigPath = join(testDir, 'smrt-merge-package.config.js');
      const configContent = `
        export default {
          packages: {
            ai: {
              defaultModel: 'gpt-4'
            }
          }
        };
      `;

      writeFileSync(testConfigPath, configContent, 'utf-8');
      clearCache();
      await loadConfig({ configPath: testConfigPath, cache: false });

      const config = getPackageConfig('ai', {
        defaultProvider: 'openai',
        defaultModel: 'gpt-3.5-turbo',
      });

      expect(config.defaultProvider).toBe('openai');
      expect(config.defaultModel).toBe('gpt-4'); // From file
    });

    it('should inherit global smrt config', async () => {
      // Use unique file path to avoid Node.js ESM module caching
      const testConfigPath = join(testDir, 'smrt-inherit-package.config.js');
      const configContent = `
        export default {
          smrt: {
            logLevel: 'debug'
          },
          packages: {
            spider: {
              headless: false
            }
          }
        };
      `;

      writeFileSync(testConfigPath, configContent, 'utf-8');
      clearCache();
      await loadConfig({ configPath: testConfigPath, cache: false });

      const config = getPackageConfig('spider', {
        logLevel: 'info',
        headless: true,
      });

      expect(config.logLevel).toBe('debug'); // From global
      expect(config.headless).toBe(false); // From package
    });
  });

  describe('setConfig', () => {
    it('should override file config with runtime config', async () => {
      const configContent = `
        export default {
          modules: {
            'test-module': {
              maxItems: 100
            }
          }
        };
      `;

      writeFileSync(configPath, configContent, 'utf-8');
      await loadConfig({ configPath, cache: false });

      setConfig({
        modules: {
          'test-module': {
            maxItems: 500,
          },
        },
      });

      const config = getModuleConfig('test-module', {
        maxItems: 50,
      });

      expect(config.maxItems).toBe(500); // From runtime
    });
  });

  describe('clearCache', () => {
    it('should clear cached config and require new load', async () => {
      // Use unique file path to avoid Node.js ESM module caching
      const testConfigPath = join(testDir, 'smrt-clearcache.config.js');
      const configContent = `
        export default {
          smrt: {
            logLevel: 'debug'
          }
        };
      `;

      writeFileSync(testConfigPath, configContent, 'utf-8');

      // Load config (with caching enabled)
      const config1 = await loadConfig({ configPath: testConfigPath });
      expect(config1.smrt?.logLevel).toBe('debug');

      // Verify config is accessible via getConfig
      expect(getConfig()?.smrt?.logLevel).toBe('debug');

      // Clear cache - should reset state
      clearCache();

      // After clearCache, getConfig should return null
      expect(getConfig()).toBeNull();

      // Can reload config from a new file (simulates file change reload)
      const newConfigPath = join(testDir, 'smrt-clearcache-2.config.js');
      const newConfigContent = `
        export default {
          smrt: {
            logLevel: 'error'
          }
        };
      `;
      writeFileSync(newConfigPath, newConfigContent, 'utf-8');

      const config2 = await loadConfig({
        configPath: newConfigPath,
        cache: false,
      });
      expect(config2.smrt?.logLevel).toBe('error');
    });
  });

  describe('null value handling', () => {
    it('should not override defaults with null values from config', async () => {
      const testConfigPath = join(testDir, 'smrt-null-test1.config.js');
      const configContent = `
        export default {
          modules: {
            'test-module': {
              db: null,
              enabled: null
            }
          }
        };
      `;

      writeFileSync(testConfigPath, configContent, 'utf-8');
      clearCache();
      await loadConfig({ configPath: testConfigPath, cache: false });

      const config = getModuleConfig('test-module', {
        db: { url: 'file:./test.db' },
        enabled: true,
        maxItems: 100,
      });

      // null values should be ignored, defaults should remain
      expect(config.db).toEqual({ url: 'file:./test.db' });
      expect(config.enabled).toBe(true);
      expect(config.maxItems).toBe(100);
    });

    it('should not override defaults with null values in nested config', async () => {
      const testConfigPath = join(testDir, 'smrt-null-test2.config.js');
      const configContent = `
        export default {
          smrt: {
            db: null
          },
          modules: {
            'test-module': {
              maxItems: 200
            }
          }
        };
      `;

      writeFileSync(testConfigPath, configContent, 'utf-8');
      clearCache();
      await loadConfig({ configPath: testConfigPath, cache: false });

      const config = getModuleConfig('test-module', {
        db: { url: ':memory:' },
        maxItems: 100,
      });

      // null in global config should not override module defaults
      expect(config.db).toEqual({ url: ':memory:' });
      // But non-null values should still merge
      expect(config.maxItems).toBe(200);
    });

    it('should allow explicit false, 0, and empty string values', async () => {
      const testConfigPath = join(testDir, 'smrt-null-test3.config.js');
      const configContent = `
        export default {
          modules: {
            'test-module': {
              enabled: false,
              maxItems: 0,
              name: ''
            }
          }
        };
      `;

      writeFileSync(testConfigPath, configContent, 'utf-8');
      clearCache();
      await loadConfig({ configPath: testConfigPath, cache: false });

      const config = getModuleConfig('test-module', {
        enabled: true,
        maxItems: 100,
        name: 'default',
      });

      // Falsy values that are not null/undefined should override
      expect(config.enabled).toBe(false);
      expect(config.maxItems).toBe(0);
      expect(config.name).toBe('');
    });
  });

  describe('cross-module config sharing (issue #543)', () => {
    /**
     * Tests for globalThis-based config caching.
     * This ensures that loadConfig() in smrt-cli affects all packages
     * that use smrt-config, even when loaded from different paths
     * (e.g., pnpm store vs workspace symlink).
     *
     * @see https://github.com/happyvertical/smrt/issues/543
     */

    it('should store config in globalThis after loadConfig', async () => {
      const testConfigPath = join(testDir, 'smrt-globalthis-1.config.js');
      const configContent = `
        export default {
          smrt: { logLevel: 'debug' },
          modules: { 'test-module': { enabled: true } }
        };
      `;

      writeFileSync(testConfigPath, configContent, 'utf-8');
      clearCache();
      await loadConfig({ configPath: testConfigPath, cache: false });

      // Verify globalThis cache is populated
      expect(globalThis.__smrtConfigCache).not.toBeNull();
      expect(globalThis.__smrtConfigCache?.smrt?.logLevel).toBe('debug');
    });

    it('should return config from globalThis via getConfig', async () => {
      const testConfigPath = join(testDir, 'smrt-globalthis-2.config.js');
      const configContent = `
        export default {
          smrt: { cacheDir: '.test-cache' }
        };
      `;

      writeFileSync(testConfigPath, configContent, 'utf-8');
      clearCache();
      await loadConfig({ configPath: testConfigPath, cache: false });

      // getConfig should read from globalThis
      const config = getConfig();
      expect(config).not.toBeNull();
      expect(config?.smrt?.cacheDir).toBe('.test-cache');
    });

    it('should clear globalThis cache on clearCache', async () => {
      const testConfigPath = join(testDir, 'smrt-globalthis-3.config.js');
      const configContent = `
        export default {
          smrt: { logLevel: 'info' }
        };
      `;

      writeFileSync(testConfigPath, configContent, 'utf-8');
      clearCache();
      await loadConfig({ configPath: testConfigPath, cache: false });

      // Verify config is loaded
      expect(globalThis.__smrtConfigCache).not.toBeNull();

      // Clear cache
      clearCache();

      // Verify globalThis cache is cleared
      expect(globalThis.__smrtConfigCache).toBeNull();
      expect(getConfig()).toBeNull();
    });

    it('should share config across getModuleConfig calls after loadConfig', async () => {
      const testConfigPath = join(testDir, 'smrt-globalthis-4.config.js');
      const configContent = `
        export default {
          modules: {
            'external-package': { apiKey: 'test-key-123' }
          }
        };
      `;

      writeFileSync(testConfigPath, configContent, 'utf-8');
      clearCache();
      await loadConfig({ configPath: testConfigPath, cache: false });

      // Simulate external package calling getModuleConfig
      // (would previously get defaults due to separate module instance)
      const config = getModuleConfig('external-package', {
        apiKey: 'default-key',
        timeout: 5000,
      });

      // Should receive the loaded config, not defaults
      expect(config.apiKey).toBe('test-key-123');
      expect(config.timeout).toBe(5000); // Default for unspecified field
    });

    it('should return null from getConfig before loadConfig is called', () => {
      // After clearCache in beforeEach, getConfig should return null
      const config = getConfig();
      expect(config).toBeNull();
    });
  });
});
