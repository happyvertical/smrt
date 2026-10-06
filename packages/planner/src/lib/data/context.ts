import { getContext, setContext } from 'svelte';
import type { DataSource } from './source.ts';

const KEY = Symbol('smrt-planner:data-source');

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
