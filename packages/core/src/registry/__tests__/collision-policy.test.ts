/**
 * Unit tests for the Release C collision-policy decision table.
 *
 * One describe/it per row in the table. Pure-function tests: no registry
 * side effects. The integration parity tests in class-registration still
 * exercise the production paths and will catch any regression where the
 * table routes the same inputs differently than today's if/else tree.
 *
 * @see https://github.com/happyvertical/smrt/issues/1134
 */

import { describe, expect, it } from 'vitest';
import {
  __POLICY_ROWS_FOR_TEST,
  type CollisionInputs,
  decideCollisionPolicy,
} from '../collision-policy.js';

/**
 * Baseline inputs with every field set to its "no match" value. Individual
 * tests override only the fields relevant to their scenario — keeps the
 * table test rows short and keeps the reader's attention on what actually
 * matters for each row.
 */
function baseline(overrides: Partial<CollisionInputs> = {}): CollisionInputs {
  return {
    origin: 'decorator',
    matchKind: 'exact-key',
    sameConstructor: false,
    sameSourceFile: false,
    bothSourceFilesKnown: true,
    existingIsManifestStub: false,
    newInBundledContext: false,
    newExtendsExisting: false,
    existingExtendsNew: false,
    samePackage: false,
    existingIsPackageQualified: false,
    sameName: false,
    hasNewQualifiedKey: false,
    existingKeyIsQualified: false,
    hasManifestContent: false,
    registrationKeyDiffersFromExistingKey: false,
    existingHasNoPackage: false,
    ...overrides,
  };
}

