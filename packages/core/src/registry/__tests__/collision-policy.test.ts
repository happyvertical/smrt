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
    newDeclaredChoice: undefined,
    existingDeclaredChoice: undefined,
    samePackage: false,
    existingIsPackageQualified: false,
    sameName: false,
    hasNewQualifiedKey: false,
    existingKeyIsQualified: false,
    hasManifestContent: false,
    registrationKeyDiffersFromExistingKey: false,
    existingHasNoPackage: false,
    existingHasAnyPackage: false,
    declaresDifferentTable: false,
    existingPackageStampsConstructors: false,
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

    it('manifest-default-skip → skip (pre-Release-C resolveManifestCollision default)', () => {
      // Manifest path used to return 'skip' as its final default (not throw).
      const result = decideCollisionPolicy(baseline({ origin: 'manifest' }));
      expect(result.policy).toBe('skip');
      expect(result.scenario).toBe('manifest-default-skip');
    });

    it('a same-named pair is decided before the same-package merge', () => {
      // Ordering check: an inheritance edge is decided by the declared
      // choice even when both sides report one package.
      const result = decideCollisionPolicy(
        baseline({
          origin: 'manifest',
          newExtendsExisting: true,
          newDeclaredChoice: 'replace',
          samePackage: true,
          hasManifestContent: true,
        }),
      );
      expect(result.scenario).toBe('same-name-subclass-replaces-parent');
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

  describe('decorator-different-packages-qualified-coexist (#3106)', () => {
    const differentPackages = {
      origin: 'decorator' as const,
      matchKind: 'case-insensitive' as const,
      hasNewQualifiedKey: true,
      existingHasAnyPackage: true,
      existingIsPackageQualified: true,
      existingKeyIsQualified: true,
      sameName: true,
    };

    it('a source class of another package coexists instead of throwing', () => {
      const result = decideCollisionPolicy(baseline(differentPackages));
      expect(result.policy).toBe('coexist-qualified');
      expect(result.scenario).toBe(
        'decorator-different-packages-qualified-coexist',
      );
    });

    it('also when the existing entry has no comparable source file', () => {
      const result = decideCollisionPolicy(
        baseline({ ...differentPackages, bothSourceFilesKnown: false }),
      );
      expect(result.policy).toBe('coexist-qualified');
    });

    it('bundled output coexists only when the class declares another table', () => {
      expect(
        decideCollisionPolicy(
          baseline({ ...differentPackages, newInBundledContext: true }),
        ).scenario,
      ).toBe('decorator-bundled-context-known-package');
      expect(
        decideCollisionPolicy(
          baseline({
            ...differentPackages,
            newInBundledContext: true,
            declaresDifferentTable: true,
          }),
        ).policy,
      ).toBe('coexist-qualified');
    });

    it('leaves same-package duplicates, same files and same-named pairs to their rows', () => {
      expect(
        decideCollisionPolicy(
          baseline({ ...differentPackages, samePackage: true }),
        ).scenario,
      ).toBe('decorator-case-insensitive-pnpm-duplicate');
      expect(
        decideCollisionPolicy(
          baseline({ ...differentPackages, sameSourceFile: true }),
        ).scenario,
      ).toBe('decorator-same-source-file');
      expect(
        decideCollisionPolicy(
          baseline({
            ...differentPackages,
            newExtendsExisting: true,
            newDeclaredChoice: 'subtype',
          }),
        ).scenario,
      ).toBe('same-name-subclass-coexists');
    });

    it('an unknown package on either side is still a true collision', () => {
      expect(
        decideCollisionPolicy(
          baseline({ ...differentPackages, hasNewQualifiedKey: false }),
        ).scenario,
      ).toBe('true-collision');
      expect(
        decideCollisionPolicy(
          baseline({ ...differentPackages, existingHasAnyPackage: false }),
        ).scenario,
      ).toBe('true-collision');
    });

    it("another package's manifest stub is not taken over by a different class", () => {
      const stub = { ...differentPackages, existingIsManifestStub: true };
      expect(decideCollisionPolicy(baseline(stub)).policy).toBe(
        'coexist-qualified',
      );
      // Bundled output: the stack package is the bundle's, so the stub is
      // still replaced unless the class declares another table.
      expect(
        decideCollisionPolicy(baseline({ ...stub, newInBundledContext: true }))
          .scenario,
      ).toBe('manifest-stub-replacement');
      expect(
        decideCollisionPolicy(
          baseline({
            ...stub,
            newInBundledContext: true,
            declaresDifferentTable: true,
          }),
        ).policy,
      ).toBe('coexist-qualified');
      // A stub without a source file (or of the same file) is replaced.
      expect(
        decideCollisionPolicy(
          baseline({ ...stub, bothSourceFilesKnown: false }),
        ).scenario,
      ).toBe('manifest-stub-replacement');
      expect(
        decideCollisionPolicy(baseline({ ...stub, sameSourceFile: true }))
          .scenario,
      ).toBe('manifest-stub-replacement');
    });
  });

  describe('same-named inheritance rows (#5143)', () => {
    const origins = ['decorator', 'manifest'] as const;

    it.each(
      origins,
    )('same-name-subclass-replaces-parent → replace (%s)', (origin) => {
      const result = decideCollisionPolicy(
        baseline({
          origin,
          newExtendsExisting: true,
          newDeclaredChoice: 'replace',
        }),
      );
      expect(result.policy).toBe('replace');
      expect(result.scenario).toBe('same-name-subclass-replaces-parent');
    });

    it.each(origins)('same-name-subclass-coexists → throw (%s)', (origin) => {
      const result = decideCollisionPolicy(
        baseline({
          origin,
          newExtendsExisting: true,
          newDeclaredChoice: 'subtype',
        }),
      );
      expect(result.policy).toBe('throw');
      expect(result.scenario).toBe('same-name-subclass-coexists');
    });

    it.each(origins)('same-name-subclass-undeclared → throw (%s)', (origin) => {
      const result = decideCollisionPolicy(
        baseline({ origin, newExtendsExisting: true }),
      );
      expect(result.policy).toBe('throw');
      expect(result.scenario).toBe('same-name-subclass-undeclared');
    });

    it.each(
      origins,
    )('same-name-parent-of-replacement → retain-as-replaced (%s)', (origin) => {
      const result = decideCollisionPolicy(
        baseline({
          origin,
          existingExtendsNew: true,
          existingDeclaredChoice: 'replace',
        }),
      );
      expect(result.policy).toBe('retain-as-replaced');
      expect(result.scenario).toBe('same-name-parent-of-replacement');
    });

    it.each(
      origins,
    )('same-name-parent-of-coexisting → throw (%s)', (origin) => {
      const result = decideCollisionPolicy(
        baseline({
          origin,
          existingExtendsNew: true,
          existingDeclaredChoice: 'subtype',
        }),
      );
      expect(result.policy).toBe('throw');
      expect(result.scenario).toBe('same-name-parent-of-coexisting');
    });

    it.each(
      origins,
    )('same-name-parent-of-undeclared → throw (%s)', (origin) => {
      const result = decideCollisionPolicy(
        baseline({ origin, existingExtendsNew: true }),
      );
      expect(result.policy).toBe('throw');
      expect(result.scenario).toBe('same-name-parent-of-undeclared');
    });

    it('a manifest stub is not taken over by a class that extends its class', () => {
      // The caller reads the edge from declared lineage: a stub has no
      // prototype to test.
      const stub = {
        origin: 'decorator',
        existingIsManifestStub: true,
        newExtendsExisting: true,
      } as const;
      expect(
        decideCollisionPolicy(
          baseline({ ...stub, newDeclaredChoice: 'replace' }),
        ).scenario,
      ).toBe('same-name-subclass-replaces-parent');
      expect(
        decideCollisionPolicy(
          baseline({ ...stub, newDeclaredChoice: 'subtype' }),
        ).scenario,
      ).toBe('same-name-subclass-coexists');
      expect(decideCollisionPolicy(baseline(stub)).policy).toBe('throw');
    });

    it('bundled output and unknown sources leave a same-named pair to its declared choice', () => {
      for (const context of [
        { newInBundledContext: true, existingIsPackageQualified: true },
        { bothSourceFilesKnown: false },
      ]) {
        expect(
          decideCollisionPolicy(
            baseline({
              ...context,
              newExtendsExisting: true,
              newDeclaredChoice: 'replace',
            }),
          ).scenario,
        ).toBe('same-name-subclass-replaces-parent');
      }
    });
  });

  describe('every combination of inputs', () => {
    const flags = [
      'sameConstructor',
      'sameSourceFile',
      'bothSourceFilesKnown',
      'existingIsManifestStub',
      'newInBundledContext',
      'newExtendsExisting',
      'existingExtendsNew',
      'samePackage',
      'existingIsPackageQualified',
      'sameName',
      'hasNewQualifiedKey',
      'existingKeyIsQualified',
      'hasManifestContent',
      'registrationKeyDiffersFromExistingKey',
      'existingHasNoPackage',
      'existingHasAnyPackage',
      'declaresDifferentTable',
      'existingPackageStampsConstructors',
    ] as const satisfies ReadonlyArray<keyof CollisionInputs>;
    const choices = [undefined, 'replace', 'subtype'] as const;
    const byNewChoice = {
      replace: ['replace', 'same-name-subclass-replaces-parent'],
      subtype: ['throw', 'same-name-subclass-coexists'],
      undeclared: ['throw', 'same-name-subclass-undeclared'],
    } as const;
    const byExistingChoice = {
      replace: ['retain-as-replaced', 'same-name-parent-of-replacement'],
      subtype: ['throw', 'same-name-parent-of-coexisting'],
      undeclared: ['throw', 'same-name-parent-of-undeclared'],
    } as const;

    it('has a row for each, and decides a same-named pair by its declared choice alone', () => {
      // Guards the enumeration itself: a new input must be added to it.
      expect(
        [
          ...flags,
          'origin',
          'matchKind',
          'newDeclaredChoice',
          'existingDeclaredChoice',
        ].sort(),
      ).toEqual(Object.keys(baseline()).sort());

      const reached = new Set<string>();
      const violations: string[] = [];
      const inputs = baseline() as {
        -readonly [K in keyof CollisionInputs]: CollisionInputs[K];
      };
      for (const origin of ['decorator', 'manifest'] as const) {
        for (const matchKind of [
          'exact-key',
          'case-insensitive',
          'canonical-name',
        ] as const) {
          for (const newDeclaredChoice of choices) {
            for (const existingDeclaredChoice of choices) {
              for (let bits = 0; bits < 1 << flags.length; bits++) {
                inputs.origin = origin;
                inputs.matchKind = matchKind;
                inputs.newDeclaredChoice = newDeclaredChoice;
                inputs.existingDeclaredChoice = existingDeclaredChoice;
                for (let index = 0; index < flags.length; index++) {
                  inputs[flags[index]] = (bits & (1 << index)) !== 0;
                }
                // Throws if no row matches.
                const decision = decideCollisionPolicy(inputs);
                reached.add(decision.scenario);
                const sameNameScenario =
                  decision.scenario.startsWith('same-name-');
                let expected: readonly [string, string] | undefined;
                if (!inputs.sameConstructor) {
                  if (inputs.newExtendsExisting && !inputs.existingExtendsNew) {
                    expected = byNewChoice[newDeclaredChoice ?? 'undeclared'];
                  } else if (
                    inputs.existingExtendsNew &&
                    !inputs.newExtendsExisting
                  ) {
                    expected =
                      byExistingChoice[existingDeclaredChoice ?? 'undeclared'];
                  }
                }
                const ok = expected
                  ? decision.policy === expected[0] &&
                    decision.scenario === expected[1]
                  : // No inheritance edge: the declared choice decides nothing,
                    // and no declaration is ever retained as replaced.
                    !sameNameScenario &&
                    decision.policy !== 'retain-as-replaced' &&
                    // A manifest collision with no edge never raises.
                    (origin !== 'manifest' || decision.policy !== 'throw');
                if (!ok && violations.length < 5) {
                  violations.push(
                    `${decision.scenario} → ${decision.policy} for ${JSON.stringify(inputs)}`,
                  );
                }
              }
            }
          }
        }
      }
      expect(violations).toEqual([]);
      expect([...reached].sort()).toEqual(
        __POLICY_ROWS_FOR_TEST.map((row) => row.scenario).sort(),
      );
    }, 120_000);
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
        baseline({ newExtendsExisting: true, newDeclaredChoice: 'replace' }),
        baseline({
          existingExtendsNew: true,
          existingDeclaredChoice: 'replace',
        }),
        baseline({ bothSourceFilesKnown: true }),
      ];
      for (const inputs of samples) {
        const decision = decideCollisionPolicy(inputs);
        expect(decision.reason.length).toBeGreaterThan(0);
      }
    });
  });
});
