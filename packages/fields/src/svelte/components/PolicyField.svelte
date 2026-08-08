<script lang="ts">
/**
 * PolicyField — layout-neutral wrapper around any input.
 *
 * Contributes:
 * - Visibility by resolved tier × current mode (advanced fields hidden in
 *   basic mode)
 * - Initial-value prefill from the resolved default (new records only —
 *   never clobbers loaded values)
 * - Label rendering (the resolved label; when the policy has no label the
 *   label element is omitted rather than fabricated from the raw field name,
 *   and tooltip-density help falls back to a visible hint)
 * - Help hint rendered from resolved help (manifest description → org/user
 *   override)
 * - Required marker
 *
 * Label ↔ control association: the default wrapper renders
 * `<label for={name}>`, so the wrapped control should carry an `id` equal to
 * the field `name`. When the first wrapped control has a different `id`, the
 * `for` attribute is re-pointed to it after mount; when it has no `id` at
 * all, the wrapper assigns `id={name}` so the association is guaranteed.
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
// When this is a new record and the field has a resolved default, prefill the
// wrapped input's value — but ONLY when the input is currently empty (a loaded
// record with an existing value is never clobbered). Mirrors the "defaults
// only apply to new records" invariant from the resolver.
//
// Runs via $effect rather than onMount so it also covers advanced-tier fields
// that are hidden at mount and revealed later by the mode switch: the wrapper
// div (and rootEl) only exist once the field is visible, and the effect re-runs
// when visibility flips. A one-shot `prefilled` guard prevents re-filling an
// input the user has deliberately cleared.
//
// After writing a value we dispatch the event the matching binding listens to
// (`input` for text-like controls, `change` for select/checkbox/radio) so a
// consumer's `bind:value` variable picks the prefilled value up instead of
// staying stale.
let rootEl = $state<HTMLDivElement | null>(null);
let prefilled = false;

function prefillInputs(): void {
  if (!rootEl) {
    return;
  }

  const inputs = rootEl.querySelectorAll<
    HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
  >('input, textarea, select');

  for (const input of inputs) {
    if (input instanceof HTMLSelectElement) {
      if (input.value === '') {
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
    if (textInput.value === '') {
      textInput.value = String(defaultValue ?? '');
      textInput.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }
}

// Link the help hint to the first wrapped control programmatically. Only
// when the hint is actually rendered as a paragraph (hint density, or tooltip
// density with no label) — otherwise the aria-describedby target would not
// exist. Respects a consumer-provided aria-describedby and only fills in the
// missing association. Runs after the wrapper exists, so it also covers
// advanced-tier fields revealed later by the mode switch.
const hintRendered = $derived(
  help !== null && (helpDensity === 'hint' || label === null),
);

$effect(() => {
  if (!rootEl || !hintRendered) {
    return;
  }
  const control = rootEl.querySelector<HTMLElement>('input, textarea, select');
  if (!control) {
    return;
  }
  if (control.hasAttribute('aria-describedby')) {
    return; // Consumer owns the association — never overwrite it.
  }
  control.setAttribute('aria-describedby', `${name}-help`);
  return () => {
    // Hint no longer rendered (or wrapper torn down) — drop the link we added.
    if (control.getAttribute('aria-describedby') === `${name}-help`) {
      control.removeAttribute('aria-describedby');
    }
  };
});

// --- Label ↔ control association (default wrapper only) ---
// The wrapper renders `<label for={name}>`, which only associates with the
// wrapped control when that control's `id` matches. Consumers normally give
// the input `id={name}`; this effect repairs the association once the wrapper
// exists (covering advanced-tier fields revealed later by the mode switch):
// - control with its own id → re-point `for` at that id;
// - control with no id → assign `id={name}` so the association holds;
// - no wrapped control at all → omit `for` (a dangling reference is worse
//   than none).
//
// `controlId` is undefined until the first effect pass (SSR and first paint
// keep the documented `for={name}` convention); afterwards it is the repaired
// target id, or null when there is no wrapped control.
let controlId = $state<string | null | undefined>(undefined);

$effect(() => {
  if (!rootEl || label === null || !visible) {
    return;
  }
  // Form controls only — buttons and contenteditable hosts are out of scope
  // (same scope as the aria-describedby effect above).
  const control = rootEl.querySelector<HTMLElement>('input, textarea, select');
  if (!control) {
    controlId = null;
    return;
  }
  if (control.id) {
    controlId = control.id;
  } else {
    control.setAttribute('id', name);
    controlId = name;
  }
});

// Prefill is a one-shot per component instance: it runs the first time the
// wrapper exists with a usable default (mount for visible fields, or first
// reveal for advanced-tier fields hidden in basic mode). The `visible` read
// makes the effect re-run when a hidden field becomes visible; the `prefilled`
// guard keeps it one-shot so a user who clears the input is never re-filled.
$effect(() => {
  if (prefilled || !visible || !isNewRecord || !hasDefault) {
    return;
  }
  if (defaultValue === undefined || defaultValue === null) {
    return;
  }
  if (!rootEl) {
    // Wrapper not mounted yet — rootEl is tracked $state, so the effect
    // re-runs once the binding lands.
    return;
  }
  prefilled = true;
  prefillInputs();
});
</script>

{#if renderSnippet}
  {@render renderSnippet(snippetProps)}
{:else if visible}
  <div class="policy-field {className}" bind:this={rootEl}>
    {#if label !== null}
      <!-- `for` tracks the repaired label↔control association: the `name`
           convention before the first effect pass (SSR / first paint), the
           repaired control id afterwards; Svelte omits the attribute entirely
           when it resolves to null (no wrapped control). -->
      <label
        class="policy-field__label"
        for={controlId === undefined ? name : controlId}
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
