import { cookbookStore } from '../cookbook/store.svelte.ts';
import { libraryState } from '../library/state.svelte.ts';
import { plannerTitle } from './title.ts';

/**
 * The live app title over the module stores. Call it inside a `$derived` so
 * a cookbook applied, imported, named or reset re-reads it.
 */
export function currentPlannerTitle(): string {
  return plannerTitle(cookbookStore.snapshot(), libraryState.active);
}
