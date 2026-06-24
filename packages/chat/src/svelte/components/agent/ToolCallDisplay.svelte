<script lang="ts">
/**
 * ToolCallDisplay - Inline tool call/result display
 * Collapsible card showing tool name, arguments (as JSON), status indicator,
 * and result/error. Color-coded by status (pending, running, success, error).
 */
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { M } from '../../i18n.js';
import type { ToolCallDisplayData } from '../../types.js';

export interface Props {
  /** Tool call data */
  toolCall: ToolCallDisplayData;
}

const { toolCall }: Props = $props();

const { t } = useI18n();

let isExpanded = $state(false);

const statusLabel = $derived.by(() => {
  switch (toolCall.status) {
    case 'pending':
      return 'Pending';
    case 'running':
      return 'Running';
    case 'success':
      return 'Completed';
    case 'error':
      return 'Error';
    default:
      return toolCall.status;
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

<div class="tool-call tool-call--{toolCall.status}" aria-label={t(M['chat.tool_call_display.tool_call'], { toolName: toolCall.toolName })}>
  <!-- raw-primitive-allow: full-width disclosure trigger with aria-expanded and aria-controls toggling an externally-rendered collapsible panel, wrapping rich content (status dot, name, duration, status label, rotating chevron); structural accordion header no Button primitive owns -->
  <button
    class="tool-call__header"
    type="button"
    onclick={() => isExpanded = !isExpanded}
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
    </div>
  {/if}
</div>

<style>
  .tool-call {
    border: 1px solid var(--smrt-color-outline-variant, #c4c6d0);
    border-radius: var(--smrt-radius-medium, 8px);
    overflow: hidden;
    font-family: var(--smrt-font-family, system-ui);
  }

  .tool-call--pending {
    border-left: 3px solid var(--smrt-color-outline, #74777f);
  }

  .tool-call--running {
    border-left: 3px solid var(--smrt-color-primary, #005ac1);
  }

  .tool-call--success {
    border-left: 3px solid var(--smrt-color-success, #1e8e3e);
  }

  .tool-call--error {
    border-left: 3px solid var(--smrt-color-error, #b3261e);
  }

  .tool-call__header {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-2, 8px);
    width: 100%;
    padding: var(--smrt-spacing-2, 8px) var(--smrt-spacing-3, 12px);
    border: none;
    background: var(--smrt-color-surface-container-low, #f7f7fb);
    cursor: pointer;
    text-align: left;
    color: var(--smrt-color-on-surface, #1a1c1e);
    font: inherit;
    transition: background var(--smrt-duration-short2, 150ms);
  }

  .tool-call__header:hover {
    background: var(--smrt-color-surface-container, #f0f0f4);
  }

  .tool-call__header:focus-visible {
    outline: 2px solid var(--smrt-color-primary, #005ac1);
    outline-offset: -2px;
  }

  .tool-call__status-dot {
    width: 8px;
    height: 8px;
    border-radius: var(--smrt-radius-full, 9999px);
    flex-shrink: 0;
  }

  .tool-call--pending .tool-call__status-dot {
    background: var(--smrt-color-outline, #74777f);
  }

  .tool-call--running .tool-call__status-dot {
    background: var(--smrt-color-primary, #005ac1);
    animation: pulse 1.5s ease-in-out infinite;
  }

  .tool-call--success .tool-call__status-dot {
    background: var(--smrt-color-success, #1e8e3e);
  }

  .tool-call--error .tool-call__status-dot {
    background: var(--smrt-color-error, #b3261e);
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
    gap: var(--smrt-spacing-2, 8px);
    flex-shrink: 0;
  }

  .tool-call__duration {
    font: var(--smrt-typography-label-small-font, 500 0.6875rem/1 sans-serif);
    color: var(--smrt-color-outline, #74777f);
  }

  .tool-call__status-label {
    font: var(--smrt-typography-label-small-font, 500 0.6875rem/1 sans-serif);
    color: var(--smrt-color-on-surface-variant, #43474e);
  }

  .tool-call__chevron {
    color: var(--smrt-color-on-surface-variant, #43474e);
    transition: transform var(--smrt-duration-short2, 150ms);
  }

  .tool-call__chevron--open {
    transform: rotate(180deg);
  }

  .tool-call__body {
    padding: var(--smrt-spacing-2, 8px) var(--smrt-spacing-3, 12px) var(--smrt-spacing-3, 12px);
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-2, 8px);
    border-top: 1px solid var(--smrt-color-outline-variant, #c4c6d0);
    background: var(--smrt-color-surface, #fefbff);
  }

  .tool-call__section {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-1, 4px);
  }

  .tool-call__section-label {
    font: var(--smrt-typography-label-small-font, 500 0.6875rem/1 sans-serif);
    color: var(--smrt-color-on-surface-variant, #43474e);
    text-transform: uppercase;
    letter-spacing: var(--smrt-typography-label-small-tracking, 0.5px);
  }

  .tool-call__json {
    margin: 0;
    padding: var(--smrt-spacing-2, 8px);
    border-radius: var(--smrt-radius-small, 4px);
    background: var(--smrt-color-surface-container-low, #f7f7fb);
    color: var(--smrt-color-on-surface, #1a1c1e);
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
    background: var(--smrt-color-success-container, #f1f8e9);
    color: var(--smrt-color-on-success-container, #33691e);
  }

  .tool-call__json--error {
    background: var(--smrt-color-error-container, #ffdad6);
    color: var(--smrt-color-on-error-container, #410002);
  }

  .tool-call__running {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-2, 8px);
    padding: var(--smrt-spacing-2, 8px);
    font: var(--smrt-typography-body-small-font, 0.8125rem/1.4 sans-serif);
    color: var(--smrt-color-primary, #005ac1);
  }

  .tool-call__spinner {
    width: 16px;
    height: 16px;
    border: 2px solid var(--smrt-color-primary-container, #d6e3ff);
    border-top-color: var(--smrt-color-primary, #005ac1);
    border-radius: var(--smrt-radius-full, 9999px);
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
      border-top-color: var(--smrt-color-primary, #005ac1);
    }

    .tool-call--running .tool-call__status-dot {
      animation: none;
    }
  }
</style>
