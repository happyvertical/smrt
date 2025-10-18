import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearCache,
  getModuleConfig,
  getPackageConfig,
  loadConfig,
  setConfig,
} from './index.js';

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
  });

  describe('getModuleConfig', () => {
    it.skip('should merge defaults with file config', async () => {
      const configContent = `
        export default {
          modules: {
            'test-module': {
              maxItems: 200
            }
          }
        };
      `;

      writeFileSync(configPath, configContent, 'utf-8');
      await loadConfig({ configPath, cache: false });

      const config = getModuleConfig('test-module', {
        enabled: true,
        maxItems: 100,
      });

      expect(config.enabled).toBe(true);
      expect(config.maxItems).toBe(200); // From file
    });

    it.skip('should inherit global smrt config', async () => {
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

      writeFileSync(configPath, configContent, 'utf-8');
      await loadConfig({ configPath, cache: false });

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
    it.skip('should merge defaults with file config', async () => {
      const configContent = `
        export default {
          packages: {
            ai: {
              defaultModel: 'gpt-4'
            }
          }
        };
      `;

      writeFileSync(configPath, configContent, 'utf-8');
      await loadConfig({ configPath, cache: false });

      const config = getPackageConfig('ai', {
        defaultProvider: 'openai',
        defaultModel: 'gpt-3.5-turbo',
      });

      expect(config.defaultProvider).toBe('openai');
      expect(config.defaultModel).toBe('gpt-4'); // From file
    });

    it.skip('should inherit global smrt config', async () => {
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

      writeFileSync(configPath, configContent, 'utf-8');
      await loadConfig({ configPath, cache: false });

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
    it.skip('should clear cached config', async () => {
      const configContent = `
        export default {
          smrt: {
            logLevel: 'debug'
          }
        };
      `;

      writeFileSync(configPath, configContent, 'utf-8');

      const config1 = await loadConfig({ configPath });
      expect(config1.smrt?.logLevel).toBe('debug');

      // Modify file
      const newConfigContent = `
        export default {
          smrt: {
            logLevel: 'error'
          }
        };
      `;
      writeFileSync(configPath, newConfigContent, 'utf-8');

      // Should still return cached config
      const config2 = await loadConfig({ configPath });
      expect(config2.smrt?.logLevel).toBe('debug');

      // Clear cache and reload
      clearCache();
      const config3 = await loadConfig({ configPath, cache: false });
      expect(config3.smrt?.logLevel).toBe('error');
    });
  });
});