describe('decideCollisionPolicy', () => {
  describe('cross-origin rows', () => {
    it('same-constructor-reregistration → accept (highest priority)', () => {
      // Covers vitest module re-evaluation + HMR. Must beat every other
      // row because the new "class" is literally the same constructor.
      const result = decideCollisionPolicy(baseline({ sameConstructor: true }));
      expect(result.policy).toBe('accept');
      expect(result.scenario).toBe('same-constructor-reregistration');
    });

    it('manifest-stub-replacement → replace', () => {
      // Issue #531, #847: manifest builder registered a stub placeholder;
      // the real decorated class loads and takes over.
      const result = decideCollisionPolicy(
        baseline({ existingIsManifestStub: true }),
      );
      expect(result.policy).toBe('replace');
      expect(result.scenario).toBe('manifest-stub-replacement');
    });

    it('same-constructor wins even when existing is a manifest stub', () => {
      // Sanity: stub placeholders with the same constructor shouldn't force
      // a replace — the constructor identity win is stronger.
      const result = decideCollisionPolicy(
        baseline({
          sameConstructor: true,
          existingIsManifestStub: true,
        }),
      );
      expect(result.scenario).toBe('same-constructor-reregistration');
    });
  });

  describe('manifest-origin rows', () => {
    it('manifest-same-source-file → skip (re-export, not a real collision)', () => {
      const result = decideCollisionPolicy(
        baseline({
          origin: 'manifest',
          sameSourceFile: true,
          bothSourceFilesKnown: true,
        }),
      );
      expect(result.policy).toBe('skip');
      expect(result.scenario).toBe('manifest-same-source-file');
    });

    it('manifest-sti-child-wins → replace', () => {
      // Issue #950: new manifest entry extends existing; STI child wins.
      const result = decideCollisionPolicy(
        baseline({
          origin: 'manifest',
          newExtendsExisting: true,
        }),
      );
      expect(result.policy).toBe('replace');
      expect(result.scenario).toBe('manifest-sti-child-wins');
    });

    it('manifest-sti-parent-skip → skip', () => {
      // Reverse direction: existing is already the child.
      const result = decideCollisionPolicy(
        baseline({
          origin: 'manifest',
          existingExtendsNew: true,
        }),
      );
      expect(result.policy).toBe('skip');
      expect(result.scenario).toBe('manifest-sti-parent-skip');
    });

    it('manifest-different-packages-qualified-coexist → coexist-qualified', () => {
      // Issue #951: two packages define the same simple class name;
      // both live under their qualified keys.
      const result = decideCollisionPolicy(
        baseline({
          origin: 'manifest',
          samePackage: false,
          hasNewQualifiedKey: true,
          existingIsPackageQualified: true,
        }),
      );
      expect(result.policy).toBe('coexist-qualified');
      expect(result.scenario).toBe(
        'manifest-different-packages-qualified-coexist',
      );
    });

    it('manifest-same-package-merge → merge-manifest (when there is content to merge)', () => {
      // Issue #1000 + #951:144-200: same-package manifest arriving for an
      // existing source registration; merge fields + alias the qualified key.
      const result = decideCollisionPolicy(
        baseline({
          origin: 'manifest',
          samePackage: true,
          hasManifestContent: true,
        }),
      );
      expect(result.policy).toBe('merge-manifest');
      expect(result.scenario).toBe('manifest-same-package-merge');
    });

    it('manifest-same-package without content → skip (merge has nothing to fold in)', () => {
      // Guards the `hasManifestContent` gate: empty manifest entries must
      // NOT trigger a merge-manifest policy, otherwise the caller would
      // alias a qualified key and incorrectly report a merge.
      const result = decideCollisionPolicy(
        baseline({
          origin: 'manifest',
          samePackage: true,
          hasManifestContent: false,
        }),
      );
      expect(result.scenario).toBe('manifest-default-skip');
    });

    it('manifest-default-skip → skip (pre-Release-C resolveManifestCollision default)', () => {
      // Manifest path used to return 'skip' as its final default (not throw).
      const result = decideCollisionPolicy(baseline({ origin: 'manifest' }));
      expect(result.policy).toBe('skip');
      expect(result.scenario).toBe('manifest-default-skip');
    });

    it('manifest sti-child-wins precedence: STI check beats same-package merge', () => {
      // Ordering check: if new extends existing AND both in the same
      // package, STI child-wins should win (replace), not merge.
      const result = decideCollisionPolicy(
        baseline({
          origin: 'manifest',
          newExtendsExisting: true,
          samePackage: true,
        }),
      );
      expect(result.scenario).toBe('manifest-sti-child-wins');
    });
  });

  describe('decorator-origin rows', () => {
    it('decorator-exact-match-same-package-external → accept', () => {
      // Issue #584: external package manifest entry replaced by its own
      // real decorated class from the same package.
      const result = decideCollisionPolicy(
        baseline({
          origin: 'decorator',
          matchKind: 'exact-key',
          existingIsPackageQualified: true,
          samePackage: true,
        }),
      );
      expect(result.policy).toBe('accept');
      expect(result.scenario).toBe(
        'decorator-exact-match-same-package-external',
      );
    });

    it('decorator-case-insensitive-pnpm-duplicate → accept', () => {
      // pnpm store duplicates — different physical constructor but same
      // package + same exact class name + existing has qualified key.
      const result = decideCollisionPolicy(
        baseline({
          origin: 'decorator',
          matchKind: 'case-insensitive',
          existingKeyIsQualified: true,
          existingIsPackageQualified: true,
          samePackage: true,
          sameName: true,
        }),
      );
      expect(result.policy).toBe('accept');
      expect(result.scenario).toBe('decorator-case-insensitive-pnpm-duplicate');
    });

    it('decorator-case-insensitive-pnpm-duplicate requires sameName (strict case-sensitive)', () => {
      // The pnpm-dup guard requires exact name match, not case-insensitive.
      // Without sameName, we'd treat it as a real collision.
      const result = decideCollisionPolicy(
        baseline({
          origin: 'decorator',
          matchKind: 'case-insensitive',
          existingKeyIsQualified: true,
          existingIsPackageQualified: true,
          samePackage: true,
          sameName: false,
        }),
      );
      expect(result.scenario).not.toBe(
        'decorator-case-insensitive-pnpm-duplicate',
      );
    });

    it('decorator-bundled-context-known-package → accept', () => {
      const result = decideCollisionPolicy(
        baseline({
          origin: 'decorator',
          newInBundledContext: true,
          existingIsPackageQualified: true,
        }),
      );
      expect(result.policy).toBe('accept');
      expect(result.scenario).toBe('decorator-bundled-context-known-package');
    });

    it('decorator-bundled-context requires existing to be package-qualified', () => {
      // Bundler edge: existing must come from a known package manifest
      // (not a test fixture etc.) to accept a duplicate.
      const result = decideCollisionPolicy(
        baseline({
          origin: 'decorator',
          newInBundledContext: true,
          existingIsPackageQualified: false,
        }),
      );
      expect(result.scenario).not.toBe(
        'decorator-bundled-context-known-package',
      );
    });

    it('decorator-same-source-file → accept (Issue #555 test isolation)', () => {
      const result = decideCollisionPolicy(
        baseline({
          origin: 'decorator',
          sameSourceFile: true,
          bothSourceFilesKnown: true,
        }),
      );
      expect(result.policy).toBe('accept');
      expect(result.scenario).toBe('decorator-same-source-file');
    });

    it('decorator-unknown-source-fallback → accept when sources cannot be compared', () => {
      const result = decideCollisionPolicy(
        baseline({
          origin: 'decorator',
          sameSourceFile: false,
          bothSourceFilesKnown: false,
        }),
      );
      expect(result.policy).toBe('accept');
      expect(result.scenario).toBe('decorator-unknown-source-fallback');
    });
  });

  describe('STI inheritance rows (fallback for decorator path after source-file rows)', () => {
    it('sti-child-wins → replace', () => {
      // Issue #950 — decorator path: new.ctor.prototype instanceof existing.
      const result = decideCollisionPolicy(
        baseline({
          origin: 'decorator',
          bothSourceFilesKnown: true,
          newExtendsExisting: true,
        }),
      );
      expect(result.policy).toBe('replace');
      expect(result.scenario).toBe('sti-child-wins');
    });

    it('sti-parent-skip → skip', () => {
      const result = decideCollisionPolicy(
        baseline({
          origin: 'decorator',
          bothSourceFilesKnown: true,
          existingExtendsNew: true,
        }),
      );
      expect(result.policy).toBe('skip');
      expect(result.scenario).toBe('sti-parent-skip');
    });
  });

  describe('default: true collision', () => {
    it('decorator path with no mitigating signal → throw', () => {
      // Different constructors, different source files, no inheritance
      // relationship, no package or stub context — genuine name collision.
      const result = decideCollisionPolicy(
        baseline({
          origin: 'decorator',
          bothSourceFilesKnown: true,
        }),
      );
      expect(result.policy).toBe('throw');
      expect(result.scenario).toBe('true-collision');
    });
  });

  describe('row coverage and reasons', () => {
    it('every row has a unique scenario id', () => {
      const ids = __POLICY_ROWS_FOR_TEST.map((row) => row.scenario);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('every decision returns a non-empty reason string', () => {
      // Pick one row per policy type to smoke-test reasons end up populated.
      const samples: Array<CollisionInputs> = [
        baseline({ sameConstructor: true }),
        baseline({ existingIsManifestStub: true }),
        baseline({ origin: 'manifest' }),
        baseline({ origin: 'manifest', samePackage: true }),
        baseline({
          origin: 'manifest',
          hasNewQualifiedKey: true,
          existingIsPackageQualified: true,
        }),
        baseline({ newExtendsExisting: true, bothSourceFilesKnown: true }),
        baseline({ bothSourceFilesKnown: true }),
      ];
      for (const inputs of samples) {
        const decision = decideCollisionPolicy(inputs);
        expect(decision.reason.length).toBeGreaterThan(0);
      }
    });
  });
});
