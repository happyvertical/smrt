/**
 * Tests for AgentUIRegistry functionality
 *
 * Tests the expanded registry with key-based registration,
 * manifest storage, and the new query methods.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AgentManifestInfo,
  type AgentUIComponentRegistry,
  createUIRegistry,
} from './ui.js';

describe('AgentUIRegistry', () => {
  let registry: AgentUIComponentRegistry;

  beforeEach(() => {
    registry = createUIRegistry();
  });

  describe('register / get', () => {
    it('should register and retrieve a component by agent class and slot', () => {
      const FakeComponent = () => {};
      registry.register('Praeco', 'sources', FakeComponent);

      expect(registry.get('Praeco', 'sources')).toBe(FakeComponent);
    });

    it('should return undefined for unregistered component', () => {
      expect(registry.get('Praeco', 'sources')).toBeUndefined();
    });

    it('should overwrite existing registration', () => {
      const Component1 = () => {};
      const Component2 = () => {};
      registry.register('Praeco', 'sources', Component1);
      registry.register('Praeco', 'sources', Component2);

      expect(registry.get('Praeco', 'sources')).toBe(Component2);
    });
  });

  describe('registerByKey / getByKey', () => {
    it('should register and retrieve by composite key', () => {
      const FakeComponent = () => {};
      registry.registerByKey('praeco:sources', FakeComponent);

      expect(registry.getByKey('praeco:sources')).toBe(FakeComponent);
    });

    it('should return undefined for unregistered key', () => {
      expect(registry.getByKey('praeco:nonexistent')).toBeUndefined();
    });

    it('should interop with register/get via same key format', () => {
      const FakeComponent = () => {};
      // register() uses `${agentClass}:${slotId}` as internal key
      registry.register('Praeco', 'sources', FakeComponent);

      // getByKey should find it with the same key format
      expect(registry.getByKey('Praeco:sources')).toBe(FakeComponent);
    });
  });

  describe('has', () => {
    it('should return true for registered component', () => {
      registry.register('Praeco', 'sources', () => {});
      expect(registry.has('Praeco', 'sources')).toBe(true);
    });

    it('should return false for unregistered component', () => {
      expect(registry.has('Praeco', 'sources')).toBe(false);
    });
  });

  describe('getSlots', () => {
    it('should return all slot IDs for an agent', () => {
      registry.register('Praeco', 'sources', () => {});
      registry.register('Praeco', 'reports', () => {});
      registry.register('Praeco', 'settings', () => {});
      registry.register('Caelus', 'forecasts', () => {});

      const slots = registry.getSlots('Praeco');
      expect(slots).toHaveLength(3);
      expect(slots).toContain('sources');
      expect(slots).toContain('reports');
      expect(slots).toContain('settings');
    });

    it('should return empty array for unregistered agent', () => {
      expect(registry.getSlots('Unknown')).toEqual([]);
    });
  });

  describe('getAgents', () => {
    it('should return all registered agent class names', () => {
      registry.register('Praeco', 'sources', () => {});
      registry.register('Caelus', 'forecasts', () => {});
      registry.register('Ludis', 'schedules', () => {});

      const agents = registry.getAgents();
      expect(agents).toHaveLength(3);
      expect(agents).toContain('Praeco');
      expect(agents).toContain('Caelus');
      expect(agents).toContain('Ludis');
    });

    it('should deduplicate agents with multiple slots', () => {
      registry.register('Praeco', 'sources', () => {});
      registry.register('Praeco', 'reports', () => {});

      expect(registry.getAgents()).toHaveLength(1);
    });
  });

  describe('unregister', () => {
    it('should remove a registered component', () => {
      registry.register('Praeco', 'sources', () => {});
      expect(registry.has('Praeco', 'sources')).toBe(true);

      const result = registry.unregister('Praeco', 'sources');
      expect(result).toBe(true);
      expect(registry.has('Praeco', 'sources')).toBe(false);
    });

    it('should return false for unregistered component', () => {
      expect(registry.unregister('Praeco', 'sources')).toBe(false);
    });
  });

  describe('clear', () => {
    it('should remove all components and manifests', () => {
      registry.register('Praeco', 'sources', () => {});
      registry.register('Caelus', 'forecasts', () => {});
      registry.registerManifest('Praeco', createTestManifest('Praeco'));

      registry.clear();

      expect(registry.getAgents()).toEqual([]);
      expect(registry.getManifest('Praeco')).toBeUndefined();
      expect(registry.getAllManifests().size).toBe(0);
    });
  });

  describe('registerManifest / getManifest', () => {
    it('should register and retrieve an agent manifest', () => {
      const manifest = createTestManifest('Praeco');
      registry.registerManifest('Praeco', manifest);

      expect(registry.getManifest('Praeco')).toBe(manifest);
    });

    it('should return undefined for unregistered manifest', () => {
      expect(registry.getManifest('Unknown')).toBeUndefined();
    });

    it('should overwrite existing manifest', () => {
      const manifest1 = createTestManifest('Praeco');
      const manifest2 = createTestManifest('Praeco');
      manifest2.description = 'Updated description';

      registry.registerManifest('Praeco', manifest1);
      registry.registerManifest('Praeco', manifest2);

      expect(registry.getManifest('Praeco')?.description).toBe(
        'Updated description',
      );
    });
  });

  describe('getAllManifests', () => {
    it('should return all registered manifests', () => {
      registry.registerManifest('Praeco', createTestManifest('Praeco'));
      registry.registerManifest('Caelus', createTestManifest('Caelus'));

      const manifests = registry.getAllManifests();
      expect(manifests.size).toBe(2);
      expect(manifests.get('Praeco')?.name).toBe('Praeco');
      expect(manifests.get('Caelus')?.name).toBe('Caelus');
    });

    it('should return a copy (not the internal map)', () => {
      registry.registerManifest('Praeco', createTestManifest('Praeco'));
      const manifests = registry.getAllManifests();

      // Mutating the returned map should not affect the registry
      manifests.delete('Praeco');
      expect(registry.getManifest('Praeco')).toBeDefined();
    });

    it('should return empty map when no manifests registered', () => {
      expect(registry.getAllManifests().size).toBe(0);
    });
  });
});

function createTestManifest(name: string): AgentManifestInfo {
  return {
    name,
    slug: name.toLowerCase(),
    icon: 'test-icon',
    tier: 'standard',
    description: `${name} test manifest`,
    uiSlots: {},
    permissions: [],
    features: [],
    menuItems: [],
    components: [],
  };
}
