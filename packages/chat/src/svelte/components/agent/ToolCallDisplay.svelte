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

<div class="tool-call tool-call--{effectiveStatus}" aria-label={t(M['chat.tool_call_display.tool_call'], { toolName: toolCall.toolName })} data-smrt-component="ToolCallDisplay">
  <!-- raw-primitive-allow: full-width disclosure trigger with aria-expanded and aria-controls toggling an externally-rendered collapsible panel, wrapping rich content (status dot, name, duration, status label, rotating chevron); structural accordion header no Button primitive owns -->
  <button
    class="tool-call__header"
    type="button"
    onclick={() => userToggledExpanded = !isExpanded}
    aria-expanded={isExpanded}
    aria-controls="tool-call-body-{toolCall.toolCallId}"
  >
    <div class="tool-call__status-dot" aria-label="{statusLabel}"></div>

    <span class="tool-call__name">{toolCall.toolName}</span>

    <div class="tool-call__header-right">
      {#if toolCall.duration !== undefined}
        <span class="tool-call__duration">{formatDuration(toolCall.duration)}</span>
      {/if}
      <span class="tool-call__status-label">{statusLabel}</span>
      <svg
        class="tool-call__chevron"
        class:tool-call__chevron--open={isExpanded}
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="currentColor"
        aria-hidden="true"
      >
        <path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z" />
      </svg>
    </div>
  </button>

  {#if isExpanded}
    <div class="tool-call__body" id="tool-call-body-{toolCall.toolCallId}">
      {#if toolCall.arguments && Object.keys(toolCall.arguments).length > 0}
        <div class="tool-call__section">
          <span class="tool-call__section-label">Arguments</span>
          <pre class="tool-call__json">{formatJson(toolCall.arguments)}</pre>
        </div>
      {/if}

      {#if toolCall.status === 'success' && toolCall.result !== undefined}
        <div class="tool-call__section">
          <span class="tool-call__section-label">Result</span>
          <pre class="tool-call__json tool-call__json--result">{formatJson(toolCall.result)}</pre>
        </div>
      {/if}

      {#if toolCall.status === 'error' && toolCall.error}
        <div class="tool-call__section">
          <span class="tool-call__section-label">Error</span>
          <pre class="tool-call__json tool-call__json--error">{toolCall.error}</pre>
        </div>
      {/if}

      {#if toolCall.status === 'running'}
        <div class="tool-call__running">
          <div class="tool-call__spinner" aria-label={t(M['chat.tool_call_display.running'])}></div>
          <span>Executing...</span>
        </div>
      {/if}

      {#if actionResult}
        <div class="tool-call__section tool-call__data-surface-action" data-phase={actionResult.phase} data-ok={actionResult.ok}>
          <span class="tool-call__section-label">
            {actionResult.phase === 'preview' ? 'Proposed change' : 'Applied change'}
          </span>
          {#if actionResult.ok}
            {#if actionResult.details}
              <pre class="tool-call__json">{formatJson(actionResult.details)}</pre>
            {:else if actionResult.phase === 'apply'}
              <p class="tool-call__applied-fallback">
                {t(M['chat.tool_call_display.applied_successfully'])}
              </p>
            {/if}
            {#if actionResult.phase === 'preview'}
              <div class="tool-call__data-surface-action-buttons">
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
            <pre class="tool-call__json tool-call__json--error">{actionResult.reason ?? 'Action failed'}</pre>
          {/if}
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.theme {
  .tool-call {
    border: var(--smrt-hairline);
    border-radius: var(--smrt-radius-medium);
    overflow: hidden;
    font-family: var(--smrt-font-family, system-ui);
  }

  .tool-call--pending {
    border-left: 3px solid var(--smrt-color-outline);
  }

  .tool-call--running {
    border-left: 3px solid var(--smrt-color-primary);
  }

  .tool-call--success {
    border-left: 3px solid var(--smrt-color-success);
  }

  .tool-call--error {
    border-left: 3px solid var(--smrt-color-error);
  }

  .tool-call--awaiting-confirmation {
    border-left: 3px solid var(--smrt-color-tertiary);
  }

  .tool-call--applied {
    border-left: 3px solid var(--smrt-color-success);
  }

  .tool-call__header {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-2);
    width: 100%;
    padding: var(--smrt-spacing-2) var(--smrt-spacing-3);
    border: none;
    background: var(--smrt-color-surface-container-low);
    cursor: pointer;
    text-align: left;
    color: var(--smrt-color-on-surface);
    font: inherit;
    transition: background var(--smrt-duration-short2, 150ms);
  }

  .tool-call__header:hover {
    background: var(--smrt-color-surface-container);
  }

  .tool-call__header:focus-visible {
    outline: 2px solid var(--smrt-color-primary);
    outline-offset: -2px;
  }

  .tool-call__status-dot {
    width: 8px;
    height: 8px;
    border-radius: var(--smrt-radius-full);
    flex-shrink: 0;
  }

  .tool-call--pending .tool-call__status-dot {
    background: var(--smrt-color-outline);
  }

  .tool-call--running .tool-call__status-dot {
    background: var(--smrt-color-primary);
    animation: pulse 1.5s ease-in-out infinite;
  }

  .tool-call--success .tool-call__status-dot {
    background: var(--smrt-color-success);
  }

  .tool-call--error .tool-call__status-dot {
    background: var(--smrt-color-error);
  }

  .tool-call--awaiting-confirmation .tool-call__status-dot {
    background: var(--smrt-color-tertiary);
  }

  .tool-call--applied .tool-call__status-dot {
    background: var(--smrt-color-success);
  }

  .tool-call__applied-fallback {
    margin: 0;
    font: var(--smrt-typography-body-small-font, 0.8125rem/1.4 sans-serif);
    color: var(--smrt-color-on-surface-variant);
  }

  .tool-call__name {
    font: var(--smrt-typography-label-large-font, 500 0.875rem/1.25 sans-serif);
    font-family: var(--smrt-font-family-mono, 'SF Mono', 'Fira Code', 'Cascadia Code', monospace);
    flex: 1;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .tool-call__header-right {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-2);
    flex-shrink: 0;
  }

  .tool-call__duration {
    font: var(--smrt-typography-label-small-font, 500 0.6875rem/1 sans-serif);
    color: var(--smrt-color-outline);
  }

  .tool-call__status-label {
    font: var(--smrt-typography-label-small-font, 500 0.6875rem/1 sans-serif);
    color: var(--smrt-color-on-surface-variant);
  }

  .tool-call__chevron {
    color: var(--smrt-color-on-surface-variant);
    transition: transform var(--smrt-duration-short2, 150ms);
  }

  .tool-call__chevron--open {
    transform: rotate(180deg);
  }

  .tool-call__body {
    padding: var(--smrt-spacing-2) var(--smrt-spacing-3) var(--smrt-spacing-3);
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-2);
    border-top: var(--smrt-hairline);
    background: var(--smrt-color-surface);
  }

  .tool-call__section {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-1);
  }

  .tool-call__section-label {
    font: var(--smrt-typography-label-small-font, 500 0.6875rem/1 sans-serif);
    color: var(--smrt-color-on-surface-variant);
    text-transform: uppercase;
    letter-spacing: var(--smrt-typography-label-small-tracking);
  }

  .tool-call__json {
    margin: 0;
    padding: var(--smrt-spacing-2);
    border-radius: var(--smrt-radius-small);
    background: var(--smrt-color-surface-container-low);
    color: var(--smrt-color-on-surface);
    font-family: var(--smrt-font-family-mono, 'SF Mono', 'Fira Code', 'Cascadia Code', monospace);
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
    line-height: var(--smrt-typography-body-small-line-height, 1.5);
    overflow-x: auto;
    white-space: pre-wrap;
    word-break: break-all;
    max-height: 200px;
    overflow-y: auto;
  }

  .tool-call__json--result {
    background: var(--smrt-color-success-container);
    color: var(--smrt-color-on-success-container);
  }

  .tool-call__json--error {
    background: var(--smrt-color-error-container);
    color: var(--smrt-color-on-error-container);
  }

  .tool-call__running {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-2);
    padding: var(--smrt-spacing-2);
    font: var(--smrt-typography-body-small-font, 0.8125rem/1.4 sans-serif);
    color: var(--smrt-color-primary);
  }

  .tool-call__spinner {
    width: 16px;
    height: 16px;
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
    .tool-call__chevron,
    .tool-call__header {
      transition: none;
    }

    .tool-call__spinner {
      animation: none;
      border-top-color: var(--smrt-color-primary);
    }

    .tool-call--running .tool-call__status-dot {
      animation: none;
    }
  }
}
</style>
