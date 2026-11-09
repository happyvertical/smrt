import { afterEach, describe, expect, it } from 'vitest';
import { registerPermissionDefinitions as rootRegister } from '../index.js';
import { registerPermissionDefinitions as portableRegister } from '../permission-registry.js';
import {
  PermissionCatalogService,
  registerPermissionDefinitions as serviceRegister,
} from '../services/PermissionCatalogService.js';

const dispose: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of dispose.splice(0)) cleanup();
});
describe('portable permission metadata registry', () => {
  it('preserves the exact root/service function and original definition references', () => {
    expect(portableRegister).toBe(rootRegister);
    expect(portableRegister).toBe(serviceRegister);
    const definition = { slug: 'portable_registry.exact', name: 'Original' };
    dispose.push(portableRegister([definition]));
    const catalog = PermissionCatalogService.create();
    expect(catalog.getRuntimePermissionDefinitions()).toContain(definition);
    definition.name = 'Updated metadata';
    expect(
      catalog
        .getCatalog()
        .permissions.find((value) => value.slug === definition.slug)?.name,
    ).toBe('Updated metadata');
  });
  it('keeps independent, idempotent disposers across old and portable callers', () => {
    const first = { slug: 'portable_registry.first' },
      second = { slug: 'portable_registry.second' },
      third = { slug: 'portable_registry.third' };
    const removeFirst = rootRegister([first]);
    dispose.push(removeFirst);
    dispose.push(portableRegister([second]));
    const catalog = PermissionCatalogService.create();
    removeFirst();
    removeFirst();
    dispose.push(serviceRegister([third]));
    removeFirst();
    const current = catalog.getRuntimePermissionDefinitions();
    expect(current).not.toContain(first);
    expect(current).toContain(second);
    expect(current).toContain(third);
  });
  it('retains catalog conflict validation across entry points', () => {
    dispose.push(
      portableRegister([{ slug: 'portable_registry.conflict', name: 'First' }]),
    );
    dispose.push(
      serviceRegister([{ slug: 'portable_registry.conflict', name: 'Second' }]),
    );
    expect(() => PermissionCatalogService.create().getCatalog()).toThrow(
      'Conflicting permission metadata',
    );
  });
});
