/**
 * Test for Issue #950: ObjectRegistry silently drops sibling-module classes
 * with same simple name in manifest registration path.
 *
 * PROBLEM:
 * - registerFromManifest() uses a flat classNameMap for deduplication
 * - When two packages define classes with the same simple name (e.g., "Event"),
 *   the second registration is silently dropped — no error, no warning
 * - The decorator-based register() path handles this via instanceof child-wins
 *   semantics, but the manifest path had no equivalent
 *
 * SOLUTION:
 * - Added resolveManifestCollision() that uses string-based extends field
 *   comparison to detect STI parent/child relationships
 * - Child-wins: manifest child replaces parent with same name
 * - Parent after child: silently skips (correct behavior)
 * - Same source file: silently skips (re-export, not a collision)
 * - True collision: logs warning, keeps first
 *
 * Also updated getClassNameIndex() in manifest-loader to apply the same
 * child-wins logic within a single manifest.
 *
 * @see https://github.com/happyvertical/smrt/issues/950
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ObjectRegistry } from '../registry.js';
import type { SmartObjectDefinition } from '../scanner/types.js';
import { snapshotObjectRegistryState } from '../test-utils.js';

type FixtureManifestDefinition = Omit<
  SmartObjectDefinition,
  'name' | 'collection'
> &
  Partial<Pick<SmartObjectDefinition, 'name' | 'collection'>>;

function registerManifestFixture(
  key: string,
  definition: FixtureManifestDefinition,
  packageName: string,
): void {
  const lower = definition.className.toLowerCase();
  const collection = lower.endsWith('y')
    ? `${lower.slice(0, -1)}ies`
    : /(?:s|x|z|ch|sh)$/.test(lower)
      ? `${lower}es`
      : `${lower}s`;
  ObjectRegistry.registerFromManifest(
    key,
    { name: lower, collection, ...definition },
    packageName,
  );
}

describe('Issue #950: Manifest STI Collision Handling', () => {
  let restoreRegistry: () => void;

  beforeEach(() => {
    restoreRegistry = snapshotObjectRegistryState();
  });

  afterEach(() => {
    restoreRegistry();
  });

  describe('registerFromManifest - STI child-wins', () => {
    it('should replace parent when child with same name is registered second', () => {
      const parentDef: FixtureManifestDefinition = {
        className: 'TestEvent',
        fields: {
          title: { type: 'text', _meta: {} },
        },
        methods: {},
        decoratorConfig: {},
        filePath: '/packages/events/src/models/Event.ts',
      };

      const childDef: FixtureManifestDefinition = {
        className: 'TestEvent',
        fields: {
          title: { type: 'text', _meta: {} },
          sport: { type: 'text', _meta: {} },
        },
        methods: {},
        decoratorConfig: {},
        extends: 'TestEvent',
        filePath: '/packages/sports/src/models/Event.ts',
      };

      // Parent registered first
      registerManifestFixture('TestEvent', parentDef, '@test/events');

      // Verify parent is registered
      const parentEntry = ObjectRegistry.getClass('TestEvent');
      expect(parentEntry).toBeDefined();
      expect(parentEntry?.fields.size).toBe(1);
      expect(parentEntry?.packageName).toBe('@test/events');

      // Child registered second — should replace parent
      registerManifestFixture('TestEvent', childDef, '@test/sports');

      // Verify child replaced parent
      const childEntry = ObjectRegistry.getClass('TestEvent');
      expect(childEntry).toBeDefined();
      expect(childEntry?.fields.size).toBe(2);
      expect(childEntry?.fields.has('sport')).toBe(true);
      expect(childEntry?.packageName).toBe('@test/sports');
      expect(childEntry?.extends).toBe('TestEvent');
    });

    it('should replace parent when child uses qualified name registration', () => {
      const parentDef: FixtureManifestDefinition = {
        className: 'TestBase',
        fields: {
          title: { type: 'text', _meta: {} },
        },
        methods: {},
        decoratorConfig: {},
        filePath: '/packages/core/src/models/Base.ts',
      };

      const childDef: FixtureManifestDefinition = {
        className: 'TestBase',
        fields: {
          title: { type: 'text', _meta: {} },
          extra: { type: 'text', _meta: {} },
        },
        methods: {},
        decoratorConfig: {},
        extends: 'TestBase',
        filePath: '/packages/agent/src/models/Base.ts',
      };

      // Parent registered with qualified name
      registerManifestFixture('@test/core:TestBase', parentDef, '@test/core');

      // Verify parent is accessible via simple name
      const parentEntry = ObjectRegistry.getClass('TestBase');
      expect(parentEntry).toBeDefined();
      expect(parentEntry?.packageName).toBe('@test/core');

      // Child registered with simple name — hits classNameMap alias
      registerManifestFixture('TestBase', childDef, '@test/agent');

      // Verify child replaced parent
      const childEntry = ObjectRegistry.getClass('TestBase');
      expect(childEntry).toBeDefined();
      expect(childEntry?.fields.size).toBe(2);
      expect(childEntry?.packageName).toBe('@test/agent');
    });

    it('should keep child when parent arrives after child', () => {
      const childDef: FixtureManifestDefinition = {
        className: 'TestChild',
        fields: {
          title: { type: 'text', _meta: {} },
          extra: { type: 'text', _meta: {} },
        },
        methods: {},
        decoratorConfig: {},
        extends: 'TestChild',
        filePath: '/packages/agent/src/models/Child.ts',
      };

      const parentDef: FixtureManifestDefinition = {
        className: 'TestChild',
        fields: {
          title: { type: 'text', _meta: {} },
        },
        methods: {},
        decoratorConfig: {},
        filePath: '/packages/core/src/models/Child.ts',
      };

      // Child registered first
      registerManifestFixture('TestChild', childDef, '@test/agent');

      // Verify child is registered
      const childEntry = ObjectRegistry.getClass('TestChild');
      expect(childEntry).toBeDefined();
      expect(childEntry?.fields.size).toBe(2);

      // Parent arrives second — should be skipped
      registerManifestFixture('TestChild', parentDef, '@test/core');

      // Verify child is still there (not replaced by parent)
      const stillChild = ObjectRegistry.getClass('TestChild');
      expect(stillChild).toBeDefined();
      expect(stillChild?.fields.size).toBe(2);
      expect(stillChild?.packageName).toBe('@test/agent');
    });

    it('keeps cross-package STI child when a parent with a qualified extends key arrives (PR #1140 review)', () => {
      // Scenario from the deep-review on #1140: when a child class
      // extends a parent that is ALREADY registered at the time the
      // child loads, `qualifyExtendsName()` resolves the child's
      // `extends` to the parent's fully-qualified key — not the simple
      // parent name. Later, when the parent manifest arrives for the
      // same canonical name, `existingExtendsNew` must recognize the
      // qualified value as pointing at the new parent's key and skip.
      //
      // Pre-fix, the comparison only checked the simple name / manifest
      // key and missed the qualified form, silently registering a
      // duplicate parent entry. The `registrationKey` comparison added
      // to buildManifestCollisionInputs at class-registration.ts:260
      // closes that gap.
      const parentDef: FixtureManifestDefinition = {
        className: 'StiQualifiedParent',
        fields: { name: { type: 'text', _meta: {} } },
        methods: {},
        decoratorConfig: {},
        filePath: '/packages/events/src/models/Parent.ts',
      };

      // Register the parent first so qualifyExtendsName can resolve the
      // child's `extends` string to the qualified parent key.
      registerManifestFixture('StiQualifiedParent', parentDef, '@test/events');

      const childDef: FixtureManifestDefinition = {
        className: 'StiQualifiedChild',
        fields: { title: { type: 'text', _meta: {} } },
        methods: {},
        decoratorConfig: {},
        extends: 'StiQualifiedParent',
        filePath: '/packages/sports/src/models/Child.ts',
      };

      registerManifestFixture('StiQualifiedChild', childDef, '@test/sports');

      // Confirm the child stored the parent's QUALIFIED key, not the
      // simple name — this is what makes the regression possible.
      const child = ObjectRegistry.getClass('StiQualifiedChild');
      expect(child?.extends).toBe('@test/events:StiQualifiedParent');

      // Now the parent manifest arrives again, e.g. via STI sibling
      // auto-load. Pre-fix, `existingExtendsNew` returned false and the
      // parent would register a duplicate entry. With the fix, the
      // child's qualified `extends` matches the parent's registrationKey
      // → `manifest-sti-parent-skip` → skip.
      registerManifestFixture('StiQualifiedParent', parentDef, '@test/events');

      // Only one parent entry exists; not duplicated.
      const parents = ObjectRegistry.findClassesByName('StiQualifiedParent');
      expect(parents).toHaveLength(1);
      expect(parents[0].packageName).toBe('@test/events');
    });

    it('should skip re-export with same source file', () => {
      const def: FixtureManifestDefinition = {
        className: 'TestWidget950',
        fields: {
          name: { type: 'text', _meta: {} },
        },
        methods: {},
        decoratorConfig: {},
        filePath: '/packages/profiles/src/models/Widget.ts',
      };

      // First registration
      registerManifestFixture('TestWidget950', def, '@test/profiles');

      // Same class re-exported from consumer package with same filePath
      registerManifestFixture('TestWidget950', { ...def }, '@test/users');

      // Should still have the first registration
      const entry = ObjectRegistry.getClass('TestWidget950');
      expect(entry).toBeDefined();
      expect(entry?.packageName).toBe('@test/profiles');
    });

    it('should not replace on true collision (unrelated classes)', () => {
      const firstDef: FixtureManifestDefinition = {
        className: 'TestGadget950',
        fields: {
          name: { type: 'text', _meta: {} },
        },
        methods: {},
        decoratorConfig: {},
        filePath: '/packages/a/src/models/Gadget.ts',
      };

      const secondDef: FixtureManifestDefinition = {
        className: 'TestGadget950',
        fields: {
          label: { type: 'text', _meta: {} },
        },
        methods: {},
        decoratorConfig: {},
        filePath: '/packages/b/src/models/Gadget.ts',
      };

      // First registration
      registerManifestFixture('TestGadget950', firstDef, '@test/package-a');

      // Second registration — different class, no inheritance
      registerManifestFixture('TestGadget950', secondDef, '@test/package-b');

      // First one wins — second is skipped (with verbose log)
      const entry = ObjectRegistry.getClass('TestGadget950');
      expect(entry).toBeDefined();
      expect(entry?.fields.has('name')).toBe(true);
      expect(entry?.fields.has('label')).toBe(false);
      expect(entry?.packageName).toBe('@test/package-a');
    });

    it('should handle child-wins with case-insensitive matching', () => {
      const parentDef: FixtureManifestDefinition = {
        className: 'TestEvent',
        fields: {
          title: { type: 'text', _meta: {} },
        },
        methods: {},
        decoratorConfig: {},
        filePath: '/packages/events/src/Event.ts',
      };

      const childDef: FixtureManifestDefinition = {
        className: 'TestEvent',
        fields: {
          title: { type: 'text', _meta: {} },
          venue: { type: 'text', _meta: {} },
        },
        methods: {},
        decoratorConfig: {},
        extends: 'testevent', // lowercase extends reference
        filePath: '/packages/conferences/src/Event.ts',
      };

      registerManifestFixture('TestEvent', parentDef, '@test/events');

      registerManifestFixture('TestEvent', childDef, '@test/conferences');

      const entry = ObjectRegistry.getClass('TestEvent');
      expect(entry).toBeDefined();
      expect(entry?.fields.size).toBe(2);
      expect(entry?.packageName).toBe('@test/conferences');
    });
  });
});
