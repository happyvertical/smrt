<!--
  On-screen number keypad for quantities and money, sized for gloved hands.

  Typed text is the value: `value` ($bindable) holds exactly what was typed,
  as a string (`"12.5"`). A 3x4 grid carries the digits, a decimal point
  (only when `maxDecimals` > 0) and backspace; Clear sits beside the display
  and an optional confirm key sits under the grid. All entry rules live in the
  Svelte-free `numeric-keypad-logic.ts`.

  `mode="money"` keeps integer minor units: the decimals allowed follow the
  currency's ISO 4217 exponent, callbacks carry `minorUnits` computed by string
  arithmetic (never a float), and a `name` posts that integer. In number mode a
  `name` posts the typed text. Hardware keys work while focus is inside the
  keypad: digits, `.` / `,` for the point, Backspace, Delete (clear) and Enter
  (confirm, when the keypad itself rather than a key has focus).

  Every key is at least 4rem square. The display is a polite live region.
  This is a quantity/money pad, not a PIN pad: the value is shown as text.

  smrt#3463.
-->
<script lang="ts">
import { M, useI18n } from '../../i18n/index.js';
import { renderTemplate } from '../../i18n/render.js';
import {
  focusControl,
  highlightControl,
  revealControl,
} from './control-dom.js';
import type { ControlInteractionOptions } from './control-interaction.js';
import { tryGetControlInteractionContext } from './control-interaction-context.js';
import {
  applyKey,
  DEFAULT_MAX_LENGTH,
  type EntryRules,
  exceedsMax,
  type KeypadKey,
  keyFromKeyboard,
  minorUnitExponent,
  type NumericKeypadDetail,
  normalizeText,
  parseEntry,
  textToMinorUnits,
  validateEntry,
} from './numeric-keypad-logic.js';
import type { NumericKeypadLabels } from './types.js';
import { useControlRegistration } from './use-control-registration.svelte.js';

export interface Props {
  /** Typed text; a number is accepted and re-written as text on the next key. */
  value?: string | number | null;
  /** `money` follows the currency's minor-unit exponent. Default `number`. */
  mode?: 'number' | 'money';
  /** Smallest acceptable value (major units); below it the keypad shows an error. */
  min?: number;
  /** Largest acceptable value (major units). */
  max?: number;
  /** Refuse a key press that would take the value above `max`. */
  clampToMax?: boolean;
  /** Digits after the point; 0 is integer-only. Default 0, or the currency's in money mode. */
  maxDecimals?: number;
  /** Longest typed text, counting the point. */
  maxLength?: number;
  /** ISO 4217 code for money mode (sets the minor-unit exponent). Default exponent 2. */
  currency?: string;
  /** Override the money minor-unit exponent. */
  minorUnitExponent?: number;
  /** Shown before the display value (a currency symbol). */
  prefix?: string;
  /** Shown after the display value (a unit such as `pcs`). */
  unit?: string;
  /** Accessible name; defaults to the `labels.region` text. */
  label?: string;
  /** Called after every change with the parsed entry. */
  onChange?: (detail: NumericKeypadDetail) => void;
  /** Called by the confirm key / Enter; supplying it shows the confirm key. */
  onSubmit?: (detail: NumericKeypadDetail) => void;
  /** Confirm key text; defaults to the catalog's "Confirm". */
  submitLabel?: string;
  /** Ignores input and disables every key. */
  disabled?: boolean;
  /** Field name: posts the typed text (number) or integer minor units (money). */
  name?: string;
  /** Text overrides; defaults come from the `ui` i18n catalog. */
  labels?: Partial<NumericKeypadLabels>;
  /** DOM id of the component root. */
  id?: string;
  /** CSS class to apply to the component root. */
  class?: string;
  /** Interaction options or false to disable registration. */
  interaction?: ControlInteractionOptions | false;
}

