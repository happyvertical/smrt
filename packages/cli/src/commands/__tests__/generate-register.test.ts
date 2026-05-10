/**
 * Unit tests for generate-register deduplication logic
 *
 * Verifies that generate-register produces unique imports when packages
 * re-export classes from each other (via enrichManifest merging).
 */

import { mkdir, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the discovery module
vi.mock('../../discovery/index.js', () => ({
  autoDiscoverAndLoad: vi.fn(),
  loadManifestFile: vi.fn(),
}));

// Mock smrt-core imports used at module level
vi.mock('@happyvertical/smrt-core', () => ({
  ObjectRegistry: { register: vi.fn(), registerCollection: vi.fn() },
}));
vi.mock('@happyvertical/smrt-core/generators', () => ({
  MCPGenerator: class {},
}));
vi.mock('@happyvertical/smrt-core/prebuild', () => ({
  generateDeclarationsFromCLI: vi.fn(),
}));

import {
  autoDiscoverAndLoad,
  loadManifestFile,
} from '../../discovery/index.js';
import { generateCommands } from '../generate.js';

const mockedAutoDiscover = vi.mocked(autoDiscoverAndLoad);
const mockedLoadManifest = vi.mocked(loadManifestFile);

describe('generate-register', () => {
  const tmpDir = resolve(import.meta.dirname, '.tmp-register-test');
  const outputPath = resolve(tmpDir, 'register.js');

  beforeEach(async () => {
    await mkdir(tmpDir, { recursive: true });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
  });

  const handler = generateCommands['generate-register'].handler;

  it('deduplicates objects that appear in multiple package manifests', async () => {
    // Profile is defined in smrt-profiles but also appears in smrt-users manifest
    // (merged via enrichManifest)
    mockedAutoDiscover.mockResolvedValue({
      discovered: [
        {
          path: '/fake/profiles/manifest.json',
          source: 'package',
          packageName: '@happyvertical/smrt-profiles',
        },
        {
          path: '/fake/users/manifest.json',
          source: 'package',
          packageName: '@happyvertical/smrt-users',
        },
      ],
    } as any);

    mockedLoadManifest.mockImplementation(async (path: string) => {
      if (path.includes('profiles')) {
        return {
          objects: {
            Profile: {
              className: 'Profile',
              exportName: 'Profile',
              packageName: '@happyvertical/smrt-profiles',
              qualifiedName: '@happyvertical/smrt-profiles:Profile',
              hasCollection: true,
              collectionExportName: 'ProfileCollection',
              collection: 'profiles',
              visibility: 'public',
            },
          },
        };
      }
      if (path.includes('users')) {
        return {
          objects: {
            // Profile merged from dependency
            Profile: {
              className: 'Profile',
              exportName: 'Profile',
              packageName: '@happyvertical/smrt-profiles',
              qualifiedName: '@happyvertical/smrt-profiles:Profile',
              hasCollection: true,
              collectionExportName: 'ProfileCollection',
              collection: 'profiles',
              visibility: 'public',
            },
            // User is unique to this package
            User: {
              className: 'User',
              exportName: 'User',
              packageName: '@happyvertical/smrt-users',
              qualifiedName: '@happyvertical/smrt-users:User',
              hasCollection: true,
              collectionExportName: 'UserCollection',
              collection: 'users',
              visibility: 'public',
            },
          },
        };
      }
      return null;
    });

    await handler([], { 'output-path': outputPath });

    const content = await readFile(outputPath, 'utf-8');

    // Profile should appear exactly once
    const profileImports = content.match(/import \{[^}]*Profile[^}]*\} from/g);
    expect(profileImports).toHaveLength(1);

    // Profile should be imported from its canonical package, not smrt-users
    expect(content).toContain(
      "import { Profile, ProfileCollection } from '@happyvertical/smrt-profiles'",
    );
    expect(content).not.toContain(
      "from '@happyvertical/smrt-users';\nimport { Profile",
    );

    // User should still be imported
    expect(content).toContain(
      "import { User, UserCollection } from '@happyvertical/smrt-users'",
    );

    // Each register call should appear once
    const profileRegistrations = content.match(
      /ObjectRegistry\.register\(Profile/g,
    );
    expect(profileRegistrations).toHaveLength(1);
    expect(content).toContain(
      'ObjectRegistry.register(Profile, { name: "Profile", packageName: "@happyvertical/smrt-profiles" });',
    );
    expect(content).not.toContain(
      'name: "@happyvertical/smrt-profiles:Profile"',
    );
  });

  it('imports collection entries without registering them as objects', async () => {
    mockedAutoDiscover.mockResolvedValue({
      discovered: [
        {
          path: '/fake/pkg/manifest.json',
          source: 'package',
          packageName: '@happyvertical/pkg',
        },
      ],
    } as any);

    mockedLoadManifest.mockResolvedValue({
      objects: {
        Widget: {
          className: 'Widget',
          exportName: 'Widget',
          packageName: '@happyvertical/pkg',
          qualifiedName: '@happyvertical/pkg:Widget',
          collection: 'widgets',
          visibility: 'public',
        },
        WidgetCollection: {
          className: 'WidgetCollection',
          exportName: 'WidgetCollection',
          packageName: '@happyvertical/pkg',
          qualifiedName: '@happyvertical/pkg:WidgetCollection',
          collection: 'widgets',
          extends: 'SmrtCollection',
          visibility: 'public',
        },
      },
    });

    await handler([], { 'output-path': outputPath });

    const content = await readFile(outputPath, 'utf-8');

    expect(content).toContain("import { Widget } from '@happyvertical/pkg';");
    expect(content).toContain(
      "import { WidgetCollection } from '@happyvertical/pkg';",
    );
    expect(content).toContain(
      'ObjectRegistry.register(Widget, { name: "Widget", packageName: "@happyvertical/pkg" });',
    );
    expect(content).not.toContain('ObjectRegistry.register(WidgetCollection');
  });

  it('filters out test-visibility objects', async () => {
    mockedAutoDiscover.mockResolvedValue({
      discovered: [
        {
          path: '/fake/profiles/manifest.json',
          source: 'package',
          packageName: '@happyvertical/smrt-profiles',
        },
      ],
    } as any);

    mockedLoadManifest.mockResolvedValue({
      objects: {
        Profile: {
          className: 'Profile',
          exportName: 'Profile',
          packageName: '@happyvertical/smrt-profiles',
          qualifiedName: '@happyvertical/smrt-profiles:Profile',
          hasCollection: true,
          collectionExportName: 'ProfileCollection',
          collection: 'profiles',
          visibility: 'public',
        },
        PerfTestUser: {
          className: 'PerfTestUser',
          exportName: 'PerfTestUser',
          packageName: '@happyvertical/smrt-profiles',
          qualifiedName: '@happyvertical/smrt-profiles:PerfTestUser',
          hasCollection: false,
          visibility: 'test',
        },
        Issue144TestProfile: {
          className: 'Issue144TestProfile',
          exportName: 'Issue144TestProfile',
          packageName: '@happyvertical/smrt-profiles',
          qualifiedName: '@happyvertical/smrt-profiles:Issue144TestProfile',
          hasCollection: false,
          visibility: 'test',
        },
      },
    });

    await handler([], { 'output-path': outputPath });

    const content = await readFile(outputPath, 'utf-8');

    // Public objects should be present
    expect(content).toContain('Profile');

    // Test objects should NOT be present
    expect(content).not.toContain('PerfTestUser');
    expect(content).not.toContain('Issue144TestProfile');
  });

  it('keeps package names separate when manifest keys are qualified', async () => {
    mockedAutoDiscover.mockResolvedValue({
      discovered: [
        {
          path: '/fake/agents/manifest.json',
          source: 'package',
          packageName: '@happyvertical/smrt-agents',
        },
      ],
    } as any);

    mockedLoadManifest.mockResolvedValue({
      objects: {
        '@happyvertical/smrt-agents:Agent': {
          exportName: 'Agent',
          packageName: '@happyvertical/smrt-agents',
          qualifiedName: '@happyvertical/smrt-agents:Agent',
          hasCollection: false,
          visibility: 'public',
        },
      },
    });

    await handler([], { 'output-path': outputPath });

    const content = await readFile(outputPath, 'utf-8');

    expect(content).toContain(
      'ObjectRegistry.register(Agent, { name: "Agent", packageName: "@happyvertical/smrt-agents" });',
    );
    expect(content).not.toContain('name: "@happyvertical/smrt-agents:Agent"');
  });

  it('imports from canonical packageName, not the manifest package', async () => {
    // Scenario: smrt-users manifest includes Profile (from smrt-profiles)
    // but smrt-profiles is not installed as a separate manifest
    mockedAutoDiscover.mockResolvedValue({
      discovered: [
        {
          path: '/fake/users/manifest.json',
          source: 'package',
          packageName: '@happyvertical/smrt-users',
        },
      ],
    } as any);

    mockedLoadManifest.mockResolvedValue({
      objects: {
        Profile: {
          className: 'Profile',
          exportName: 'Profile',
          packageName: '@happyvertical/smrt-profiles',
          qualifiedName: '@happyvertical/smrt-profiles:Profile',
          hasCollection: true,
          collectionExportName: 'ProfileCollection',
          collection: 'profiles',
          visibility: 'public',
        },
        User: {
          className: 'User',
          exportName: 'User',
          packageName: '@happyvertical/smrt-users',
          qualifiedName: '@happyvertical/smrt-users:User',
          hasCollection: true,
          collectionExportName: 'UserCollection',
          collection: 'users',
          visibility: 'public',
        },
      },
    });

    await handler([], { 'output-path': outputPath });

    const content = await readFile(outputPath, 'utf-8');

    // Profile imports from its canonical package, not the manifest's package
    expect(content).toContain("from '@happyvertical/smrt-profiles'");
    expect(content).toContain("from '@happyvertical/smrt-users'");
  });

  it('deduplicates by exportName even with different qualifiedNames', async () => {
    // Edge case: two objects with same exportName but different qualifiedNames
    mockedAutoDiscover.mockResolvedValue({
      discovered: [
        {
          path: '/fake/pkg-a/manifest.json',
          source: 'package',
          packageName: '@happyvertical/pkg-a',
        },
        {
          path: '/fake/pkg-b/manifest.json',
          source: 'package',
          packageName: '@happyvertical/pkg-b',
        },
      ],
    } as any);

    mockedLoadManifest.mockImplementation(async (path: string) => {
      if (path.includes('pkg-a')) {
        return {
          objects: {
            Widget: {
              className: 'Widget',
              exportName: 'Widget',
              packageName: '@happyvertical/pkg-a',
              qualifiedName: '@happyvertical/pkg-a:Widget',
              hasCollection: false,
              visibility: 'public',
            },
          },
        };
      }
      if (path.includes('pkg-b')) {
        return {
          objects: {
            Widget: {
              className: 'Widget',
              exportName: 'Widget',
              packageName: '@happyvertical/pkg-b',
              qualifiedName: '@happyvertical/pkg-b:Widget',
              hasCollection: false,
              visibility: 'public',
            },
          },
        };
      }
      return null;
    });

    await handler([], { 'output-path': outputPath });

    const content = await readFile(outputPath, 'utf-8');

    // Widget should appear exactly once (first wins)
    const widgetImports = content.match(/import \{[^}]*Widget[^}]*\}/g);
    expect(widgetImports).toHaveLength(1);
  });

  it('registers both objects when they share a collectionExportName', async () => {
    // Two different objects share the same collectionExportName.
    // Both objects should be registered; only the first gets collection registration.
    mockedAutoDiscover.mockResolvedValue({
      discovered: [
        {
          path: '/fake/pkg-a/manifest.json',
          source: 'package',
          packageName: '@happyvertical/pkg-a',
        },
        {
          path: '/fake/pkg-b/manifest.json',
          source: 'package',
          packageName: '@happyvertical/pkg-b',
        },
      ],
    } as any);

    mockedLoadManifest.mockImplementation(async (path: string) => {
      if (path.includes('pkg-a')) {
        return {
          objects: {
            Widget: {
              className: 'Widget',
              exportName: 'Widget',
              packageName: '@happyvertical/pkg-a',
              qualifiedName: '@happyvertical/pkg-a:Widget',
              hasCollection: true,
              collectionExportName: 'ItemCollection',
              collection: 'widgets',
              visibility: 'public',
            },
          },
        };
      }
      if (path.includes('pkg-b')) {
        return {
          objects: {
            Gadget: {
              className: 'Gadget',
              exportName: 'Gadget',
              packageName: '@happyvertical/pkg-b',
              qualifiedName: '@happyvertical/pkg-b:Gadget',
              hasCollection: true,
              collectionExportName: 'ItemCollection',
              collection: 'gadgets',
              visibility: 'public',
            },
          },
        };
      }
      return null;
    });

    await handler([], { 'output-path': outputPath });

    const content = await readFile(outputPath, 'utf-8');

    // Both objects should be imported
    expect(content).toContain(
      "import { Widget, ItemCollection } from '@happyvertical/pkg-a'",
    );
    expect(content).toContain("import { Gadget } from '@happyvertical/pkg-b'");

    // Both objects should be registered
    expect(content).toContain(
      'ObjectRegistry.register(Widget, { name: "Widget", packageName: "@happyvertical/pkg-a" });',
    );
    expect(content).toContain(
      'ObjectRegistry.register(Gadget, { name: "Gadget", packageName: "@happyvertical/pkg-b" });',
    );

    // ItemCollection should only appear once (from Widget's package)
    const collectionImports = content.match(/ItemCollection/g);
    // 1 in import, 1 in registerCollection
    expect(collectionImports).toHaveLength(2);
  });
});
