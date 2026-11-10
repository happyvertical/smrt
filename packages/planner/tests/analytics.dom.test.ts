import { describe, expect, it, vi } from 'vitest';
import { libraryState } from '../src/lib/library/state.svelte.ts';

describe('planner standard analytics application signal', () => {
  it('is optional, ignores hydration, emits once per explicit successful application and detaches', () => {
    const applied = vi.fn();
    const stop = libraryState.onApplied(applied);
    libraryState.load(null);
    expect(applied).not.toHaveBeenCalled();
    libraryState.select('private-cookbook-id', null, null);
    expect(applied.mock.calls).toEqual([[]]);
    stop();
    libraryState.select('another', null, null);
    expect(applied).toHaveBeenCalledTimes(1);
  });
});
