import { getContext, setContext } from 'svelte';
import type { ObjectFormSource } from './types.js';

const OBJECT_FORM_SOURCE = Symbol('smrt-fields.object-form-source');

export function setObjectFormSource(source: ObjectFormSource): void {
  setContext(OBJECT_FORM_SOURCE, source);
}

export function tryGetObjectFormSource(): ObjectFormSource | undefined {
  return getContext<ObjectFormSource | undefined>(OBJECT_FORM_SOURCE);
}
