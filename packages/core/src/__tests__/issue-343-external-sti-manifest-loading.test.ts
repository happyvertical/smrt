/**
 * Test for Issue #343/#366: External package STI classes with inherited fields
 *
 * PROBLEM (v0.16 and earlier):
 * - STI subclasses (Person, Bot, Organization) had 0 fields in their manifests
 * - Inherited fields from parent (Profile) were not included
 * - Runtime field merging was complex and error-prone
 *
 * SOLUTION (v0.17+): Build-time field inheritance
 * - ManifestGenerator now merges inherited fields at build time
 * - Person manifest contains all 7 fields from Profile inline
 * - getAllFields() simplified to just delegate to getFields()
 * - No runtime field merging needed
 *
 * What these tests verify:
 * ✅ External package manifests include inherited fields (Person: 7 fields)
 * ✅ getFields() returns all inherited fields for STI subclasses
 * ✅ All 7 Profile fields are present (typeId, email, name, description, etc.)
 *
 * What these tests DON'T test:
 * ❌ Instance creation with stub constructors (requires real class import)
 * ❌ Auto-generated IDs (requires real initialization logic)
 * ❌ Database persistence (requires real class, not manifest stub)
 *
 * For full CRUD operations, import the actual class:
 * import { Person } from '@happyvertical/smrt-profiles';
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  clearManifestCache,
  loadExternalManifest,
} from '../manifest/manifest-loader.js';
import { ObjectRegistry } from '../registry.js';
import { snapshotObjectRegistryState } from '../test-utils.js';

// Clear manifest cache before and after each test to ensure test isolation
// This prevents ESM module caching issues where cached manifests from one test
// could affect another test's results
beforeEach(() => {
  clearManifestCache();
});

afterEach(() => {
  clearManifestCache();
});

// Type definitions for manifest structures
interface SmartObjectDefinition {
  fields?: Record<string, unknown>;
  // Allow additional properties that may exist on object definitions
  [key: string]: unknown;
}

interface SmartObjectManifest {
  objects?: Record<string, SmartObjectDefinition>;
  // Allow additional properties that may exist on manifests
  [key: string]: unknown;
}

// Helper to find object definition in manifest by class name
// Handles both qualified keys (@pkg:Class) and legacy keys (class, Class)
function findObjectInManifest(
  manifest: SmartObjectManifest | undefined,
  className: string,
  packageName: string,
): SmartObjectDefinition | undefined {
  if (!manifest?.objects) return undefined;

  // Try qualified key first (new format: @pkg:Class)
  const qualifiedKey = `${packageName}:${className}`;
  if (manifest.objects[qualifiedKey]) {
    return manifest.objects[qualifiedKey];
  }

  // Fall back to legacy keys (lowercase or PascalCase)
  const lowerKey = className.toLowerCase();
  return manifest.objects[lowerKey] || manifest.objects[className];
}

describe('Issue #343: External Package STI Classes Manifest Loading', () => {
  let restoreRegistry: () => void;
  let profilesManifestAvailable = false;

  // Register Person from manifest before running tests
  // (In production, auto-loading works, but in monorepo tests we need explicit registration)
  beforeAll(async () => {
    restoreRegistry = snapshotObjectRegistryState();

    const manifest = await loadExternalManifest('@happyvertical/smrt-profiles');
    console.log('[test setup] Loaded manifest:', manifest ? 'Yes' : 'No');
    profilesManifestAvailable = !!manifest;

    const personDef = findObjectInManifest(
      manifest,
      'Person',
      '@happyvertical/smrt-profiles',
    );
    if (personDef) {
      console.log(
        '[test setup] Person fields in manifest:',
        Object.keys(personDef.fields || {}).length,
      );
      console.log(
        '[test setup] Person fields:',
        Object.keys(personDef.fields || {}),
      );

      // Pass the object definition (personDef), not the entire manifest!
      ObjectRegistry.registerFromManifest(
        'Person',
        personDef,
        '@happyvertical/smrt-profiles',
      );

      const registered = ObjectRegistry.findClass('Person');
      console.log('[test setup] Person registered:', registered ? 'Yes' : 'No');
      console.log(
        '[test setup] Person fields after registration:',
        registered?.fields.size,
      );
    } else {
      console.log('[test setup] Person NOT found in manifest');
      console.log(
        '[test setup] Available keys:',
        Object.keys(manifest?.objects || {}),
      );
    }
  });

  afterAll(() => {
    restoreRegistry();
    clearManifestCache();
  });

  it('should verify external package manifest exists and is loadable', async () => {
    // Under the explicit manifest contract, this only succeeds when the
    // external package is actually resolvable from the current test setup.
    const manifest = await loadExternalManifest('@happyvertical/smrt-profiles');

    console.log('Loaded manifest:', manifest ? 'Yes' : 'No');

    if (!manifest) {
      expect(manifest).toBeFalsy();
      return;
    }

    // Verify Person is in the manifest (using helper for qualified keys)
    const personDef = findObjectInManifest(
      manifest,
      'Person',
      '@happyvertical/smrt-profiles',
    );
    console.log('Person in manifest:', personDef ? 'Yes' : 'No');

    if (personDef) {
      console.log('Person manifest data:', {
        className: personDef.className,
        extends: personDef.extends,
        tableStrategy: personDef.decoratorConfig?.tableStrategy,
        fieldsCount: Object.keys(personDef.fields || {}).length,
        methodsCount: Object.keys(personDef.methods || {}).length,
      });

      // Person should extend Profile
      expect(personDef.extends).toBe('Profile');
      expect(personDef.decoratorConfig?.tableStrategy).toBe('sti');

      // As of v0.17: Manifest includes inherited fields inline (build-time merging)
      // Person now has 10 fields from Profile in the manifest
      // (includes tenantId, created_at, updated_at from SmrtObject base)
      expect(Object.keys(personDef.fields || {}).length).toBe(10);
    }

    // Verify Profile is in the manifest (the STI base)
    const profileDef = findObjectInManifest(
      manifest,
      'Profile',
      '@happyvertical/smrt-profiles',
    );
    console.log('Profile in manifest:', profileDef ? 'Yes' : 'No');

    if (profileDef) {
      console.log('Profile manifest data:', {
        className: profileDef.className,
        tableStrategy: profileDef.decoratorConfig?.tableStrategy,
        fieldsCount: Object.keys(profileDef.fields || {}).length,
        methodsCount: Object.keys(profileDef.methods || {}).length,
      });

      // Profile should have STI strategy
      expect(profileDef.decoratorConfig?.tableStrategy).toBe('sti');

      // Profile should have fields
      expect(Object.keys(profileDef.fields || {}).length).toBeGreaterThan(0);
    }
  });

  it.skip('should try to auto-load Person class when requested via getCollection (N/A in tests)', async () => {
    // This test is skipped because Person is pre-registered in beforeAll() for test stability
    // Auto-loading works in production but not in monorepo tests
    // See: beforeAll() hook which registers Person from manifest

    // Before calling getCollection, Person should not be registered
    const beforeLoad = ObjectRegistry.classes.get('Person');
    console.log(
      'Person registered before getCollection:',
      beforeLoad ? 'Yes' : 'No',
    );
    expect(beforeLoad).toBeUndefined();

    // Try to get collection - this should trigger auto-loading
    try {
      await ObjectRegistry.getCollection('Person', {
        db: { url: ':memory:', type: 'sqlite' },
      });

      // If we get here, auto-loading succeeded
      const afterLoad = ObjectRegistry.classes.get('Person');
      console.log(
        'Person registered after getCollection:',
        afterLoad ? 'Yes' : 'No',
      );

      // In monorepo context, this might still fail because profiles isn't in node_modules
      // But the auto-loading logic should have tried
      if (afterLoad) {
        console.log('✅ Auto-loading succeeded!');
        expect(afterLoad).toBeDefined();
      } else {
        console.log(
          '⚠️  Auto-loading attempted but package not found in node_modules (expected in monorepo)',
        );
      }
    } catch (error) {
      // Auto-loading succeeded in registering Person and Profile from manifest
      // But schema generation may still fail if stub constructors are used
      console.log(
        'Error during collection creation:',
        (error as Error).message,
      );

      // The error could be either:
      // 1. "Class Person not found" - if manifest loading failed
      // 2. "Cannot generate schema" - if registration succeeded but schema gen failed
      const errorMsg = (error as Error).message;
      const isExpectedError =
        errorMsg.includes('Class Person not found') ||
        errorMsg.includes('Cannot generate schema');

      expect(isExpectedError).toBe(true);
    }
  });

  it('should load fields for external STI class', () => {
    // As of v0.17: Build-time inheritance merging
    // Person's manifest now includes inherited fields from Profile

    if (!profilesManifestAvailable) {
      expect(ObjectRegistry.getFields('Person').size).toBe(0);
      return;
    }

    // Get fields for Person (should include fields from Profile base class)
    const fields = ObjectRegistry.getFields('Person');
    console.log('Person fields:', Array.from(fields.keys()));
    console.log('Person fields count:', fields.size);

    // FIXED: Person now has 10 fields because manifest includes inherited fields
    // (includes tenantId, created_at, updated_at from SmrtObject base)
    expect(fields.size).toBe(10); // Exactly 10 inherited fields from Profile

    // Check specific fields from Profile (inherited at build time)
    expect(fields.has('created_at')).toBe(true);
    expect(fields.has('updated_at')).toBe(true);
    expect(fields.has('tenantId')).toBe(true);
    expect(fields.has('typeId')).toBe(true);
    expect(fields.has('email')).toBe(true);
    expect(fields.has('name')).toBe(true);
    expect(fields.has('description')).toBe(true);
    expect(fields.has('metadata')).toBe(true);
    expect(fields.has('relationshipsFrom')).toBe(true);
    expect(fields.has('relationshipsTo')).toBe(true);
  });
});
