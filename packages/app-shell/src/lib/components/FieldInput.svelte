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

<div class="smrt-app-shell__field" data-smrt-component="FieldInput">
  {#if spec.kind === 'checkbox'}
    <label class="smrt-app-shell__check" data-smrt-part="label">
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
      {spec.label}{#if spec.required}<span class="smrt-app-shell__req" aria-hidden="true" data-smrt-part="label"> *</span
        ><span class="smrt-field-input__sr" data-smrt-part="label"> (required)</span>{/if}
    </label>
    {#if spec.kind === 'select'}
      <select
        {id}
        class="smrt-app-shell__input"
        {disabled}
        bind:value
        aria-invalid={error ? 'true' : undefined}
        aria-required={spec.required}
        aria-describedby={describedBy} data-smrt-part="input"
      >
        <option value="">{spec.required ? 'Choose…' : 'None'}</option>
        {#each spec.choices as choice (choice)}
          <option value={choice}>{choice}</option>
        {/each}
      </select>
    {:else if spec.kind === 'reference'}
      <select
        {id}
        class="smrt-app-shell__input"
        {disabled}
        bind:value
        aria-invalid={error ? 'true' : undefined}
        aria-required={spec.required}
        aria-describedby={describedBy} data-smrt-part="input"
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
        class="smrt-app-shell__input"
        {disabled}
        spellcheck="false"
        bind:value
        aria-invalid={error ? 'true' : undefined}
        aria-required={spec.required}
        aria-describedby={describedBy} data-smrt-part="input"
      ></textarea>
    {:else}
      <input
        {id}
        class="smrt-app-shell__input"
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
        aria-describedby={describedBy} data-smrt-part="input"
      />
    {/if}
  {/if}
  {#if hintFor(spec)}<p class="smrt-app-shell__hint" id={hintId} data-smrt-part="hint">{hintFor(spec)}</p>{/if}
  {#if error}<p class="smrt-app-shell__error" id={errorId} data-smrt-part="error">{error}</p>{/if}
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;

@layer smrt.structure {
  .smrt-field-input__sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
}

@layer smrt.theme {
}
</style>
