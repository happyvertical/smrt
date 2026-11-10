<!--
  "AI is off, open settings" (#4757): what a chat surface shows instead of a
  failure when the server answered `ai_unavailable` (mode off, nothing set
  up, ...). The settings link target is the host's: without `settingsHref`
  the notice shows the reason only.
-->
<script lang="ts">
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import type { ChatUnavailableStatus } from '../../../client.js';
import { M } from '../../i18n.js';

export interface AiUnavailableNoticeProps {
  /** Why AI is unavailable, from the server's `ai_unavailable` answer. */
  status: Pick<ChatUnavailableStatus, 'reason'>;
  /** Host route of its AI settings page (e.g. the #4754 "My AI" panel). */
  settingsHref?: string;
  /** Link text; defaults to "Open AI settings". */
  settingsLabel?: string;
}

const { status, settingsHref, settingsLabel }: AiUnavailableNoticeProps =
  $props();

const { t } = useI18n();

const MESSAGES = {
  off: M['chat.ai_unavailable.off'],
  unconfigured: M['chat.ai_unavailable.unconfigured'],
  entitlement: M['chat.ai_unavailable.entitlement'],
  capability: M['chat.ai_unavailable.capability'],
} as const;

const message = $derived(t(MESSAGES[status.reason] ?? MESSAGES.off));
</script>

<p class="smrt-ai-unavailable-notice__root" role="status" data-reason={status.reason} data-smrt-component="AiUnavailableNotice">
  <span>{message}</span>
  {#if settingsHref}
    <a class="smrt-ai-unavailable-notice__link" data-smrt-part="link" href={settingsHref}>
      {settingsLabel ?? t(M['chat.ai_unavailable.open_settings'])}
    </a>
  {/if}
</p>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-ai-unavailable-notice__root {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--smrt-spacing-2);
    margin: 0;
    padding: var(--smrt-spacing-2) var(--smrt-spacing-3);
  }
}

@layer smrt.theme {
  .smrt-ai-unavailable-notice__root {
    font: var(--smrt-typography-body-small-font, 0.8125rem/1.4 sans-serif);
    color: var(--smrt-color-on-surface);
    background: var(--smrt-color-surface-container);
    border-bottom: var(--smrt-hairline);
  }
  .smrt-ai-unavailable-notice__link {
    color: var(--smrt-color-primary);
    font-weight: var(--smrt-typography-weight-semibold);
  }
}

</style>
