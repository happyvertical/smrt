/**
 * #2954 probe: inside a forked consumer worker, a sibling workspace package
 * specifier — root and subpath — resolves to the very source module, never to
 * the sibling's built dist.
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
});
