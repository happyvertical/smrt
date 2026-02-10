/**
 * Tests for server-side manifest utilities.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentUIRegistry } from '../ui.js';
import {
  extractAgentManifest,
  extractAgentPackagesFromConfig,
  loadManifestsFromConfig,
  loadManifestsFromPackages,
} from './manifest-utils.js';

describe('extractAgentManifest', () => {
  it('should extract agent manifest by class name', () => {
    const manifest = {
      objects: {
        Praeco: {
          className: 'Praeco',
          agent: {
            name: 'Praeco',
            slug: 'praeco',
            tier: 'standard' as const,
            uiSlots: {},
            permissions: [],
            features: [],
            menuItems: [],
            components: [],
          },
        },
      },
    };

    const result = extractAgentManifest(manifest, 'Praeco');
    expect(result).not.toBeNull();
    expect(result?.name).toBe('Praeco');
    expect(result?.slug).toBe('praeco');
  });

  it('should return null when agent class not found', () => {
    const manifest = {
      objects: {
        Praeco: {
          className: 'Praeco',
          agent: {
            name: 'Praeco',
            slug: 'praeco',
            tier: 'standard' as const,
            uiSlots: {},
            permissions: [],
            features: [],
            menuItems: [],
            components: [],
          },
        },
      },
    };

    expect(extractAgentManifest(manifest, 'Caelus')).toBeNull();
  });

  it('should return null when object has no agent metadata', () => {
    const manifest = {
      objects: {
        SomeHelper: {
          className: 'SomeHelper',
        },
      },
    };

    expect(extractAgentManifest(manifest, 'SomeHelper')).toBeNull();
  });

  it('should skip objects that match class name but have no agent field', () => {
    const manifest = {
      objects: {
        AgentConfig: {
          className: 'AgentConfig',
        },
        Praeco: {
          className: 'Praeco',
          agent: {
            name: 'Praeco',
            slug: 'praeco',
            tier: 'free' as const,
            uiSlots: {},
            permissions: [],
            features: [],
            menuItems: [],
            components: [],
          },
        },
      },
    };

    const result = extractAgentManifest(manifest, 'AgentConfig');
    expect(result).toBeNull();
  });

  it('should handle empty objects map', () => {
    expect(extractAgentManifest({ objects: {} }, 'Anything')).toBeNull();
  });
});

describe('extractAgentPackagesFromConfig', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'smrt-manifest-utils-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should extract package names from agents array', () => {
    writeFileSync(
      join(tmpDir, 'smrt.config.js'),
      `export default {
        agents: [
          '@happyvertical/praeco',
          '@happyvertical/caelus',
        ],
      };`,
    );

    const packages = extractAgentPackagesFromConfig(
      join(tmpDir, 'smrt.config.js'),
    );
    expect(packages).toEqual([
      '@happyvertical/praeco',
      '@happyvertical/caelus',
    ]);
  });

  it('should strip single-line comments', () => {
    writeFileSync(
      join(tmpDir, 'smrt.config.js'),
      `export default {
        agents: [
          '@happyvertical/praeco',
          // '@happyvertical/ludis',
          '@happyvertical/caelus',
        ],
      };`,
    );

    const packages = extractAgentPackagesFromConfig(
      join(tmpDir, 'smrt.config.js'),
    );
    expect(packages).toEqual([
      '@happyvertical/praeco',
      '@happyvertical/caelus',
    ]);
    expect(packages).not.toContain('@happyvertical/ludis');
  });

  it('should return empty array when no agents array found', () => {
    writeFileSync(
      join(tmpDir, 'smrt.config.js'),
      `export default { name: 'test' };`,
    );

    const packages = extractAgentPackagesFromConfig(
      join(tmpDir, 'smrt.config.js'),
    );
    expect(packages).toEqual([]);
  });

  it('should return empty array for empty agents array', () => {
    writeFileSync(
      join(tmpDir, 'smrt.config.js'),
      `export default { agents: [] };`,
    );

    const packages = extractAgentPackagesFromConfig(
      join(tmpDir, 'smrt.config.js'),
    );
    expect(packages).toEqual([]);
  });

  it('should handle both single and double quotes', () => {
    writeFileSync(
      join(tmpDir, 'smrt.config.js'),
      `export default {
        agents: [
          '@happyvertical/praeco',
          "@happyvertical/caelus",
        ],
      };`,
    );

    const packages = extractAgentPackagesFromConfig(
      join(tmpDir, 'smrt.config.js'),
    );
    expect(packages).toEqual([
      '@happyvertical/praeco',
      '@happyvertical/caelus',
    ]);
  });
});

describe('loadManifestsFromPackages', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'smrt-manifest-load-test-'));
    AgentUIRegistry.clear();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    AgentUIRegistry.clear();
  });

  function setupFakePackage(name: string, agentClass: string) {
    const pkgDir = join(tmpDir, 'node_modules', ...name.split('/'));
    const distDir = join(pkgDir, 'dist');
    mkdirSync(distDir, { recursive: true });

    writeFileSync(
      join(pkgDir, 'package.json'),
      JSON.stringify({
        name,
        exports: {
          '.': { import: './dist/index.js' },
          './manifest': './dist/manifest.json',
        },
      }),
    );

    writeFileSync(
      join(distDir, 'manifest.json'),
      JSON.stringify({
        objects: {
          [agentClass]: {
            className: agentClass,
            agent: {
              name: agentClass,
              slug: agentClass.toLowerCase(),
              tier: 'standard',
              uiSlots: { settings: { id: 'settings', label: 'Settings' } },
              permissions: [],
              features: [],
              menuItems: [],
              components: [],
            },
          },
        },
      }),
    );

    // Project-level package.json for createRequire resolution
    writeFileSync(
      join(tmpDir, 'package.json'),
      JSON.stringify({ name: 'test-project' }),
    );
  }

  it('should load and register manifests from packages', () => {
    setupFakePackage('@test/praeco', 'Praeco');
    setupFakePackage('@test/caelus', 'Caelus');

    const result = loadManifestsFromPackages(
      ['@test/praeco', '@test/caelus'],
      tmpDir,
    );

    expect(result.size).toBe(2);
    expect(result.get('Praeco')?.name).toBe('Praeco');
    expect(result.get('Caelus')?.name).toBe('Caelus');
  });

  it('should register manifests with AgentUIRegistry', () => {
    setupFakePackage('@test/praeco', 'Praeco');

    loadManifestsFromPackages(['@test/praeco'], tmpDir);

    expect(AgentUIRegistry.getManifest('Praeco')).toBeDefined();
    expect(AgentUIRegistry.getManifest('Praeco')?.name).toBe('Praeco');
  });

  it('should skip packages whose manifests cannot be resolved', () => {
    setupFakePackage('@test/praeco', 'Praeco');

    const result = loadManifestsFromPackages(
      ['@test/praeco', '@test/nonexistent'],
      tmpDir,
    );

    expect(result.size).toBe(1);
    expect(result.has('Praeco')).toBe(true);
  });

  it('should return empty map for empty package list', () => {
    const result = loadManifestsFromPackages([], tmpDir);
    expect(result.size).toBe(0);
  });
});

describe('loadManifestsFromConfig', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'smrt-config-load-test-'));
    AgentUIRegistry.clear();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    AgentUIRegistry.clear();
  });

  it('should load manifests from smrt.config.js', () => {
    // Setup package
    const pkgDir = join(tmpDir, 'node_modules', '@test', 'myagent');
    const distDir = join(pkgDir, 'dist');
    mkdirSync(distDir, { recursive: true });

    writeFileSync(
      join(pkgDir, 'package.json'),
      JSON.stringify({
        name: '@test/myagent',
        exports: { './manifest': './dist/manifest.json' },
      }),
    );

    writeFileSync(
      join(distDir, 'manifest.json'),
      JSON.stringify({
        objects: {
          MyAgent: {
            className: 'MyAgent',
            agent: {
              name: 'MyAgent',
              slug: 'myagent',
              tier: 'free',
              uiSlots: {},
              permissions: [],
              features: [],
              menuItems: [],
              components: [],
            },
          },
        },
      }),
    );

    writeFileSync(
      join(tmpDir, 'package.json'),
      JSON.stringify({ name: 'test-project' }),
    );

    writeFileSync(
      join(tmpDir, 'smrt.config.js'),
      `export default { agents: ['@test/myagent'] };`,
    );

    const result = loadManifestsFromConfig(
      join(tmpDir, 'smrt.config.js'),
      tmpDir,
    );

    expect(result.size).toBe(1);
    expect(result.get('MyAgent')?.slug).toBe('myagent');
    expect(AgentUIRegistry.getManifest('MyAgent')).toBeDefined();
  });

  it('should return empty map when config file does not exist', () => {
    const result = loadManifestsFromConfig(
      join(tmpDir, 'nonexistent.js'),
      tmpDir,
    );
    expect(result.size).toBe(0);
  });

  it('should return empty map when config has no agents', () => {
    writeFileSync(
      join(tmpDir, 'smrt.config.js'),
      `export default { name: 'test' };`,
    );

    const result = loadManifestsFromConfig(
      join(tmpDir, 'smrt.config.js'),
      tmpDir,
    );
    expect(result.size).toBe(0);
  });
});
