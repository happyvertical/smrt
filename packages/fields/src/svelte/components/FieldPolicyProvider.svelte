<script lang="ts">
/**
 * FieldPolicyProvider — the form-level entry point for policy-driven forms.
 *
 * Receives a resolved {@link ResolvedObjectFieldPolicy} **as props** (SSR
 * `initialData` or a client fetch by the app). Owns mode state (`basic`/
 * `advanced`) and publishes the reactive context consumed by `PolicyField`,
 * `ModeSwitch`, `AdvancedFields`, and `FormHelp`.
 *
 * No `smrt-web` import in the core primitive — an optional `./web` adapter can
 * wire live invalidation for apps that want it; this component is policy-source
 * agnostic.
 *
 * SSR seeding: props seed `$state` via `untrack()` so the first render reflects
 * the request, with a client-only `$effect` resync — the same pattern as
 * ThemeProvider (`smrt-ui/src/themes/ThemeProvider.svelte:53-70`).
 */

import type { Snippet } from 'svelte';
import { untrack } from 'svelte';
import type {
  ResolvedFieldPolicy,
  ResolvedObjectFieldPolicy,
} from '../../types.js';
import {
  type FieldPolicyContextValue,
  type FieldPolicyMode,
  FieldPolicyModeStore,
  setFieldPolicyContext,
} from '../context.svelte.js';

export interface Props {
  /**
   * Pre-resolved field policy for the object. Pass the output of
   * `resolveFieldPolicy()` (server-side) or the `resolveBatch` endpoint
   * response (client-side).
   */
  policy: ResolvedObjectFieldPolicy;
  /** Initial display mode — 'basic' hides advanced-tier fields. */
  mode?: FieldPolicyMode;
  /** Children rendered inside the provider. */
  children?: Snippet;
}

let { policy, mode: modeProp = 'basic', children }: Props = $props();

// --- Reactive mode state (owned by the provider component) ---
// Using a class with $state fields: Svelte 5 tracks class field reactivity
// correctly across the context boundary (the class instance is the reactive
// root, not a component closure variable).
// Seed via untrack() so the first SSR/client render reflects the requested
// mode; the $effect below resyncs later prop changes (ThemeProvider precedent).
const modeStore = new FieldPolicyModeStore(untrack(() => modeProp));

$effect(() => {
  modeStore.set(modeProp);
});

// --- Resolved field lookup (reactive over policy prop changes) ---
function getField(fieldName: string): ResolvedFieldPolicy | undefined {
  return policy.fields[fieldName];
}

// --- Advanced field count for the disclosure label ---
const advancedFieldCount = $derived.by(() => {
  let count = 0;
  for (const field of Object.values(policy.fields)) {
    if (field.visibility === 'advanced') {
      count++;
    }
  }
  return count;
});

const context: FieldPolicyContextValue = {
  get policy() {
    return policy;
  },
  mode: modeStore,
  getField,
  get advancedFieldCount() {
    return advancedFieldCount;
  },
};

setFieldPolicyContext(context);
</script>

{@render children?.()}
