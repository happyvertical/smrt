<script lang="ts">
/**
 * FormHelp — a `?` affordance assembling the object description + per-field
 * glossary from the manifest (org-overridden text where present).
 *
 * Renders a button toggling a details/summary panel listing every visible
 * field's label and help text — matching PolicyField visibility, so
 * advanced-tier entries only appear while the provider mode is `advanced` —
 * plus the object description if provided. The data comes entirely from the
 * resolved policy — no separate fetch needed.
 *
 * Must be used inside a FieldPolicyProvider — deliberately, via the throwing
 * accessor. The panel's payload IS the resolved glossary, so with no provider
 * there is nothing to assemble and a `?` affordance that opens onto "No field
 * help available." would hide the mistake instead of reporting it. This matches
 * the other provider-only compositions (`ModeSwitch`, `AdvancedFields`);
 * `PolicyField` degrades instead only because it has caller-owned children to
 * render verbatim.
 *
 * To put form help in a page header, extend the SAME provider over the header —
 * it renders no markup of its own. Do not add a second one: each provider owns
 * its own mode store and shadows the outer for its subtree, so a `FormHelp`
 * above a nested provider stops tracking the `ModeSwitch` inside it. Inside
 * `ObjectForm`, which builds its own provider, use its `actions` snippet — it
 * renders within that provider, so the glossary resolves. There is no header
 * seam, so it lands below the fields (#2272).
 */
import { getFieldPolicyContext } from '../context.svelte.js';

export interface Props {
  /**
   * Object-level description (e.g. the SmrtObject class `description`). When
   * provided, it appears at the top of the help panel.
   */
  objectDescription?: string;
  /** Label for the toggle button. */
  label?: string;
  /** Additional class. */
  class?: string;
}

let {
  objectDescription,
  label = 'Help',
  class: className = '',
}: Props = $props();

const context = getFieldPolicyContext();

// Build the glossary: one entry per field that has help text AND is visible
// in the current mode (advanced-tier entries disappear in basic mode,
// matching PolicyField visibility), ordered by the resolved `order` when
// available, then by insertion order.
const glossary = $derived.by(() => {
  const entries: Array<{
    label: string;
    help: string;
    order: number;
  }> = [];

  const mode = context.mode.current;
  for (const field of Object.values(context.policy.fields)) {
    if (field.visibility === 'hidden') continue;
    if (field.visibility === 'advanced' && mode !== 'advanced') continue;
    const labelText = field.label ?? field.fieldName;
    if (field.help) {
      entries.push({
        label: labelText,
        help: field.help,
        order: field.order ?? Number.MAX_SAFE_INTEGER,
      });
    }
  }

  // Stable sort by resolved order
  entries.sort((a, b) => a.order - b.order);
  return entries;
});
</script>

<details class="form-help {className}">
  <summary class="form-help__toggle">
    <span class="form-help__icon" aria-hidden="true">?</span>
    <span class="form-help__label">{label}</span>
  </summary>
  <div class="form-help__panel">
    {#if objectDescription}
      <p class="form-help__description">{objectDescription}</p>
    {/if}
    {#if glossary.length > 0}
      <dl class="form-help__glossary">
        {#each glossary as entry}
          <dt class="form-help__term">{entry.label}</dt>
          <dd class="form-help__definition">{entry.help}</dd>
        {/each}
      </dl>
    {:else}
      <p class="form-help__empty">No field help available.</p>
    {/if}
  </div>
</details>

<style>
  .form-help {
    display: inline-block;
  }

  .form-help__toggle {
    display: inline-flex;
    align-items: center;
    gap: var(--smrt-spacing-1, 0.25rem);
    cursor: pointer;
    list-style: none;
    font: var(--smrt-typography-label-medium-font, inherit);
    color: var(--smrt-color-on-surface-variant, currentColor);
  }

  .form-help__toggle::-webkit-details-marker {
    display: none;
  }

  .form-help__toggle:focus-visible {
    outline: 2px solid var(--smrt-color-primary, #6750a4);
    outline-offset: 2px;
    border-radius: 4px;
  }

  .form-help__icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.25em;
    height: 1.25em;
    border-radius: 50%;
    border: 1px solid currentColor;
    font: var(--smrt-typography-label-small-font, inherit);
    line-height: 1;
  }

  .form-help__panel {
    padding: var(--smrt-spacing-3, 0.75rem) 0;
    color: var(--smrt-color-on-surface, currentColor);
  }

  .form-help__description {
    margin: 0 0 var(--smrt-spacing-2, 0.5rem);
    font: var(--smrt-typography-body-medium-font, inherit);
  }

  .form-help__glossary {
    margin: 0;
    display: grid;
    gap: var(--smrt-spacing-1, 0.25rem);
  }

  .form-help__term {
    font: var(--smrt-typography-label-medium-font, inherit);
    font-weight: 600;
  }

  .form-help__definition {
    margin: 0 0 var(--smrt-spacing-2, 0.5rem);
    font: var(--smrt-typography-body-small-font, inherit);
    color: var(--smrt-color-on-surface-variant, currentColor);
  }

  .form-help__empty {
    font: var(--smrt-typography-body-small-font, inherit);
    color: var(--smrt-color-on-surface-variant, currentColor);
  }
</style>
