/** Mutable parent data for component tests, like a SvelteKit load refresh. */
export function layoutState<T extends object>(value: T): T {
  const state = $state(value);
  return state;
}
