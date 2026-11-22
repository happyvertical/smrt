<script lang="ts">
/**
 * PasswordInput — a password field with an accessible "Show password" toggle
 * and an optional "Confirm password" field (happyvertical/smrt#5346).
 *
 * - The toggle is a labelled checkbox (no `name`, so it is never submitted)
 *   at least 44px tall (48px under a coarse pointer). It reveals both fields.
 * - With `confirm`, a mismatch sets the confirm field's custom validity to
 *   "Passwords do not match". The confirm field has no `name` unless
 *   `confirmName` is given, so it is not posted under the password's name.
 * - Pair with `validateBeforeSubmit` (or `<Form validate>`) to show the reason.
 */
import Input from './Input.svelte';

export interface Props {
  /** Field name posted with the form. */
  name?: string;
  /** Base id; the confirm field uses `${id}-confirm`. */
  id?: string;
  /** Password value (bindable). */
  value?: string;
  /** Label above the password field. */
  label?: string;
  /** Render a "Confirm password" field and check it matches. */
  confirm?: boolean;
  /** Confirm field label. */
  confirmLabel?: string;
  /** Optional name for the confirm field; omitted by default (not submitted). */
  confirmName?: string;
  /** Confirm value (bindable). */
  confirmValue?: string;
  /** Reason shown when the two fields differ. */
  mismatchMessage?: string;
  /** Toggle label. */
  showLabel?: string;
  /** Whether a password (and, with `confirm`, its confirmation) is required. */
  required?: boolean;
  /** Minimum password length, enforced by the browser's validation. */
  minlength?: number;
  /** Maximum password length, enforced by the browser's validation. */
  maxlength?: number;
  /** Autofill hint; `new-password` for sign-up, `current-password` for sign-in. */
  autocomplete?: 'new-password' | 'current-password' | 'off';
  /** Disables the fields and the show toggle. */
  disabled?: boolean;
  /** CSS class applied to the wrapper element. */
  class?: string;
}

let {
  name,
  id,
  value = $bindable(''),
  label = 'Password',
  confirm = false,
  confirmLabel = 'Confirm password',
  confirmName,
  confirmValue = $bindable(''),
  mismatchMessage = 'Passwords do not match',
  showLabel = 'Show password',
  required = false,
  minlength,
  maxlength,
  autocomplete = 'new-password',
  disabled = false,
  class: className = '',
}: Props = $props();

const instanceId = $props.id();
const baseId = $derived(id ?? `smrt-password-${instanceId}`);
const confirmId = $derived(`${baseId}-confirm`);
let visible = $state(false);
let rootEl = $state<HTMLDivElement | null>(null);

// Reads the live DOM values so it is correct inside an input event, before
// the bound `$state` has been flushed.
function syncMatch() {
  const passwordEl = rootEl?.querySelector<HTMLInputElement>(
    `[id="${baseId}"]`,
  );
  const confirmEl = rootEl?.querySelector<HTMLInputElement>(
    `[id="${confirmId}"]`,
  );
  if (!confirmEl) return;
  const mismatch =
    confirm && confirmEl.value !== '' && confirmEl.value !== passwordEl?.value;
  confirmEl.setCustomValidity(mismatch ? mismatchMessage : '');
}

$effect(() => {
  void value;
  void confirmValue;
  void confirm;
  void mismatchMessage;
  syncMatch();
});

function handleInput() {
  // Run synchronously so a form-level validator sees the fresh validity.
  syncMatch();
}
</script>

<div bind:this={rootEl} class="smrt-password-input__root {className}" data-smrt-component="PasswordInput">
  <div class="smrt-password-input__field">
    <label class="smrt-password-input__label" for={baseId}>{label}</label>
    <Input
      id={baseId}
      {name}
      type={visible ? 'text' : 'password'}
      bind:value
      {required}
      {disabled}
      minlength={minlength}
      maxlength={maxlength}
      {autocomplete}
      oninput={handleInput}
      spellcheck={false}
      autocapitalize="off"
    />
  </div>
  {#if confirm}
    <div class="smrt-password-input__field">
      <label class="smrt-password-input__label" for={confirmId}>{confirmLabel}</label>
      <Input
        id={confirmId}
        name={confirmName}
        type={visible ? 'text' : 'password'}
        bind:value={confirmValue}
        {required}
        {disabled}
        autocomplete="new-password"
        oninput={handleInput}
        spellcheck={false}
        autocapitalize="off"
      />
    </div>
  {/if}
  <label class="smrt-password-input__toggle">
    <input type="checkbox" bind:checked={visible} {disabled} data-smrt-skip-validation />
    <span>{showLabel}</span>
  </label>
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-password-input__root {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-3, 0.75rem);
  }
  .smrt-password-input__field {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-1, 0.25rem);
  }
  .smrt-password-input__toggle {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    min-height: 2.75rem;
    cursor: pointer;
    align-self: flex-start;
  }
  .smrt-password-input__toggle input {
    width: 1.25rem;
    height: 1.25rem;
    margin: 0;
  }
  @media (pointer: coarse) {
    .smrt-password-input__toggle {
      min-height: 3rem;
    }
  }
}
@layer smrt.theme {
  .smrt-password-input__label,
  .smrt-password-input__toggle {
    font-size: var(--smrt-typography-body-medium-size);
    color: var(--smrt-color-on-surface);
  }
}
</style>
