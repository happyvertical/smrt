<script lang="ts" module>
import type { RecipientEntry } from '../types.js';

export interface Props {
  label?: string;
  recipients: RecipientEntry[];
  onchange?: (recipients: RecipientEntry[]) => void;
  placeholder?: string;
}
</script>

<script lang="ts">
  let {
    label = 'To',
    recipients = [],
    onchange,
    placeholder = 'Add recipient...',
  }: Props = $props();

  let inputValue = $state('');
  const inputId = $derived(
    `recipient-input-${label.toLowerCase().replace(/[^a-z0-9]+/gi, '-')}`,
  );

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  function addRecipient() {
    const trimmed = inputValue.trim();
    if (!trimmed) return;

    const isValid = emailRegex.test(trimmed);
    const entry: RecipientEntry = {
      address: trimmed,
      isValid,
    };

    const updated = [...recipients, entry];
    onchange?.(updated);
    inputValue = '';
  }

  function removeRecipient(index: number) {
    const updated = recipients.filter((_, i) => i !== index);
    onchange?.(updated);
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      addRecipient();
    }
    if (event.key === 'Backspace' && !inputValue && recipients.length > 0) {
      removeRecipient(recipients.length - 1);
    }
  }
</script>

<div class="recipient-input">
  <label class="label" for={inputId}>{label}</label>
  <div class="chips-container">
    {#each recipients as recipient, i}
      <span class="chip" class:invalid={!recipient.isValid}>
        <span class="chip-text">{recipient.name || recipient.address}</span>
        <button
          class="chip-remove"
          onclick={() => removeRecipient(i)}
          type="button"
        >×</button>
      </span>
    {/each}
    <input
      id={inputId}
      type="text"
      class="input"
      bind:value={inputValue}
      {placeholder}
      onkeydown={handleKeydown}
      onblur={addRecipient}
    />
  </div>
</div>

<style>
  .recipient-input {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 4px 0;
    border-bottom: 1px solid var(--smrt-color-outline-variant, #cac4d0);
  }

  .label {
    font-family: var(--smrt-typography-label, system-ui);
    font-size: 14px;
    color: var(--smrt-color-on-surface-variant, #49454f);
    padding-top: 6px;
    min-width: 32px;
  }

  .chips-container {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    flex: 1;
    align-items: center;
  }

  .chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 4px 2px 8px;
    border-radius: var(--smrt-radius-sm, 8px);
    background: var(--smrt-color-secondary-container, #e8def8);
    color: var(--smrt-color-on-secondary-container, #1d192b);
    font-size: 13px;
    font-family: var(--smrt-typography-body, system-ui);
  }

  .chip.invalid {
    background: var(--smrt-color-error-container, #ffdad6);
    color: var(--smrt-color-on-error-container, #410002);
  }

  .chip-remove {
    background: none;
    border: none;
    cursor: pointer;
    padding: 0 4px;
    font-size: 14px;
    color: inherit;
    opacity: 0.7;
  }

  .chip-remove:hover {
    opacity: 1;
  }

  .input {
    flex: 1;
    min-width: 120px;
    border: none;
    outline: none;
    font-family: var(--smrt-typography-body, system-ui);
    font-size: 14px;
    padding: 4px 0;
    background: transparent;
    color: var(--smrt-color-on-surface, #1c1b1f);
  }
</style>
