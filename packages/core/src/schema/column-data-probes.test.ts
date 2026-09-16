/**
 * Unit coverage for {@link resolveRenameDataPendingCandidates} (#2911):
 * the shared ambiguity-resolution rule every `detectRenameDataPending()`
 * copy (`migrations/differ.ts`'s single-table and cross-table-batched
 * variants, and `schema/live-parity.ts`'s) delegates to, so this rule can
 * never drift between them the way #2874's regression drifted before
 * `column-data-probes.ts` existed (#2878).
 *
 * These tests exercise the pure grouping/suppression logic directly,
 * independent of any database engine — the engine-backed regression
 * coverage for the exact production shape lives in `migrations/__tests__/
 * differ.test.ts` and `schema/live-parity.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import {
  type RenameDataPendingCandidate,
  resolveRenameDataPendingCandidates,
} from './column-data-probes.js';

/** Every test candidate here is shape-check-free unless stated otherwise. */
function candidate(
  targetName: string,
  sourceName: string,
  overrides: Partial<RenameDataPendingCandidate<string>> = {},
): RenameDataPendingCandidate<string> {
  return {
    targetName,
    sourceName,
    requiresShapeCheck: false,
    extra: `${targetName}<-${sourceName}`,
    ...overrides,
  };
}

const alwaysShaped = () => true;

describe('resolveRenameDataPendingCandidates (#2911)', () => {
  it('resolves a single 1:1 candidate as unambiguous', () => {
    const resolved = resolveRenameDataPendingCandidates(
      [candidate('new_slug', 'old_slug')],
      alwaysShaped,
    );

    expect([...resolved.keys()]).toEqual(['new_slug']);
    expect(resolved.get('new_slug')).toEqual([
      { sourceName: 'old_slug', extra: 'new_slug<-old_slug' },
    ]);
  });

  it('keeps multiple sources for the same target as an ambiguous group (#2767 review)', () => {
    const resolved = resolveRenameDataPendingCandidates(
      [
        candidate('new_slug', 'old_slug_a'),
        candidate('new_slug', 'old_slug_b'),
      ],
      alwaysShaped,
    );

    const group = resolved.get('new_slug');
    expect(group).toHaveLength(2);
    expect(group?.map((c) => c.sourceName).sort()).toEqual([
      'old_slug_a',
      'old_slug_b',
    ]);
  });

  it('suppresses every target when one source is nominated for several unrelated targets (#2911)', () => {
    // The exact production shape: `tenants.timezone` nominated as the
    // rename source for three different empty declared columns at once.
    const resolved = resolveRenameDataPendingCandidates(
      [
        candidate('hierarchy_path', 'timezone'),
        candidate('repo_template', 'timezone'),
        candidate('github_org', 'timezone'),
      ],
      alwaysShaped,
    );

    expect(resolved.size).toBe(0);
  });

  it('suppresses only the targets that share the ambiguous source, keeping an unrelated 1:1 match intact', () => {
    const resolved = resolveRenameDataPendingCandidates(
      [
        // `shared` is a compatible candidate for both `target_a` and
        // `target_b`, so it can support neither inference.
        candidate('target_a', 'shared'),
        candidate('target_b', 'shared'),
        // `target_c`'s only candidate, `sole`, is not shared with any
        // other target and must still be reported.
        candidate('target_c', 'sole'),
      ],
      alwaysShaped,
    );

    expect(resolved.size).toBe(1);
    expect(resolved.get('target_c')).toEqual([
      { sourceName: 'sole', extra: 'target_c<-sole' },
    ]);
    expect(resolved.has('target_a')).toBe(false);
    expect(resolved.has('target_b')).toBe(false);
  });

  it('suppresses a sole candidate whose source is also one of several candidates for a different (still-ambiguous) target (final review F2)', () => {
    // `contested` would be `target_a`'s only candidate — printing
    // confident copy-then-DROP repair SQL for it — while it is
    // simultaneously one of two candidates for `target_b`, whose own
    // (already-safe, no-suggested-SQL) ambiguous finding names `contested`
    // as a possible source too. Trusting `target_a`'s guess and dropping
    // `contested` would destroy data `target_b`'s own advisory says may
    // still be needed — exactly the corruption #2911 exists to prevent,
    // so `target_a` must be suppressed even though `target_b` itself
    // received no more than one match from any single source.
    const resolved = resolveRenameDataPendingCandidates(
      [
        candidate('target_a', 'contested'),
        candidate('target_b', 'contested'),
        candidate('target_b', 'unrelated'),
      ],
      alwaysShaped,
    );

    expect(resolved.has('target_a')).toBe(false);
    // target_b's own ambiguous finding is untouched — it was never a sole
    // candidate itself, and disclosing the ambiguity is already safe (no
    // suggested SQL).
    const targetB = resolved.get('target_b');
    expect(targetB).toHaveLength(2);
    expect(targetB?.map((c) => c.sourceName).sort()).toEqual([
      'contested',
      'unrelated',
    ]);
  });

  it('drops a shape-check candidate whose source fails the UUID-shape probe', () => {
    const resolved = resolveRenameDataPendingCandidates(
      [candidate('new_id', 'old_id', { requiresShapeCheck: true })],
      () => false,
    );

    expect(resolved.size).toBe(0);
  });

  it('keeps a shape-check candidate whose source passes the UUID-shape probe', () => {
    const resolved = resolveRenameDataPendingCandidates(
      [candidate('new_id', 'old_id', { requiresShapeCheck: true })],
      () => true,
    );

    expect(resolved.get('new_id')).toEqual([
      { sourceName: 'old_id', extra: 'new_id<-old_id' },
    ]);
  });

  it('returns an empty map for no candidates', () => {
    expect(resolveRenameDataPendingCandidates([], alwaysShaped).size).toBe(0);
  });
});