let {
  value = $bindable(''),
  mode = 'number',
  min,
  max,
  clampToMax = false,
  maxDecimals,
  maxLength = DEFAULT_MAX_LENGTH,
  currency,
  minorUnitExponent: exponentOverride,
  prefix,
  unit,
  label,
  onChange,
  onSubmit,
  submitLabel,
  disabled = false,
  name,
  labels,
  id,
  class: className = '',
  interaction,
}: Props = $props();

const { t } = useI18n();
const text = $derived<NumericKeypadLabels>({
  region: t(M['ui.numeric_keypad.region']),
  display: t(M['ui.numeric_keypad.display']),
  decimal: t(M['ui.numeric_keypad.decimal']),
  backspace: t(M['ui.numeric_keypad.backspace']),
  clear: t(M['ui.numeric_keypad.clear']),
  submit: submitLabel ?? t(M['ui.numeric_keypad.submit']),
  belowMin: t(M['ui.numeric_keypad.below_min']),
  aboveMax: t(M['ui.numeric_keypad.above_max']),
  invalidAmount: t(M['ui.numeric_keypad.invalid_amount']),
  ...labels,
});

const instanceId = $props.id();
const interactionContext = tryGetControlInteractionContext();
const resolvedId = $derived(id ?? `smrt-keypad-${instanceId}`);
const messageId = $derived(`${resolvedId}-message`);
const controlId = $derived(
  interaction === false ? undefined : (interaction?.id ?? name ?? resolvedId),
);

const exponent = $derived(exponentOverride ?? minorUnitExponent(currency, 2));
const decimals = $derived(maxDecimals ?? (mode === 'money' ? exponent : 0));
// Money cannot carry more decimals than the currency has minor units.
const rules = $derived<EntryRules>({
  maxDecimals: mode === 'money' ? Math.min(decimals, exponent) : decimals,
  maxLength,
});
const typed = $derived(normalizeText(value, rules));
const validity = $derived(entryValidity(typed));
const showError = $derived(
  validity === 'below' || validity === 'above' || validity === 'invalid',
);
const errorText = $derived(
  validity === 'below'
    ? renderTemplate(text.belowMin, { min })
    : validity === 'above'
      ? renderTemplate(text.aboveMax, { max })
      : validity === 'invalid'
        ? text.invalidAmount
        : '',
);
const minorUnits = $derived(
  mode === 'money' ? textToMinorUnits(typed, exponent) : null,
);
const postedValue = $derived(
  mode === 'money' ? (minorUnits === null ? '' : String(minorUnits)) : typed,
);

let rootEl = $state<HTMLDivElement | null>(null);

function entryValidity(next: string) {
  const result = validateEntry(next, { min, max });
  return result === 'ok' &&
    mode === 'money' &&
    textToMinorUnits(next, exponent) === null
    ? 'invalid'
    : result;
}

function detail(next: string): NumericKeypadDetail {
  return {
    text: next,
    number: parseEntry(next),
    minorUnits: mode === 'money' ? textToMinorUnits(next, exponent) : null,
    valid: entryValidity(next) === 'ok',
  };
}

function press(key: KeypadKey): void {
  if (disabled) return;
  const next = applyKey(typed, key, rules);
  if (clampToMax && key.kind !== 'backspace' && key.kind !== 'clear') {
    if (exceedsMax(next, max)) return;
  }
  if (next === typed && value === typed) return;
  value = next;
  onChange?.(detail(next));
}

function submit(): void {
  if (disabled || !onSubmit || validity !== 'ok') return;
  onSubmit(detail(typed));
}

function handleKeydown(event: KeyboardEvent): void {
  if (disabled || event.defaultPrevented) return;
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  // Enter on a focused key activates that key natively; only the keypad
  // itself (focus on the root) confirms.
  if (event.key === 'Enter') {
    if (event.target === rootEl && onSubmit) {
      event.preventDefault();
      submit();
    }
    return;
  }
  const key = keyFromKeyboard(event.key);
  if (!key) return;
  event.preventDefault();
  press(key);
}

function setFromOutside(next: unknown): void {
  const prepared = prepareValue(next);
  value = prepared as string;
  onChange?.(detail(prepared as string));
}

