<script lang="ts">
import { Input } from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import { onMount, tick, untrack } from 'svelte';
import { expenseMessages as M } from '../messages.js';
/** Lossless native amount entry with an optional accessible touch keypad. */
export interface Props {
  /** Native field name. */
  name: string;
  /** Retained currency-unit text; no numeric coercion. */
  value: string;
  /** Whether the caller permits the keypad. */
  keypad?: boolean;
  /** Presentation disabled state. */
  disabled?: boolean;
}
let { name, value, keypad = true, disabled = false }: Props = $props();
const { t } = useI18n();
let text = $state<string | number>(untrack(() => value));
$effect(() => {
  text = value;
});
let mounted = $state(false);
let open = $state(false);
let input: HTMLDivElement;
let caret: { start: number; end: number } | undefined;
const id = $props.id();
onMount(() => {
  mounted = true;
});
async function press(key: string) {
  if (disabled) return;
  const field = input.querySelector('input');
  if (!field) return;
  const start = caret?.start ?? field.selectionStart ?? field.value.length;
  const end = caret?.end ?? field.selectionEnd ?? start;
  if (key === '.') {
    const remaining = field.value.slice(0, start) + field.value.slice(end);
    if (remaining.includes('.')) return;
  }
  const from =
    key === 'delete' && start === end ? Math.max(0, start - 1) : start;
  const addition = key === 'delete' ? '' : key;
  text = field.value.slice(0, from) + addition + field.value.slice(end);
  await tick();
  caret = { start: from + addition.length, end: from + addition.length };
  field.setSelectionRange(caret.start, caret.end);
}
</script>
<div bind:this={input} class="amount-entry">
  <Input {name} bind:value={text} inputmode="decimal" {disabled} oninput={() => { caret = undefined; }} onselect={() => { if (input.querySelector("input") === document.activeElement) caret = undefined; }} />
  {#if mounted && keypad}
    <Button type="button" {disabled} aria-expanded={open} aria-controls={`keypad-${id}`} onclick={() => { open = !open; }}>{t(M['expenses.keypad.open'])}</Button>
    {#if open}
      <div class="keypad" id={`keypad-${id}`} role="group" aria-label={t(M['expenses.keypad.open'])}>
        {#each ['1','2','3','4','5','6','7','8','9','.','0','delete'] as key}
          <Button type="button" {disabled} aria-label={key === 'delete' ? t(M['expenses.keypad.delete']) : key === '.' ? t(M['expenses.keypad.decimal']) : key} onclick={() => press(key)}>{key === 'delete' ? '⌫' : key}</Button>
        {/each}
      </div>
    {/if}
  {/if}
</div>
<style>
  .amount-entry { display: grid; gap: var(--smrt-spacing-2); }
  .keypad { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--smrt-spacing-2); }
  .keypad :global(button) { min-height: var(--smrt-touch-target-min, 48px); }
</style>
