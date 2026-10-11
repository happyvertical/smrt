import { getContext, setContext } from 'svelte';
import type { DataSource } from './source.ts';

const KEY = Symbol('smrt-planner:data-source');

/** The context key, for tests that render a component without the layout. */
export const DATA_SOURCE_KEY: symbol = KEY;

/** Provide the data source for every generated view below the caller. */
export function provideDataSource(source: DataSource): DataSource {
  setContext(KEY, source);
  return source;
}

export function useDataSource(): DataSource {
  const source = getContext<DataSource | undefined>(KEY);
  if (!source) throw new Error('No DataSource provided; see +layout.svelte');
  return source;
}

/** The data source below the caller, or null when none was provided. */
export function tryUseDataSource(): DataSource | null {
  return getContext<DataSource | undefined>(KEY) ?? null;
}
