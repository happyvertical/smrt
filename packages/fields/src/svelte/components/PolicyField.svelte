<script lang="ts">
/**
 * PolicyField — layout-neutral wrapper around any input.
 *
 * Contributes:
 * - Visibility by resolved tier × current mode (advanced fields hidden in
 *   basic mode)
 * - Initial-value prefill from the resolved default (new records only —
 *   never clobbers loaded values)
 * - Label rendering (resolved label or fallback to field name)
 * - Help hint rendered from resolved help (manifest description → org/user
 *   override)
 * - Required marker
 *
 * Headless escape hatch: pass a `render` snippet receiving
 * `{visible, label, help, defaultValue, required, tier}` for fully custom
 * rendering. Without a snippet, PolicyField wraps children in a label + help
 * affordance and controls visibility.
 *
 * Graceful degradation: outside a FieldPolicyProvider, PolicyField renders its
 * children verbatim (no visibility filtering, no label/help injection) so
 * forms can adopt it incrementally.
 */
import type { Snippet } from 'svelte';
import { onMount } from 'svelte';
import { tryGetFieldPolicyContext } from '../context.svelte.js';
import type { PolicyFieldSnippetProps } from '../types.js';

export interface Props {
  /** The field name matching a key in the resolved policy's `fields`. */
  name: string;
  /**
   * Children — the actual input(s). Always rendered when the field is visible
   * (unless the `render` snippet escape hatch is used).
   */
  children?: Snippet;
  /**
   * Headless escape hatch: a snippet receiving all resolved policy data for
   * fully custom rendering. When provided, it replaces the default label +
   * children + help layout entirely.
   */
  render?: Snippet<[PolicyFieldSnippetProps]>;
  /**
   * Whether this is a new record. When true (default) and the field has a
   * resolved default, the provider can prefill. Set to false for loaded
   * records to prevent overwriting existing values.
   * @default true
   */
  isNewRecord?: boolean;
  /**
   * Override the resolved label. When provided, takes precedence over the
   * policy label.
   */
  label?: string;
  /**
   * Override the resolved help text. When provided, takes precedence over
   * the policy help.
   */
  help?: string;
  /**
   * Density of the help hint: 'hint' (inline hint text, default) or
   * 'tooltip' (title attribute on the label).
   * @default 'hint'
   */
  helpDensity?: 'hint' | 'tooltip';
  /** Additional class for the wrapper element. */
  class?: string;
}

let {
  name,
  children,
  render: renderSnippet,
  isNewRecord = true,
  label: labelOverride,
  help: helpOverride,
  helpDensity = 'hint',
  class: className = '',
}: Props = $props();

const context = tryGetFieldPolicyContext();

// Reactive resolved field policy — undefined when not in a Provider or when
// the field name is not in the resolved set.
const resolvedField = $derived(context?.getField(name));

const tier = $derived(resolvedField?.visibility ?? 'basic');

// A field is visible when:
// - No context (graceful degradation → always visible)
// - Tier is 'basic'
// - Tier is 'advanced' and mode is 'advanced'
// - Tier is 'hidden' → never visible (but required-and-defaultless fields are
//   forced basic by the resolver, so this is a safety net)
const visible = $derived.by(() => {
  if (!context) return true;
  if (tier === 'hidden') return false;
  if (tier === 'basic') return true;
  // advanced
  return context.mode.current === 'advanced';
});

const label = $derived(labelOverride ?? resolvedField?.label ?? null);

const help = $derived(helpOverride ?? resolvedField?.help ?? null);

const required = $derived(resolvedField?.required ?? false);

const hasDefault = $derived(resolvedField?.hasDefault ?? false);

const defaultValue = $derived(resolvedField?.defaultValue);

// Snippet escape hatch data
const snippetProps = $derived<PolicyFieldSnippetProps>({
  visible,
  label,
  help,
  defaultValue,
  required,
  tier,
});

// --- Default prefill (new records only) ---
// On mount, if this is a new record and the field has a resolved default,
// prefill the wrapped input's value — but ONLY when the input is currently
// empty (a loaded record with an existing value is never clobbered). The
// prefill is a one-shot DOM write inside onMount (client-only), mirroring the
// "defaults only apply to new records" invariant from the resolver.
//
// After writing a value we dispatch the event the matching binding listens to
// (`input` for text-like controls, `change` for select/checkbox/radio) so a
// consumer's `bind:value` variable picks the prefilled value up instead of
// staying stale.
let rootEl = $state<HTMLDivElement | null>(null);

function prefillInputs(): void {
  if (!rootEl || !isNewRecord || !hasDefault || defaultValue === undefined) {
    return;
  }

  const inputs = rootEl.querySelectorAll<
    HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
  >('input, textarea, select');

  for (const input of inputs) {
    if (input instanceof HTMLSelectElement) {
      if (input.value === '' || input.value === undefined) {
        input.value = String(defaultValue ?? '');
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
      continue;
    }

    const inputType = (input as HTMLInputElement).type;
    if (inputType === 'checkbox') {
      const checkbox = input as HTMLInputElement;
      if (!checkbox.checked && defaultValue === true) {
        checkbox.checked = true;
        checkbox.dispatchEvent(new Event('change', { bubbles: true }));
      }
      continue;
    }

    if (inputType === 'radio') {
      const radio = input as HTMLInputElement;
      if (String(defaultValue) === radio.value && !radio.checked) {
        radio.checked = true;
        radio.dispatchEvent(new Event('change', { bubbles: true }));
      }
      continue;
    }

    // text / textarea / number / date / etc.
    const textInput = input as HTMLInputElement | HTMLTextAreaElement;
    if (textInput.value === '' || textInput.value === undefined) {
      textInput.value = String(defaultValue ?? '');
      textInput.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }
}

onMount(() => {
  prefillInputs();
});
</script>

{#if renderSnippet}
  {@render renderSnippet(snippetProps)}
{:else if visible}
  <div class="policy-field {className}" bind:this={rootEl}>
    {#if label !== null}
      <label
        class="policy-field__label"
        for={name}
        title={helpDensity === 'tooltip' && help !== null ? help : undefined}
      >
        {label}{#if required}<span class="policy-field__required" aria-hidden="true">*</span>{/if}
      </label>
    {/if}
    {@render children?.()}
    {#if help !== null && (helpDensity === 'hint' || label === null)}
      <!-- Hint text density, or tooltip density with no label to attach the
           title attribute to (fall back to visible help rather than dropping
           it). -->
      <p class="policy-field__hint" id="{name}-help">{help}</p>
    {/if}
  </div>
{/if}

<style>
  .policy-field {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-1, 0.25rem);
  }

  .policy-field__label {
    font: var(--smrt-typography-label-large-font, inherit);
    color: var(--smrt-color-on-surface, currentColor);
  }

  .policy-field__required {
    color: var(--smrt-color-error, #b3261e);
    margin-left: 0.25em;
  }

  .policy-field__hint {
    font: var(--smrt-typography-body-small-font, inherit);
    color: var(--smrt-color-on-surface-variant, currentColor);
    margin: 0;
  }
</style>
