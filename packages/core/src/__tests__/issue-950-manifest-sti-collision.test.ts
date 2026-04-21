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
import { snapshotObjectRegistryState } from '../test-utils.js';

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
      const parentDef = {
        className: 'TestEvent',
        fields: {
          title: { type: 'text', _meta: {} },
        },
        methods: {},
        decoratorConfig: {},
        filePath: '/packages/events/src/models/Event.ts',
      };

      const childDef = {
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
      ObjectRegistry.registerFromManifest(
        'TestEvent',
        parentDef,
        '@test/events',
      );

      // Verify parent is registered
      const parentEntry = ObjectRegistry.findClass('TestEvent');
      expect(parentEntry).toBeDefined();
      expect(parentEntry?.fields.size).toBe(1);
      expect(parentEntry?.packageName).toBe('@test/events');

      // Child registered second — should replace parent
      ObjectRegistry.registerFromManifest(
        'TestEvent',
        childDef,
        '@test/sports',
      );

      // Verify child replaced parent
      const childEntry = ObjectRegistry.findClass('TestEvent');
      expect(childEntry).toBeDefined();
      expect(childEntry?.fields.size).toBe(2);
      expect(childEntry?.fields.has('sport')).toBe(true);
      expect(childEntry?.packageName).toBe('@test/sports');
      expect(childEntry?.extends).toBe('TestEvent');
    });

    it('should replace parent when child uses qualified name registration', () => {
      const parentDef = {
        className: 'TestBase',
        fields: {
          title: { type: 'text', _meta: {} },
        },
        methods: {},
        decoratorConfig: {},
        filePath: '/packages/core/src/models/Base.ts',
      };

      const childDef = {
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
      ObjectRegistry.registerFromManifest(
        '@test/core:TestBase',
        parentDef,
        '@test/core',
      );

      // Verify parent is accessible via simple name
      const parentEntry = ObjectRegistry.findClass('TestBase');
      expect(parentEntry).toBeDefined();
      expect(parentEntry?.packageName).toBe('@test/core');

      // Child registered with simple name — hits classNameMap alias
      ObjectRegistry.registerFromManifest('TestBase', childDef, '@test/agent');

      // Verify child replaced parent
      const childEntry = ObjectRegistry.findClass('TestBase');
      expect(childEntry).toBeDefined();
      expect(childEntry?.fields.size).toBe(2);
      expect(childEntry?.packageName).toBe('@test/agent');
    });

    it('should keep child when parent arrives after child', () => {
      const childDef = {
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

      const parentDef = {
        className: 'TestChild',
        fields: {
          title: { type: 'text', _meta: {} },
        },
        methods: {},
        decoratorConfig: {},
        filePath: '/packages/core/src/models/Child.ts',
      };

      // Child registered first
      ObjectRegistry.registerFromManifest('TestChild', childDef, '@test/agent');

      // Verify child is registered
      const childEntry = ObjectRegistry.findClass('TestChild');
      expect(childEntry).toBeDefined();
      expect(childEntry?.fields.size).toBe(2);

      // Parent arrives second — should be skipped
      ObjectRegistry.registerFromManifest('TestChild', parentDef, '@test/core');

      // Verify child is still there (not replaced by parent)
      const stillChild = ObjectRegistry.findClass('TestChild');
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
      const parentDef = {
        className: 'StiQualifiedParent',
        fields: { name: { type: 'text', _meta: {} } },
        methods: {},
        decoratorConfig: {},
        filePath: '/packages/events/src/models/Parent.ts',
      };

      // Register the parent first so qualifyExtendsName can resolve the
      // child's `extends` string to the qualified parent key.
      ObjectRegistry.registerFromManifest(
        'StiQualifiedParent',
        parentDef,
        '@test/events',
      );

      const childDef = {
        className: 'StiQualifiedChild',
        fields: { title: { type: 'text', _meta: {} } },
        methods: {},
        decoratorConfig: {},
        extends: 'StiQualifiedParent',
        filePath: '/packages/sports/src/models/Child.ts',
      };

      ObjectRegistry.registerFromManifest(
        'StiQualifiedChild',
        childDef,
        '@test/sports',
      );

      // Confirm the child stored the parent's QUALIFIED key, not the
      // simple name — this is what makes the regression possible.
      const child = ObjectRegistry.findClass('StiQualifiedChild');
      expect(child?.extends).toBe('@test/events:StiQualifiedParent');

      // Now the parent manifest arrives again, e.g. via STI sibling
      // auto-load. Pre-fix, `existingExtendsNew` returned false and the
      // parent would register a duplicate entry. With the fix, the
      // child's qualified `extends` matches the parent's registrationKey
      // → `manifest-sti-parent-skip` → skip.
      ObjectRegistry.registerFromManifest(
        'StiQualifiedParent',
        parentDef,
        '@test/events',
      );

      // Only one parent entry exists; not duplicated.
      const parents = ObjectRegistry.findClassesByName('StiQualifiedParent');
      expect(parents).toHaveLength(1);
      expect(parents[0].packageName).toBe('@test/events');
    });

    it('should skip re-export with same source file', () => {
      const def = {
        className: 'TestWidget950',
        fields: {
          name: { type: 'text', _meta: {} },
        },
        methods: {},
        decoratorConfig: {},
        filePath: '/packages/profiles/src/models/Widget.ts',
      };

      // First registration
      ObjectRegistry.registerFromManifest(
        'TestWidget950',
        def,
        '@test/profiles',
      );

      // Same class re-exported from consumer package with same filePath
      ObjectRegistry.registerFromManifest(
        'TestWidget950',
        { ...def },
        '@test/users',
      );

      // Should still have the first registration
      const entry = ObjectRegistry.findClass('TestWidget950');
      expect(entry).toBeDefined();
      expect(entry?.packageName).toBe('@test/profiles');
    });

    it('should not replace on true collision (unrelated classes)', () => {
      const firstDef = {
        className: 'TestGadget950',
        fields: {
          name: { type: 'text', _meta: {} },
        },
        methods: {},
        decoratorConfig: {},
        filePath: '/packages/a/src/models/Gadget.ts',
      };

      const secondDef = {
        className: 'TestGadget950',
        fields: {
          label: { type: 'text', _meta: {} },
        },
        methods: {},
        decoratorConfig: {},
        filePath: '/packages/b/src/models/Gadget.ts',
      };

      // First registration
      ObjectRegistry.registerFromManifest(
        'TestGadget950',
        firstDef,
        '@test/package-a',
      );

      // Second registration — different class, no inheritance
      ObjectRegistry.registerFromManifest(
        'TestGadget950',
        secondDef,
        '@test/package-b',
      );

      // First one wins — second is skipped (with verbose log)
      const entry = ObjectRegistry.findClass('TestGadget950');
      expect(entry).toBeDefined();
      expect(entry?.fields.has('name')).toBe(true);
      expect(entry?.fields.has('label')).toBe(false);
      expect(entry?.packageName).toBe('@test/package-a');
    });

    it('should handle child-wins with case-insensitive matching', () => {
      const parentDef = {
        className: 'TestEvent',
        fields: {
          title: { type: 'text', _meta: {} },
        },
        methods: {},
        decoratorConfig: {},
        filePath: '/packages/events/src/Event.ts',
      };

      const childDef = {
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

      ObjectRegistry.registerFromManifest(
        'TestEvent',
        parentDef,
        '@test/events',
      );

      ObjectRegistry.registerFromManifest(
        'TestEvent',
        childDef,
        '@test/conferences',
      );

      const entry = ObjectRegistry.findClass('TestEvent');
      expect(entry).toBeDefined();
      expect(entry?.fields.size).toBe(2);
      expect(entry?.packageName).toBe('@test/conferences');
    });
  });
});
