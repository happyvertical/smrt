/**
 * Tests for vitePluginAgentRoutes virtual module generation.
 */

import { describe, expect, it } from 'vitest';
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
});
