<script lang="ts">
/**
 * AssemblyForm — the create and edit form for an assembly, rendered by
 * smrt-fields `ObjectForm` for `@happyvertical/smrt-manufacturing:Assembly`.
 *
 * The fields, their order, labels, help and visibility come from the
 * generated Assembly definition and the consumer's resolved field policy, so
 * a field the policy hides (price, for someone who may not see it) is not
 * rendered. Pass `fields` and `policy` directly, or omit both beneath an
 * `ObjectFormSourceProvider` that knows the Assembly definition.
 *
 * Presentational: the host owns the record and persistence. `onsubmit`
 * should save through the Assembly REST route or `AssemblyCollection` and
 * resolve `true` once the record is stored.
 */

import {
  ObjectForm,
  type ObjectFormProps,
  type ResolvedObjectFieldPolicy,
} from '@happyvertical/smrt-fields/svelte';
import type { Snippet } from 'svelte';

/** The canonical object reference ObjectForm and field policy use for Assembly. */
const ASSEMBLY_OBJECT_REF = '@happyvertical/smrt-manufacturing:Assembly';

export interface AssemblyFormProps {
  /** Generated browser-safe Assembly field definitions; pass with `policy`. */
  fields?: ObjectFormProps['fields'];
  /** The resolved field policy for Assembly; pass with `fields`. */
  policy?: ResolvedObjectFieldPolicy;
  /** The record being created or edited. Bind it to keep values in the host. */
  value?: Record<string, unknown>;
  /** True for a new assembly (policy defaults may prefill), false for an edit. */
  isNewRecord?: boolean;
  /** Blocks input and submission while the host saves. */
  disabled?: boolean;
  /** Shows the basic/advanced field toggle. */
  showModeSwitch?: boolean;
  /** Controls rendered after the fields, inside the form (e.g. a cancel button). */
  actions?: Snippet;
  /** Saves the record; resolve `true` only once it is stored. */
  onsubmit?: ObjectFormProps['onsubmit'];
}

let {
  fields,
  policy,
  value = $bindable<Record<string, unknown>>({}),
  isNewRecord = true,
  disabled = false,
  showModeSwitch = true,
  actions,
  onsubmit,
}: AssemblyFormProps = $props();
</script>

<ObjectForm
  objectRef={ASSEMBLY_OBJECT_REF}
  {fields}
  {policy}
  bind:value
  {isNewRecord}
  {disabled}
  {showModeSwitch}
  {actions}
  {onsubmit}
  class="assembly-form"
/>
