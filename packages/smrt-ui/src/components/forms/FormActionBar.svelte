<script lang="ts">
/**
 * FormActionBar — a form's actions (Cancel · Save draft · Publish).
 *
 * Inline under the form on wider screens. On phones (up to 48rem) it is fixed
 * to the bottom of the screen, padded for the safe area, and replaces the
 * shell's phone bottom bar: `AdminShell` sees the `data-form-action-bar`
 * attribute and hides its own bar. Hidden while the on-screen keyboard is open
 * (`:root[data-keyboard-open]`, set by the shell's keyboard watcher). Put the
 * primary action last.
 */
import type { Snippet } from 'svelte';
import { M } from '../../i18n/strings.ui.js';
import { useI18n } from '../../i18n/use-i18n.js';

export interface Props {
  /** Accessible name of the action group (default "Form actions"). */
  label?: string;
  /** Inside a toolbar the page already draws: no rule or margin on wider screens. */
  plain?: boolean;
  /** The action buttons, primary last. */
  children: Snippet;
}

let { label, plain = false, children }: Props = $props();

const { t } = useI18n();
</script>

<div
  class="form-action-bar"
  class:plain
  role="group"
  aria-label={label ?? t(M['ui.form_action_bar.label'])}
  data-form-action-bar
  data-testid="form-action-bar"
>
  {@render children()}
</div>

<style>
  .form-action-bar {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    align-items: center;
    gap: var(--smrt-spacing-3);
    margin-block-start: var(--smrt-spacing-6);
    padding-block-start: var(--smrt-spacing-4);
    border-block-start: 1px solid var(--smrt-color-outline-variant);
  }

  .form-action-bar.plain {
    margin: 0;
    padding: 0;
    border: 0;
  }

  @media (max-width: 48rem) {
    .form-action-bar,
    .form-action-bar.plain {
      position: fixed;
      inset: auto 0 0;
      z-index: 12;
      flex-wrap: nowrap;
      gap: var(--smrt-spacing-2);
      margin: 0;
      padding: var(--smrt-spacing-2) var(--smrt-spacing-4)
        calc(var(--smrt-spacing-2) + env(safe-area-inset-bottom));
      border-block-start: 1px solid var(--smrt-color-outline-variant);
      background: var(--smrt-color-surface);
      box-shadow: var(--smrt-elevation-2);
    }

    .form-action-bar > :global(*) {
      flex: 1 1 0;
      min-block-size: 2.75rem;
    }

    :global(:root[data-keyboard-open]) .form-action-bar {
      display: none;
    }
  }
</style>
