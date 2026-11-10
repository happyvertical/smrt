<script lang="ts" module>
import type { RecipientEntry } from '../types.js';

export interface Props {
  /** Field label such as To, Cc, or Bcc. */
  label?: string;
  /** Array of email recipients or addresses. */
  recipients: RecipientEntry[];
  /** Called when user adds or removes a recipient. */
  onchange?: (recipients: RecipientEntry[]) => void;
  /** Placeholder text for the recipient input field. */
  placeholder?: string;
}
</script>

<script lang="ts">
  import { Input } from '@happyvertical/smrt-ui/forms';
  import { Button } from '@happyvertical/smrt-ui/ui';

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

<div class="smrt-recipient-input__root" data-smrt-component="RecipientInput">
  <label class="smrt-recipient-input__label" data-smrt-part="label" for={inputId}>{label}</label>
  <div class="smrt-recipient-input__body" data-smrt-part="body">
    {#each recipients as recipient, i}
      <span class="smrt-recipient-input__chip" class:smrt-recipient-input__invalid={!recipient.isValid} data-smrt-part="chip">
        <span class="smrt-recipient-input__chip-title" data-smrt-part="chip-title">{recipient.name || recipient.address}</span>
        <Button
          variant="ghost"
          size="sm"
          class="chip-remove"
          onclick={() => removeRecipient(i)}
        >×</Button>
      </span>
    {/each}
    <Input
      id={inputId}
      type="text"
      class="recipient-field"
      bind:value={inputValue}
      {placeholder}
      onkeydown={handleKeydown}
      onblur={addRecipient}
    />
  </div>
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-recipient-input__root {
    display: flex;
    align-items: flex-start;
    gap: var(--smrt-spacing-2);
    padding: var(--smrt-spacing-1) 0;
  }
  .smrt-recipient-input__label {
    padding-top: var(--smrt-spacing-2);
    min-width: 32px;
  }
  .smrt-recipient-input__body {
    display: flex;
    flex-wrap: wrap;
    gap: var(--smrt-spacing-1);
    flex: 1;
    align-items: center;
  }
  .smrt-recipient-input__chip {
    display: inline-flex;
    align-items: center;
    gap: var(--smrt-spacing-1);
    padding: var(--smrt-spacing-1) var(--smrt-spacing-1) var(--smrt-spacing-1) var(--smrt-spacing-2);
  }
  /*
  * The chip remove button now renders through smrt-ui's <Button variant="ghost">.
  * `.smrt-recipient-input__body :global(.chip-remove)` anchors on the real `.smrt-recipient-input__body`
  * element and pierces the Button child scope to keep the compact icon styling.
  * `color: inherit` keeps it matching the chip text color (including the invalid
  * chip's error color) — issue #1589.
  */
  .smrt-recipient-input__body :global(.chip-remove) {
    padding: 0 var(--smrt-spacing-1);
  }
  /*
  * The chip-bar field now renders through smrt-ui's <Input>. This is a naked,
  * borderless inline field that sits among the recipient chips, so
  * `.smrt-recipient-input__body :global(.recipient-field)` pierces the Input child scope to
  * strip the primitive's border / background / block padding / focus box-shadow
  * and restore the flush inline look (issue #1589).
  */
  .smrt-recipient-input__body :global(.recipient-field) {
    flex: 1;
    min-width: 120px;
    padding: var(--smrt-spacing-1) 0;
  }
}

@layer smrt.theme {
  .smrt-recipient-input__root {
    border-bottom: var(--smrt-hairline);
  }
  .smrt-recipient-input__label {
    font-family: var(--smrt-font-family, system-ui);
    font-size: var(--smrt-typography-label-large-size);
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-recipient-input__chip {
    border-radius: var(--smrt-radius-sm);
    background: var(--smrt-color-secondary-container);
    color: var(--smrt-color-on-secondary-container);
    font-size: var(--smrt-typography-label-large-size);
    font-family: var(--smrt-font-family, system-ui);
  }
  .smrt-recipient-input__chip.smrt-recipient-input__invalid {
    background: var(--smrt-color-error-container);
    color: var(--smrt-color-on-error-container);
  }
  /*
  * The chip remove button now renders through smrt-ui's <Button variant="ghost">.
  * `.smrt-recipient-input__body :global(.chip-remove)` anchors on the real `.smrt-recipient-input__body`
  * element and pierces the Button child scope to keep the compact icon styling.
  * `color: inherit` keeps it matching the chip text color (including the invalid
  * chip's error color) — issue #1589.
  */
  .smrt-recipient-input__body :global(.chip-remove) {
    background: none;
    border: none;
    font-size: var(--smrt-typography-label-large-size);
    color: inherit;
    opacity: 0.7;
  }
  .smrt-recipient-input__body :global(.chip-remove):hover {
    opacity: 1;
  }
  /*
  * The chip-bar field now renders through smrt-ui's <Input>. This is a naked,
  * borderless inline field that sits among the recipient chips, so
  * `.smrt-recipient-input__body :global(.recipient-field)` pierces the Input child scope to
  * strip the primitive's border / background / block padding / focus box-shadow
  * and restore the flush inline look (issue #1589).
  */
  .smrt-recipient-input__body :global(.recipient-field) {
    border: none;
    outline: none;
    box-shadow: none;
    font-family: var(--smrt-font-family, system-ui);
    font-size: var(--smrt-typography-body-medium-size);
    background: transparent;
    color: var(--smrt-color-on-surface);
  }
  .smrt-recipient-input__body :global(.recipient-field):focus {
    border: none;
    box-shadow: none;
  }
}

</style>