function prepareValue(next: unknown): unknown {
  if (next === null || next === undefined || next === '') return '';
  if (typeof next !== 'string' && typeof next !== 'number') {
    throw new Error('staged_value_invalid');
  }
  const normalized = normalizeText(next, rules);
  if (normalized === '') throw new Error('staged_value_invalid');
  return normalized;
}

useControlRegistration(() => {
  const root = rootEl;
  if (!root || interaction === false) return false;
  return {
    controlId,
    subject: interaction?.subject,
    metadata: {
      kind: 'number',
      label: label ?? text.region,
      description: interaction?.description,
      sensitivity: interaction?.sensitivity ?? 'public',
      readable: interaction?.readable,
      writable: interaction?.writable,
      constraints: { min, max },
      unit,
    },
    getValue: () => typed,
    prepareValue,
    setValue: setFromOutside,
    clear: () => {
      press({ kind: 'clear' });
      return true;
    },
    focus: () => focusControl(root),
    reveal: () => revealControl(root),
    highlight: (durationMs) => highlightControl(root, durationMs),
    validate: () => validity === 'ok' || validity === 'empty',
    validateValue: (next) => {
      try {
        const outcome = entryValidity(String(prepareValue(next)));
        return outcome === 'ok' || outcome === 'empty';
      } catch {
        return false;
      }
    },
    getState: () => ({ disabled, valid: !showError }),
  };
});

const DIGIT_ROWS = [
  ['1', '2', '3'],
  ['4', '5', '6'],
  ['7', '8', '9'],
] as const;
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions, a11y_no_noninteractive_tabindex (hardware keyboard entry: the group takes focus so typed digits work before any key is touched) -->
<div
  bind:this={rootEl}
  id={resolvedId}
  class="numeric-keypad {className}"
  class:disabled
  role="group"
  tabindex={disabled ? undefined : 0}
  aria-label={label ?? text.region}
  data-state={validity}
  data-mode={mode}
  data-smrt-control={controlId}
  data-smrt-form={interactionContext?.formId}
  data-smrt-subject-type={interaction === false ? undefined : interaction?.subject?.type}
  data-smrt-subject-id={interaction === false ? undefined : interaction?.subject?.id}
  data-smrt-component="NumericKeypad"
  onkeydown={handleKeydown}
