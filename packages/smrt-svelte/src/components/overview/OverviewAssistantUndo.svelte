<script lang="ts">
/**
 * The inline Undo affordance for an assistant's overview edit (#3727 phase
 * 4). While the last batch can be undone it shows a short message with an
 * Undo button and a dismiss button; the outcome of Undo is announced in the
 * same polite live region. Place it next to the `OverviewGrid` it belongs to.
 */
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import { M } from '../../i18n/strings.overview.js';
import type {
  OverviewAssistant,
  OverviewAssistantBatch,
} from './assistant.svelte.js';

interface Props {
  /** The browser assistant from `createOverviewAssistant`. */
  assistant: OverviewAssistant;
  /** Message for a batch (default: a generic "updated" line). */
  message?: (batch: OverviewAssistantBatch) => string;
  /** Extra class names for the affordance's row, for host placement. */
  class?: string;
}

let { assistant, message, class: className = '' }: Props = $props();
const { t } = useI18n();
const batch = $derived(assistant.lastBatch);
let outcome = $state('');

function undo(): void {
  const current = batch;
  if (!current) return;
  const result = assistant.undo(current.id);
  outcome = result.ok
    ? t(M['ui.overview.assistant_undone'])
    : result.reason === 'changed_since'
      ? t(M['ui.overview.assistant_changed_since'])
      : t(M['ui.overview.assistant_undo_failed']);
}

$effect(() => {
  // A new batch replaces the previous outcome line.
  if (batch) outcome = '';
});
</script>

<div class="smrt-overview-assistant-undo {className}" data-active={batch ? '' : undefined}>
  <!-- The live region stays mounted so each new message is announced. -->
  <span class="smrt-overview-assistant-undo__message" role="status" aria-live="polite">
    {#if batch}
      {message ? message(batch) : t(M['ui.overview.assistant_applied'])}
    {:else}
      {outcome}
    {/if}
  </span>
  {#if batch}
    <Button size="sm" variant="secondary" onclick={undo}>
      {t(M['ui.overview.assistant_undo'])}
    </Button>
    <Button size="sm" variant="ghost" onclick={() => assistant.dismiss()}>
      {t(M['ui.overview.assistant_dismiss'])}
    </Button>
  {/if}
</div>

<style>
  .smrt-overview-assistant-undo {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--smrt-spacing-2, 0.5rem);
  }

  .smrt-overview-assistant-undo__message {
    flex: 1 1 12rem;
  }
</style>
