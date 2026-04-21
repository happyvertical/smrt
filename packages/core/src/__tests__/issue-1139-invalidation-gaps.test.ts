/**
 * Regression tests for the two invalidation gaps fixed in #1139.
 *
 * Gap 1: `ObjectRegistry.invalidateInheritanceCache(className)` used to
 * recurse via `childClass.extends === className` — exact simple-name
 * match. Manifest registration stores qualified extends values (e.g.
 * `@pkg:Parent`). If the invalidator was given the simple name,
 * descendants with qualified extends stayed stale. The fix rewires the
 * public helper through `invalidateInheritanceEntries`, which matches
 * against both simple and qualified names.
 *
 * Gap 2: `upsertExistingEntry` mutates `existing.name`,
 * `existing.packageName`, `existing.qualifiedName`, `existing.config`,
 * `existing.constructor`, and `existing.schema.tableName` in place.
 * Descendants whose `inheritedFields` cache was computed against the
 * pre-mutation identity stayed stale. The fix captures the pre-mutation
 * identity and passes it to `invalidateInheritanceEntries` so the sweep
 * catches descendants referencing either the old or the new name.
 *
 * @see https://github.com/happyvertical/smrt/issues/1139
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { field } from '../decorators/index.js';
import { SmrtObject } from '../object.js';
import { ObjectRegistry, smrt } from '../registry.js';
import { snapshotObjectRegistryState } from '../test-utils.js';

describe('#1139 invalidation gaps', () => {
  let restoreRegistry: () => void;

  beforeAll(() => {
    restoreRegistry = snapshotObjectRegistryState();
  });

  afterEach(() => {
    ObjectRegistry.clear();
  });

  afterAll(() => {
    restoreRegistry();
  });

  describe('Gap 1 — invalidateInheritanceCache with qualified extends', () => {
    it('invalidates a descendant whose `extends` is stored as a qualified name', () => {
      // Scenario: parent is package-qualified (@test/a:RehydrateBase). Child
      // from another package extends it; after Release C's qualifyExtendsName,
      // `child.extends = '@test/a:RehydrateBase'` (qualified, not simple).
      //
      // `ObjectRegistry.invalidateInheritanceCache('RehydrateBase')` is called
      // with the SIMPLE name (what registry.ts's manifest-load field-change
      // path does). Pre-fix the public helper only recursed on exact-simple
      // match, so the qualified child stayed stale. Post-fix it delegates to
      // `invalidateInheritanceEntries` which matches both forms.

      // Register parent.
      ObjectRegistry.registerFromManifest(
        'RehydrateBase',
        {
          className: 'RehydrateBase',
          fields: { title: { type: 'text', _meta: {} } },
          methods: {},
          decoratorConfig: { tableStrategy: 'sti' },
          filePath: '/pkg/a/base.ts',
        },
        '@test/a',
      );

      // Register child — extends will be qualified to @test/a:RehydrateBase.
      ObjectRegistry.registerFromManifest(
        'RehydrateChild',
        {
          className: 'RehydrateChild',
          fields: { body: { type: 'text', _meta: {} } },
          methods: {},
          decoratorConfig: { tableStrategy: 'sti' },
          extends: 'RehydrateBase',
          filePath: '/pkg/b/child.ts',
        },
        '@test/b',
      );

      const child = ObjectRegistry.findClass('RehydrateChild');
      expect(child?.extends).toBe('@test/a:RehydrateBase');

      // Prime the cache.
      const baseWalk = ObjectRegistry.getClass('RehydrateBase');
      const childWalk = ObjectRegistry.getClass('RehydrateChild');
      if (baseWalk)
        baseWalk.inheritedFields = new Map([['cached', 'sentinel']]);
      if (childWalk)
        childWalk.inheritedFields = new Map([['cached', 'sentinel']]);

      // Fire the public invalidator with the SIMPLE name.
      ObjectRegistry.invalidateInheritanceCache('RehydrateBase');

      // Parent cache: cleared (direct lookup hit).
      expect(baseWalk?.inheritedFields).toBeUndefined();

      // Child cache: also cleared because the child's extends resolves to
      // the same class via qualified-name match.
      expect(childWalk?.inheritedFields).toBeUndefined();
    });
  });

  describe('Gap 2 — upsertExistingEntry invalidates descendants', () => {
    it("clears a descendant's cached inheritedFields when the parent's identity is mutated via promotion", () => {
      // Scenario: parent registered without a packageName (simple key
      // 'PromoteBase'). Child registered with `extends: 'PromoteBase'`.
      // Parent later promoted to `@test/promote:PromoteBase` via a
      // register() call that carries the packageName. upsertExistingEntry
      // mutates `existing.name`/`packageName`/`qualifiedName` in place.
      //
      // Pre-fix the post-mutation invalidation sweep used only the NEW
      // identity to match descendants — but the child's `extends` still
      // referenced the OLD qualified name, so its cache stayed stale.
      // Post-fix we capture the pre-mutation identity and pass both old
      // and new forms into `invalidateInheritanceEntries`.

      // Register a "source-only" parent via the decorator path — the only
      // path that reaches upsertExistingEntry with a real class.
      @smrt({ tableStrategy: 'sti' })
      class PromoteBase extends SmrtObject {
        @field({ type: 'text' })
        baseField: string = '';
      }

      // Register a child whose extends points at the simple name.
      ObjectRegistry.registerFromManifest(
        'PromoteChild',
        {
          className: 'PromoteChild',
          fields: { childField: { type: 'text', _meta: {} } },
          methods: {},
          decoratorConfig: { tableStrategy: 'sti' },
          extends: 'PromoteBase',
          filePath: '/pkg/a/promote-child.ts',
        },
        '@test/promote',
      );

      // Prime the cache on the child with a sentinel.
      const child = ObjectRegistry.findClass('PromoteChild');
      if (child) child.inheritedFields = new Map([['sentinel', 'present']]);

      // Re-register the parent with a packageName — routes through
      // register() → exact-key match → upsertExistingEntry, which promotes
      // the parent's key from 'PromoteBase' to '@test/promote:PromoteBase'.
      ObjectRegistry.register(PromoteBase, { packageName: '@test/promote' });

      const childAfter = ObjectRegistry.findClass('PromoteChild');
      expect(childAfter?.inheritedFields?.get('sentinel')).toBeUndefined();
      // Suppress the unused-class warning — the decorator ran on it.
      void PromoteBase;
    });
  });
});