>
  <div class="readout">
    <output
      class="display"
      data-smrt-part="display"
      data-empty={typed === '' ? 'true' : undefined}
      aria-label={text.display}
      aria-live="polite"
      aria-atomic="true"
      aria-describedby={showError ? messageId : undefined}
    >
      {#if prefix}<span class="affix" data-smrt-part="prefix">{prefix}</span>{/if}
      <span class="entry">{typed === '' ? '0' : typed}</span>
      {#if unit}<span class="affix" data-smrt-part="unit">{unit}</span>{/if}
    </output>
    <button
      type="button"
      class="key clear"
      data-smrt-part="key"
      data-key="clear"
      aria-label={text.clear}
      {disabled}
      onclick={() => press({ kind: 'clear' })}
    >
      {text.clear}
    </button>
  </div>

  <p id={messageId} class="message" data-smrt-part="message" role="status">{errorText}</p>

  <div class="grid" data-smrt-part="grid">
    {#each DIGIT_ROWS as row (row[0])}
      {#each row as digit (digit)}
        <button
          type="button"
          class="key digit"
          data-smrt-part="key"
          data-key={digit}
          aria-label={digit}
          {disabled}
          onclick={() => press({ kind: 'digit', digit })}
        >
          {digit}
        </button>
      {/each}
    {/each}
    {#if rules.maxDecimals > 0}
      <button
        type="button"
        class="key"
        data-smrt-part="key"
        data-key="decimal"
        aria-label={text.decimal}
        {disabled}
        onclick={() => press({ kind: 'decimal' })}
      >
        .
      </button>
    {:else}
      <span class="spacer" aria-hidden="true"></span>
    {/if}
    <button
      type="button"
      class="key digit"
      data-smrt-part="key"
      data-key="0"
      aria-label="0"
      {disabled}
      onclick={() => press({ kind: 'digit', digit: '0' })}
    >
      0
    </button>
    <button
      type="button"
      class="key"
      data-smrt-part="key"
      data-key="backspace"
      aria-label={text.backspace}
      {disabled}
      onclick={() => press({ kind: 'backspace' })}
    >
      <span aria-hidden="true">⌫</span>
    </button>
  </div>

  {#if onSubmit}
    <button
      type="button"
      class="key submit"
      data-smrt-part="submit"
      aria-label={text.submit}
      disabled={disabled || validity !== 'ok'}
      onclick={submit}
    >
      {text.submit}
    </button>
  {/if}

  {#if name}
    <input type="hidden" {name} value={postedValue} {disabled} data-smrt-keypad-field />
  {/if}
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.theme {
  .numeric-keypad {
    display: grid;
    gap: var(--smrt-spacing-3);
    width: 100%;
    max-width: 24rem;
    color: var(--smrt-color-on-surface);
  }
  .numeric-keypad:focus-visible {
    outline: var(--smrt-focus-ring-width) solid var(--smrt-focus-ring-color);
    outline-offset: var(--smrt-focus-ring-offset);
  }
  .readout {
    display: flex;
    gap: var(--smrt-spacing-3);
    align-items: stretch;
  }
  .display {
    display: flex;
    flex: 1 1 auto;
    align-items: baseline;
    justify-content: flex-end;
    gap: var(--smrt-spacing-2);
    min-width: 0;
    min-height: 4rem;
    padding: 0 var(--smrt-spacing-4);
    border: var(--smrt-hairline-strong);
    border-radius: var(--smrt-radius-medium);
    background: var(--smrt-color-surface-container-lowest);
    font: var(--smrt-typography-headline-large-font);
    align-items: center;
    overflow: hidden;
  }
  [data-state='below'] .display,
  [data-state='above'] .display {
    border-color: var(--smrt-color-error);
  }
  .display[data-empty='true'] .entry {
    color: var(--smrt-color-on-surface-variant);
  }
  .entry {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  .affix {
    color: var(--smrt-color-on-surface-variant);
    font: var(--smrt-typography-title-large-font);
  }
  .message {
    margin: 0;
    color: var(--smrt-color-error);
    font: var(--smrt-typography-body-medium-font);
  }
  .message:empty {
    display: none;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: var(--smrt-spacing-3);
  }
  .key {
    /* Gloved hands: never below 4rem, whatever the density token says. */
    min-width: max(4rem, var(--smrt-touch-target-min));
    min-height: max(4rem, var(--smrt-touch-target-min));
    padding: 0 var(--smrt-spacing-3);
    border: var(--smrt-hairline-strong);
    border-radius: var(--smrt-radius-medium);
    background: var(--smrt-color-surface-container-highest);
    color: var(--smrt-color-on-surface);
    font: var(--smrt-typography-headline-large-font);
    cursor: pointer;
    touch-action: manipulation;
    user-select: none;
  }
  .key.clear {
    font: var(--smrt-typography-label-large-font);
  }
  .key:active:not(:disabled) {
    background: var(--smrt-color-surface-container-high);
  }
  .key.submit {
    border-color: var(--smrt-color-primary);
    background: var(--smrt-color-primary);
    color: var(--smrt-color-on-primary);
    font: var(--smrt-typography-title-large-font);
  }
  .key:focus-visible {
    outline: var(--smrt-focus-ring-width) solid var(--smrt-focus-ring-color);
    outline-offset: var(--smrt-focus-ring-offset);
  }
  .key:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .disabled .display {
    opacity: 0.5;
  }
  :global(.numeric-keypad[data-smrt-highlighted='true']) {
    outline: var(--smrt-focus-ring-width) solid var(--smrt-color-tertiary);
    outline-offset: var(--smrt-focus-ring-offset);
  }
}
</style>
