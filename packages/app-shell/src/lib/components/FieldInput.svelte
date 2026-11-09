<script lang="ts">
import type { FieldSpec, FormValue } from '$lib/ui/fields';
import { recordLabel } from '$lib/ui/fields';
import type { ModelInfo, RecordRow } from '$lib/ui/types';

interface Props {
  id: string;
  spec: FieldSpec;
  value: FormValue;
  error?: string;
  /** Records of the referenced model (reference fields). */
  options?: RecordRow[];
  /** The referenced model, to label its records. */
  refModel?: ModelInfo;
  disabled?: boolean;
}

let {
  id,
  spec,
  value = $bindable(),
  error = '',
  options = [],
  refModel,
  disabled = false,
}: Props = $props();

const hintId = $derived(`${id}-hint`);
const errorId = $derived(`${id}-error`);
const describedBy = $derived(
  [error ? errorId : '', hintFor(spec) ? hintId : '']
    .filter(Boolean)
    .join(' ') || undefined,
);

function hintFor(s: FieldSpec): string {
  if (s.kind === 'money') return 'Amount, for example 12.50';
  if (s.kind === 'json') return 'JSON, for example {"a": 1}';
  return '';
}
</script>

<div class="sh-field">
  {#if spec.kind === 'checkbox'}
    <label class="sh-check">
      <input
        {id}
        type="checkbox"
        {disabled}
        checked={value === true}
        onchange={(e) => (value = e.currentTarget.checked)}
        aria-describedby={describedBy}
      />
      <span>{spec.label}</span>
    </label>
  {:else}
    <label for={id}>
      {spec.label}{#if spec.required}<span class="sh-req" aria-hidden="true"> *</span
        ><span class="sh-sr"> (required)</span>{/if}
    </label>
    {#if spec.kind === 'select'}
      <select
        {id}
        class="sh-input"
        {disabled}
        bind:value
        aria-invalid={error ? 'true' : undefined}
        aria-required={spec.required}
        aria-describedby={describedBy}
      >
        <option value="">{spec.required ? 'Choose…' : 'None'}</option>
        {#each spec.choices as choice (choice)}
          <option value={choice}>{choice}</option>
        {/each}
      </select>
    {:else if spec.kind === 'reference'}
      <select
        {id}
        class="sh-input"
        {disabled}
        bind:value
        aria-invalid={error ? 'true' : undefined}
        aria-required={spec.required}
        aria-describedby={describedBy}
      >
        <option value="">{spec.required ? 'Choose…' : 'None'}</option>
        {#each options as option (option.id)}
          <option value={option.id}>{recordLabel(refModel, option)}</option>
        {/each}
        {#if typeof value === 'string' && value && !options.some((o) => o.id === value)}
          <option {value}>{value} (not found)</option>
        {/if}
      </select>
    {:else if spec.kind === 'json'}
      <textarea
        {id}
        class="sh-input"
        {disabled}
        spellcheck="false"
        bind:value
        aria-invalid={error ? 'true' : undefined}
        aria-required={spec.required}
        aria-describedby={describedBy}
      ></textarea>
    {:else}
      <input
        {id}
        class="sh-input"
        {disabled}
        bind:value
        type={spec.kind === 'date'
          ? 'date'
          : spec.kind === 'number' || spec.kind === 'integer'
            ? 'number'
            : 'text'}
        step={spec.kind === 'integer' ? '1' : spec.kind === 'number' ? 'any' : undefined}
        inputmode={spec.kind === 'money' ? 'decimal' : undefined}
        aria-invalid={error ? 'true' : undefined}
        aria-required={spec.required}
        aria-describedby={describedBy}
      />
    {/if}
  {/if}
  {#if hintFor(spec)}<p class="sh-hint" id={hintId}>{hintFor(spec)}</p>{/if}
  {#if error}<p class="sh-error" id={errorId}>{error}</p>{/if}
</div>

<style>
  .sh-sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
</style>
