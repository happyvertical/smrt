/**
 * #2954 probe: inside a forked consumer worker, a sibling workspace package
 * specifier — root, derived subpath, pattern subpath — resolves to the very
 * source module, and one that can only resolve to a sibling's built dist fails.
 * `utils/__issue_2954_stale_probe.js` matches smrt-ui's `./utils/*` export,
 * whose target is built JavaScript with no source file — stale dist.
 */
import { describe, expect, it } from 'vitest';

describe('issue #2954 workspace source resolution probe', () => {
  it('resolves a sibling package root to its source module', async () => {
    const viaSpecifier = await import('@happyvertical/smrt-types');
    const viaSource = await import('../../../../../../types/src/index.js');
    expect(viaSpecifier).toBe(viaSource);
  });

  it('resolves a derived sibling subpath (previously dist-only) to its source module', async () => {
    // A computed specifier keeps tsc from type-resolving the subpath; Vite
    // resolves it at runtime through the same aliases.
    const specifier = '@happyvertical/smrt-web/ai';
    const viaSpecifier = await import(/* @vite-ignore */ specifier);
    const viaSource = await import('../../../../../../smrt-web/src/ai.js');
    expect(viaSpecifier).toBe(viaSource);
  });

  it('resolves a pattern-export subpath to its source module', async () => {
    const specifier = '@happyvertical/smrt-ui/utils/import-optional.js';
    const viaSpecifier = await import(/* @vite-ignore */ specifier);
    const viaSource = await import(
      '../../../../../../smrt-ui/src/utils/import-optional.js'
    );
    expect(viaSpecifier).toBe(viaSource);
  });

  it('fails a specifier that can only resolve to a sibling dist', async () => {
    const specifier =
      '@happyvertical/smrt-ui/utils/__issue_2954_stale_probe.js';
    await expect(import(/* @vite-ignore */ specifier)).rejects.toThrow(
      /built output of workspace package @happyvertical\/smrt-ui/,
    );
  });
});
