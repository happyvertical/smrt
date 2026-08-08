<script lang="ts">
/** Provider-free built-in adapters for the SMRT generated wire field types. */
import { Input, Textarea, Toggle } from '@happyvertical/smrt-ui/forms';
import { onDestroy } from 'svelte';
import type { FieldInputProps } from '../types.js';

let {
  id,
  name,
  label,
  field,
  value,
  required,
  disabled,
  onvaluechange,
  onvaliditychange,
}: FieldInputProps = $props();

let jsonText = $state('');
let jsonError = $state<string | null>(null);

onDestroy(() => {
  // A hidden/unmounted invalid JSON control must not leave its parent form
  // permanently blocked after a mode change.
  if (jsonError) onvaliditychange?.(true);
});

function formatJson(next: unknown): string {
  if (next === undefined || next === null) return '';
  return JSON.stringify(next, null, 2);
}

$effect(() => {
  // Keep external record updates visible, but never overwrite an invalid JSON
  // draft while the user is correcting it. Compare serialized text rather than
  // object identity: callers may pass a fresh record object each render.
  if (jsonError) return;
  const next = formatJson(value);
  if (jsonText !== next) jsonText = next;
});

function setText(event: Event): void {
  onvaluechange((event.currentTarget as HTMLInputElement).value);
}

function setNumber(event: Event, integer: boolean): void {
  const input = event.currentTarget as HTMLInputElement;
  // Browsers report incomplete number text (for example a lone sign or an
  // unfinished exponent) as `value === ''` plus `badInput`. That is not a
  // deliberate clear, so leave the record untouched until the edit is valid.
  if (input.validity.badInput) return;
  const raw = input.value;
  if (raw === '') {
    onvaluechange(undefined);
    return;
  }
  const number = Number(raw);
  // Number inputs can transiently contain incomplete exponent/sign text while
  // editing. Keep the last valid record value until the browser supplies a
  // finite number; never leak NaN/Infinity into a create or edit payload.
  if (!Number.isFinite(number)) return;
  onvaluechange(integer ? Math.trunc(number) : number);
}

function setJson(event: Event): void {
  jsonText = (event.currentTarget as HTMLTextAreaElement).value;
  if (jsonText.trim() === '') {
    jsonError = null;
    onvaliditychange?.(true);
    onvaluechange(undefined);
    return;
  }
  try {
    const parsed = JSON.parse(jsonText);
    jsonError = null;
    onvaliditychange?.(true);
    onvaluechange(parsed);
  } catch {
    jsonError = 'Enter valid JSON before submitting this form.';
    onvaliditychange?.(false);
  }
}

function formatDateTimeLocal(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) return '';
  const part = (number: number) => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())}T${part(date.getHours())}:${part(date.getMinutes())}`;
}

function setDateTime(event: Event): void {
  const raw = (event.currentTarget as HTMLInputElement).value;
  if (!raw) {
    onvaluechange(undefined);
    return;
  }
  const date = new Date(raw);
  onvaluechange(Number.isNaN(date.getTime()) ? raw : date.toISOString());
}
</script>

{#if field.definition.type === 'boolean'}
  <Toggle
    {id}
    {name}
    checked={value === true}
    {disabled}
    ariaLabel={label ?? name}
    onchange={onvaluechange}
  />
{:else if field.definition.type === 'json'}
  <Textarea
    {id}
    {name}
    value={jsonText}
    {disabled}
    {required}
    rows={8}
    aria-invalid={jsonError ? 'true' : undefined}
    aria-describedby={jsonError ? `${id}-json-error` : undefined}
    oninput={setJson}
  />
  {#if jsonError}
    <p id={`${id}-json-error`} class="field-input__error" role="alert">{jsonError}</p>
  {/if}
{:else if field.definition.type === 'integer' || field.definition.type === 'decimal'}
  <Input
    {id}
    {name}
    type="number"
    step={field.definition.type === 'integer' ? '1' : 'any'}
    value={typeof value === 'number' ? value : ''}
    {disabled}
    {required}
    oninput={(event: Event) => setNumber(event, field.definition.type === 'integer')}
  />
{:else if field.definition.type === 'datetime'}
  <Input
    {id}
    {name}
    type="datetime-local"
    value={formatDateTimeLocal(value)}
    {disabled}
    {required}
    oninput={setDateTime}
  />
{:else}
  <Input
    {id}
    {name}
    type="text"
    value={typeof value === 'string' ? value : ''}
    {disabled}
    {required}
    oninput={setText}
  />
{/if}

<style>.field-input__error { color: var(--smrt-color-error, #b42318); margin: 0; }</style>
