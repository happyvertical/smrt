<script lang="ts">
/**
 * AdvancedFields — a disclosure section for advanced-tier fields.
 *
 * An optional composition that wraps PolicyField-wrapped advanced fields. Uses
 * `@happyvertical/smrt-ui/ui`'s Disclosure (native `<details>/<summary>` —
 * good a11y baseline). The title shows the advanced field count from the
 * resolved policy.
 *
 * The disclosure's open state is **not** coupled to the provider's mode: the
 * mode determines *visibility* (advanced fields are hidden in basic mode),
 * while the disclosure provides a *collapsed* view of those same fields when
 * they are visible (advanced mode). Consumers who prefer the mode toggle alone
 * (ModeSwitch) do not need this component.
 *
 * Must be used inside a FieldPolicyProvider.
 */
import { Disclosure } from '@happyvertical/smrt-ui/ui';
import type { Snippet } from 'svelte';
import { getFieldPolicyContext } from '../context.svelte.js';

export interface Props {
  /**
   * Title for the disclosure. Defaults to "Advanced" with the field count.
   */
  title?: string;
  /** Whether the disclosure starts open. */
  open?: boolean;
  /** Children — the advanced fields to render inside the disclosure. */
  children?: Snippet;
  /** Additional class. */
  class?: string;
}

let { title, open = false, children, class: className = '' }: Props = $props();

const context = getFieldPolicyContext();

const resolvedTitle = $derived(
  title ??
    `Advanced · ${context.advancedFieldCount} field${context.advancedFieldCount === 1 ? '' : 's'}`,
);
</script>

{#if context.mode.current === 'advanced' && context.advancedFieldCount > 0}
  <Disclosure title={resolvedTitle} {open} class={className}>
    {@render children?.()}
  </Disclosure>
{/if}
