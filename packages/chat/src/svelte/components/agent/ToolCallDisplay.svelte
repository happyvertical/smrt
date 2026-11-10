<script lang="ts">
/**
 * ToolCallDisplay - Inline tool call/result display
 * Collapsible card showing tool name, arguments (as JSON), status indicator,
 * and result/error. Color-coded by status (pending, running, success, error).
 */
import type { DataSurfaceActionResult } from '@happyvertical/smrt-ui/data-surface';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import { M } from '../../i18n.js';
import type { ToolCallDisplayData } from '../../types.js';

export interface Props {
  /** Tool call data */
  toolCall: ToolCallDisplayData;
  /**
   * Data-surface action preview/apply outcome (#2904, AssistantDock). Additive:
   * when present, the body renders a preview/applied/failed panel for the
   * action alongside the generic tool-call rendering above; existing callers
   * that never pass this prop see no change.
   */
  actionResult?: DataSurfaceActionResult;
  /** Fired by the Confirm button, shown only while
   * `actionResult.phase === 'preview' && actionResult.ok`. */
  onconfirmaction?: () => void;
  /** Fired by the Reject button, shown alongside `onconfirmaction`. */
  onrejectaction?: () => void;
}

const { toolCall, actionResult, onconfirmaction, onrejectaction }: Props =
  $props();

const { t } = useI18n();

// When an actionResult is present it overrides the generic tool-call status
// for both the pill and the outer card's color: a preview that's still
// awaiting Confirm/Reject must never read "Completed" (#2904 review fix) —
// only an applied action reads that way.
const effectiveStatus = $derived.by(() => {
  if (!actionResult) return toolCall.status;
  if (!actionResult.ok) return 'error';
  return actionResult.phase === 'preview' ? 'awaiting-confirmation' : 'applied';
});

// A pending preview (awaiting Confirm/Reject), a running tool call, or a
// failed action starts expanded so the action buttons / live output /
// failure reason are visible without a click; the user's own toggle always
// wins after that.
let userToggledExpanded = $state<boolean | null>(null);
const autoExpanded = $derived(
  effectiveStatus === 'awaiting-confirmation' ||
    effectiveStatus === 'applied' ||
    toolCall.status === 'running' ||
    (Boolean(actionResult) && effectiveStatus === 'error'),
);
const isExpanded = $derived(userToggledExpanded ?? autoExpanded);

const statusLabel = $derived.by(() => {
  switch (effectiveStatus) {
    case 'pending':
      return 'Pending';
    case 'running':
      return 'Running';
    case 'success':
      return 'Completed';
    case 'error':
      return actionResult ? 'Failed' : 'Error';
    case 'awaiting-confirmation':
      return 'Awaiting confirmation';
    case 'applied':
      return 'Applied';
    default:
      return effectiveStatus;
  }
});

function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return '';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
</script>

