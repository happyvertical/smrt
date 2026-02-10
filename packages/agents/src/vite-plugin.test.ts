/**
 * Tests for vitePluginAgentRoutes virtual module generation.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { vitePluginAgentRoutes } from './vite-plugin.js';

describe('vitePluginAgentRoutes', () => {
  it('should return a plugin with the correct name', () => {
    const plugin = vitePluginAgentRoutes();
    expect(plugin.name).toBe('smrt-agent-routes');
  });

  it('should resolve virtual:smrt-agent-registrations', () => {
    const plugin = vitePluginAgentRoutes();
    expect(plugin.resolveId('virtual:smrt-agent-registrations')).toBe(
      '\0virtual:smrt-agent-registrations',
    );
  });

  it('should not resolve other module IDs', () => {
    const plugin = vitePluginAgentRoutes();
    expect(plugin.resolveId('some-other-module')).toBeUndefined();
  });

  it('should return a no-op module when no agents are configured', () => {
    const plugin = vitePluginAgentRoutes();
    const code = plugin.load('\0virtual:smrt-agent-registrations');

    expect(code).toBeDefined();
    expect(code).toContain('No agents configured');
    expect(code).toContain('initializeAgentRegistrations');
  });

  it('should not load non-virtual module IDs', () => {
    const plugin = vitePluginAgentRoutes();
    expect(plugin.load('some-other-module')).toBeUndefined();
  });

  describe('admin export detection', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'smrt-vite-test-'));
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    function setupFakePackage(opts: {
      name: string;
      hasAdminExport: boolean;
      agentClassName: string;
    }) {
      const pkgDir = join(tmpDir, 'node_modules', ...opts.name.split('/'));
      const distDir = join(pkgDir, 'dist');
      mkdirSync(distDir, { recursive: true });

      const exports: Record<string, unknown> = {
        '.': { import: './dist/index.js' },
        './manifest': './dist/manifest.json',
      };
      if (opts.hasAdminExport) {
        exports['./admin'] = {
          svelte: './dist/ui/admin/index.js',
          import: './dist/ui/admin/index.js',
        };
      }

      writeFileSync(
        join(pkgDir, 'package.json'),
        JSON.stringify({ name: opts.name, exports }),
      );
      writeFileSync(join(distDir, 'index.js'), 'export default {};\n');
      writeFileSync(
        join(distDir, 'manifest.json'),
        JSON.stringify({
          objects: {
            [opts.agentClassName]: {
              className: opts.agentClassName,
              agent: {
                name: opts.agentClassName,
                slug: opts.agentClassName.toLowerCase(),
                tier: 'core',
                uiSlots: {},
              },
            },
          },
        }),
      );

      // Project-level package.json so createRequire can resolve from it
      writeFileSync(
        join(tmpDir, 'package.json'),
        JSON.stringify({ name: 'test-project' }),
      );

      // smrt.config.js with the agent
      writeFileSync(
        join(tmpDir, 'smrt.config.js'),
        `export default { agents: ['${opts.name}'] };`,
      );
    }

    it('should emit admin import when package has ./admin export', () => {
      setupFakePackage({
        name: '@test/with-admin',
        hasAdminExport: true,
        agentClassName: 'TestAgent',
      });

      const plugin = vitePluginAgentRoutes({
        configPath: join(tmpDir, 'smrt.config.js'),
      });
      plugin.configResolved?.({ root: tmpDir });

      const code = plugin.load('\0virtual:smrt-agent-registrations');
      expect(code).toContain("import '@test/with-admin/admin';");
      expect(code).not.toContain('not available');
    });

    it('should emit "not available" comment when package lacks ./admin export', () => {
      setupFakePackage({
        name: '@test/no-admin',
        hasAdminExport: false,
        agentClassName: 'NoAdminAgent',
      });

      const plugin = vitePluginAgentRoutes({
        configPath: join(tmpDir, 'smrt.config.js'),
      });
      plugin.configResolved?.({ root: tmpDir });

      const code = plugin.load('\0virtual:smrt-agent-registrations');
      expect(code).toContain('@test/no-admin/admin — not available');
      expect(code).not.toContain("import '@test/no-admin/admin';");
    });
  });
});
