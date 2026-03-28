import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { clearManifestCache } from '../manifest/manifest-loader.js';
import { ObjectRegistry } from '../registry.js';
import { snapshotObjectRegistryState } from '../test-utils.js';

vi.mock('../manifest/discover-smrt-packages.js', () => ({
  discoverSmrtPackages: () => [
    '@happyvertical/smrt-events',
    '@happyvertical/smrt-profiles',
  ],
}));

function expectSmrtBaseFields(fields: Map<string, any>) {
  expect(fields.has('id')).toBe(true);
  expect(fields.has('slug')).toBe(true);
  expect(fields.has('context')).toBe(true);
  expect(fields.has('created_at')).toBe(true);
  expect(fields.has('updated_at')).toBe(true);
}

describe('ObjectRegistry.getAllFields() external auto-load', () => {
  let restoreRegistry: () => void;

  beforeAll(() => {
    restoreRegistry = snapshotObjectRegistryState();
    ObjectRegistry.clear();
    clearManifestCache();
  });

  beforeEach(() => {
    ObjectRegistry.clear();
    clearManifestCache();
  });

  afterAll(() => {
    restoreRegistry();
    clearManifestCache();
  });

  it('should auto-load external package base classes for raw field probes', async () => {
    expect(ObjectRegistry.hasClass('Event')).toBe(false);

    const fields = await ObjectRegistry.getAllFields('Event');

    expect(ObjectRegistry.hasClass('Event')).toBe(true);
    expectSmrtBaseFields(fields);
    expect(fields.has('name')).toBe(true);
  });

  it('should auto-load external STI subclasses for raw field probes', async () => {
    expect(ObjectRegistry.hasClass('Organization')).toBe(false);

    const fields = await ObjectRegistry.getAllFields('Organization');

    expect(ObjectRegistry.hasClass('Organization')).toBe(true);
    expectSmrtBaseFields(fields);
    expect(fields.has('name')).toBe(true);
  });

  it('should still return an empty map for unknown classes', async () => {
    const fields = await ObjectRegistry.getAllFields(
      'DefinitelyNotARealSmrtClass',
    );

    expect(fields.size).toBe(0);
  });
});