<div class="smrt-tool-call-display__root smrt-tool-call-display__root--{effectiveStatus}" aria-label={t(M['chat.tool_call_display.tool_call'], { toolName: toolCall.toolName })} data-smrt-component="ToolCallDisplay">
  <!-- raw-primitive-allow: full-width disclosure trigger with aria-expanded and aria-controls toggling an externally-rendered collapsible panel, wrapping rich content (status dot, name, duration, status label, rotating chevron); structural accordion header no Button primitive owns -->
  <button
    class="smrt-tool-call-display__header"
    data-smrt-part="trigger"
    type="button"
    onclick={() => userToggledExpanded = !isExpanded}
    aria-expanded={isExpanded}
    aria-controls="tool-call-body-{toolCall.toolCallId}"
  >
    <div class="smrt-tool-call-display__status-dot" data-smrt-part="indicator" aria-label="{statusLabel}"></div>

    <span class="smrt-tool-call-display__name" data-smrt-part="label">{toolCall.toolName}</span>

    <div class="smrt-tool-call-display__header-right" data-smrt-part="meta">
      {#if toolCall.duration !== undefined}
        <span class="smrt-tool-call-display__duration" data-smrt-part="duration">{formatDuration(toolCall.duration)}</span>
      {/if}
      <span class="smrt-tool-call-display__status-label" data-smrt-part="status">{statusLabel}</span>
      <svg
        class="smrt-tool-call-display__chevron"
        data-smrt-part="chevron"
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="currentColor"
        aria-hidden="true"
      
  class:smrt-tool-call-display__chevron--open={isExpanded}
>
        <path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z" />
      </svg>
    </div>
  </button>

  {#if isExpanded}
    <div class="smrt-tool-call-display__body" data-smrt-part="body" id="tool-call-body-{toolCall.toolCallId}">
      {#if toolCall.arguments && Object.keys(toolCall.arguments).length > 0}
        <div class="smrt-tool-call-display__section" data-smrt-part="section">
          <span class="smrt-tool-call-display__section-label" data-smrt-part="section-label">Arguments</span>
          <pre class="smrt-tool-call-display__json" data-smrt-part="json">{formatJson(toolCall.arguments)}</pre>
        </div>
      {/if}

      {#if toolCall.status === 'success' && toolCall.result !== undefined}
        <div class="smrt-tool-call-display__section" data-smrt-part="section">
          <span class="smrt-tool-call-display__section-label" data-smrt-part="section-label">Result</span>
          <pre class="smrt-tool-call-display__json smrt-tool-call-display__json--result" data-smrt-part="json">{formatJson(toolCall.result)}</pre>
        </div>
      {/if}

      {#if toolCall.status === 'error' && toolCall.error}
        <div class="smrt-tool-call-display__section" data-smrt-part="section">
          <span class="smrt-tool-call-display__section-label" data-smrt-part="section-label">Error</span>
          <pre class="smrt-tool-call-display__json smrt-tool-call-display__json--error" data-smrt-part="json">{toolCall.error}</pre>
        </div>
      {/if}

      {#if toolCall.status === 'running'}
        <div class="smrt-tool-call-display__running" data-smrt-part="running">
          <div class="smrt-tool-call-display__spinner" data-smrt-part="spinner" aria-label={t(M['chat.tool_call_display.running'])}></div>
          <span>Executing...</span>
        </div>
      {/if}

      {#if actionResult}
        <div class="smrt-tool-call-display__section smrt-tool-call-display__action" data-smrt-part="action" data-phase={actionResult.phase} data-ok={actionResult.ok}>
          <span class="smrt-tool-call-display__section-label" data-smrt-part="section-label">
            {actionResult.phase === 'preview' ? 'Proposed change' : 'Applied change'}
          </span>
          {#if actionResult.ok}
            {#if actionResult.details}
              <pre class="smrt-tool-call-display__json" data-smrt-part="json">{formatJson(actionResult.details)}</pre>
            {:else if actionResult.phase === 'apply'}
              <p class="smrt-tool-call-display__applied-fallback" data-smrt-part="message">
                {t(M['chat.tool_call_display.applied_successfully'])}
              </p>
            {/if}
            {#if actionResult.phase === 'preview'}
              <div class="smrt-tool-call-display__actions" data-smrt-part="actions">
                <Button type="button" size="sm" onclick={() => onconfirmaction?.()}>
                  {t(M['chat.tool_call_display.confirm'])}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onclick={() => onrejectaction?.()}
                >
                  {t(M['chat.tool_call_display.reject'])}
                </Button>
              </div>
            {/if}
          {:else}
            <pre class="smrt-tool-call-display__json smrt-tool-call-display__json--error" data-smrt-part="json">{actionResult.reason ?? 'Action failed'}</pre>
          {/if}
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-tool-call-display__root {
    overflow: hidden;
  }
  .smrt-tool-call-display__header {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-2);
    width: 100%;
    padding: var(--smrt-spacing-2) var(--smrt-spacing-3);
    cursor: pointer;
  }
  .smrt-tool-call-display__status-dot {
    width: 8px;
    height: 8px;
    flex-shrink: 0;
  }
  .smrt-tool-call-display__applied-fallback {
    margin: 0;
  }
  .smrt-tool-call-display__name {
    flex: 1;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .smrt-tool-call-display__header-right {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-2);
    flex-shrink: 0;
  }
  .smrt-tool-call-display__body {
    padding: var(--smrt-spacing-2) var(--smrt-spacing-3) var(--smrt-spacing-3);
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-2);
  }
  .smrt-tool-call-display__section {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-1);
  }
  .smrt-tool-call-display__json {
    margin: 0;
    padding: var(--smrt-spacing-2);
    overflow-x: auto;
    white-space: pre-wrap;
    word-break: break-all;
    max-height: 200px;
    overflow-y: auto;
  }
  .smrt-tool-call-display__running {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-2);
    padding: var(--smrt-spacing-2);
  }
  .smrt-tool-call-display__spinner {
    width: 16px;
    height: 16px;
  }
}

@layer smrt.theme {
  .smrt-tool-call-display__root {
    border: var(--smrt-hairline);
    border-radius: var(--smrt-radius-medium);
    font-family: var(--smrt-font-family, system-ui);
  }
  .smrt-tool-call-display__root--pending {
    border-left: 3px solid var(--smrt-color-outline);
  }
  .smrt-tool-call-display__root--running {
    border-left: 3px solid var(--smrt-color-primary);
  }
  .smrt-tool-call-display__root--success {
    border-left: 3px solid var(--smrt-color-success);
  }
  .smrt-tool-call-display__root--error {
    border-left: 3px solid var(--smrt-color-error);
  }
  .smrt-tool-call-display__root--awaiting-confirmation {
    border-left: 3px solid var(--smrt-color-tertiary);
  }
  .smrt-tool-call-display__root--applied {
    border-left: 3px solid var(--smrt-color-success);
  }
  .smrt-tool-call-display__header {
    border: none;
    background: var(--smrt-color-surface-container-low);
    text-align: left;
    color: var(--smrt-color-on-surface);
    font: inherit;
    transition: background var(--smrt-duration-short2, 150ms);
  }
  .smrt-tool-call-display__header:hover {
    background: var(--smrt-color-surface-container);
  }
  .smrt-tool-call-display__header:focus-visible {
    outline: 2px solid var(--smrt-color-primary);
    outline-offset: -2px;
  }
  .smrt-tool-call-display__status-dot {
    border-radius: var(--smrt-radius-full);
  }
  .smrt-tool-call-display__root--pending .smrt-tool-call-display__status-dot {
    background: var(--smrt-color-outline);
  }
  .smrt-tool-call-display__root--running .smrt-tool-call-display__status-dot {
    background: var(--smrt-color-primary);
    animation: pulse 1.5s ease-in-out infinite;
  }
  .smrt-tool-call-display__root--success .smrt-tool-call-display__status-dot {
    background: var(--smrt-color-success);
  }
  .smrt-tool-call-display__root--error .smrt-tool-call-display__status-dot {
    background: var(--smrt-color-error);
  }
  .smrt-tool-call-display__root--awaiting-confirmation .smrt-tool-call-display__status-dot {
    background: var(--smrt-color-tertiary);
  }
  .smrt-tool-call-display__root--applied .smrt-tool-call-display__status-dot {
    background: var(--smrt-color-success);
  }
  .smrt-tool-call-display__applied-fallback {
    font: var(--smrt-typography-body-small-font, 0.8125rem/1.4 sans-serif);
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-tool-call-display__name {
    font: var(--smrt-typography-label-large-font, 500 0.875rem/1.25 sans-serif);
    font-family: var(--smrt-font-family-mono, 'SF Mono', 'Fira Code', 'Cascadia Code', monospace);
  }
  .smrt-tool-call-display__duration {
    font: var(--smrt-typography-label-small-font, 500 0.6875rem/1 sans-serif);
    color: var(--smrt-color-outline);
  }
  .smrt-tool-call-display__status-label {
    font: var(--smrt-typography-label-small-font, 500 0.6875rem/1 sans-serif);
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-tool-call-display__chevron {
    color: var(--smrt-color-on-surface-variant);
    transition: transform var(--smrt-duration-short2, 150ms);
  }
  .smrt-tool-call-display__chevron--open {
    transform: rotate(180deg);
  }
  .smrt-tool-call-display__body {
    border-top: var(--smrt-hairline);
    background: var(--smrt-color-surface);
  }
  .smrt-tool-call-display__section-label {
    font: var(--smrt-typography-label-small-font, 500 0.6875rem/1 sans-serif);
    color: var(--smrt-color-on-surface-variant);
    text-transform: uppercase;
    letter-spacing: var(--smrt-typography-label-small-tracking);
  }
  .smrt-tool-call-display__json {
    border-radius: var(--smrt-radius-small);
    background: var(--smrt-color-surface-container-low);
    color: var(--smrt-color-on-surface);
    font-family: var(--smrt-font-family-mono, 'SF Mono', 'Fira Code', 'Cascadia Code', monospace);
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
    line-height: var(--smrt-typography-body-small-line-height, 1.5);
  }
  .smrt-tool-call-display__json--result {
    background: var(--smrt-color-success-container);
    color: var(--smrt-color-on-success-container);
  }
  .smrt-tool-call-display__json--error {
    background: var(--smrt-color-error-container);
    color: var(--smrt-color-on-error-container);
  }
  .smrt-tool-call-display__running {
    font: var(--smrt-typography-body-small-font, 0.8125rem/1.4 sans-serif);
    color: var(--smrt-color-primary);
  }
  .smrt-tool-call-display__spinner {
    border: 2px solid var(--smrt-color-primary-container);
    border-top-color: var(--smrt-color-primary);
    border-radius: var(--smrt-radius-full);
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  @keyframes pulse {
    0%, 100% {
      opacity: 1;
    }
    50% {
      opacity: 0.4;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .smrt-tool-call-display__chevron,
    .smrt-tool-call-display__header {
      transition: none;
    }
    .smrt-tool-call-display__spinner {
      animation: none;
      border-top-color: var(--smrt-color-primary);
    }
    .smrt-tool-call-display__root--running .smrt-tool-call-display__status-dot {
      animation: none;
    }
  }
}

</style>
