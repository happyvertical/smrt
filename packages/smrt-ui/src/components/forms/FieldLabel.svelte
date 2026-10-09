<script lang="ts">
/**
 * The one label treatment for generated form fields: a plain label above its
 * control. Every field component (text, money, date, select, relation, …) and
 * every read-only field display renders this, so size, weight, colour and
 * spacing cannot drift between field types.
 */
interface Props {
  /** Label text. */
  label: string;
  /** Id of the labelled control (`for`). Omit for read-only displays. */
  for?: string;
  /** Id of the label element, for `aria-labelledby` on the control. */
  id?: string;
  /** Shows the required marker. */
  required?: boolean;
}
let { label, for: forId, id, required = false }: Props = $props();
</script>

{#if forId}
  <label {id} for={forId} class="smrt-field-label">{label}{#if required}<span class="required" aria-hidden="true">*</span>{/if}</label>
{:else}
  <span {id} class="smrt-field-label">{label}{#if required}<span class="required" aria-hidden="true">*</span>{/if}</span>
{/if}

<style>
  .smrt-field-label {
    display: block;
    margin-bottom: var(--smrt-spacing-1, 4px);
    font-size: var(--smrt-typography-label-large-size, 0.875rem);
    font-weight: var(--smrt-typography-weight-medium, 500);
    line-height: var(--smrt-typography-label-large-line-height, 1.4);
    letter-spacing: normal;
    text-transform: none;
    font-family: inherit;
    color: var(--smrt-color-on-surface, #374151);
  }

  .required {
    color: var(--smrt-color-error, #ba1a1a);
    margin-left: var(--smrt-spacing-1, 4px);
  }
</style>
