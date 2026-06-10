<script lang="ts">
/**
 * AgentSessionPanel - Session management sidebar
 * Lists past agent sessions with status, message count, and allowed tools.
 * Allows selecting an existing session or creating a new one.
 */
import type { AgentSessionData } from '../../types.js';
import Avatar from '../shared/Avatar.svelte';

export interface Props {
  /** Available sessions */
  sessions: AgentSessionData[];
  /** Currently active session ID */
  currentSessionId?: string;
  /** Select a session */
  onselectsession: (sessionId: string) => void;
  /** Create a new session */
  onnewsession?: () => void;
}

const { sessions, currentSessionId, onselectsession, onnewsession }: Props =
  $props();

function formatDate(date: string | Date): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  if (isToday) {
    return d.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
    });
  }
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

const statusLabel: Record<string, string> = {
  active: 'Active',
  closed: 'Closed',
  expired: 'Expired',
};
</script>

<aside class="session-panel" aria-label="Agent sessions">
  <div class="session-panel__header">
    <h2 class="session-panel__title">Sessions</h2>
    {#if onnewsession}
      <button
        class="session-panel__new-btn"
        type="button"
        onclick={onnewsession}
        aria-label="New session"
        title="New session"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z" />
        </svg>
      </button>
    {/if}
  </div>

  <div class="session-panel__list" role="listbox" aria-label="Session list">
    {#each sessions as session (session.id)}
      {@const isCurrent = session.id === currentSessionId}
      <button
        class="session-panel__item"
        class:session-panel__item--active={isCurrent}
        type="button"
        role="option"
        aria-selected={isCurrent}
        onclick={() => onselectsession(session.id)}
      >
        <Avatar
          name={session.agentName}
          avatarUrl={session.agentAvatarUrl}
          size="sm"
        />

        <div class="session-panel__item-body">
          <div class="session-panel__item-header">
            <span class="session-panel__item-name">{session.agentName}</span>
            <time class="session-panel__item-date">
              {formatDate(session.createdAt)}
            </time>
          </div>

          <div class="session-panel__item-meta">
            <span
              class="session-panel__item-status"
              class:session-panel__item-status--active={session.status === 'active'}
              class:session-panel__item-status--closed={session.status === 'closed'}
              class:session-panel__item-status--expired={session.status === 'expired'}
            >
              {statusLabel[session.status] ?? session.status}
            </span>
            <span class="session-panel__item-count">
              {session.messageCount} msg{session.messageCount !== 1 ? 's' : ''}
            </span>
          </div>

          {#if session.allowedTools.length > 0}
            <div class="session-panel__item-tools">
              {#each session.allowedTools.slice(0, 3) as tool}
                <span class="session-panel__tool-chip">{tool}</span>
              {/each}
              {#if session.allowedTools.length > 3}
                <span class="session-panel__tool-chip session-panel__tool-chip--more">
                  +{session.allowedTools.length - 3}
                </span>
              {/if}
            </div>
          {/if}
        </div>
      </button>
    {/each}

    {#if sessions.length === 0}
      <div class="session-panel__empty">
        <span class="session-panel__empty-text">No sessions yet</span>
      </div>
    {/if}
  </div>
</aside>

<style>
  .session-panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    width: 280px;
    background: var(--smrt-color-surface-container, #f0f0f4);
    border-right: 1px solid var(--smrt-color-outline-variant, #c4c6d0);
    overflow: hidden;
  }

  .session-panel__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--smrt-spacing-4, 16px);
    border-bottom: 1px solid var(--smrt-color-outline-variant, #c4c6d0);
    flex-shrink: 0;
  }

  .session-panel__title {
    font: var(--smrt-typography-title-medium-font, 600 1rem/1.25 sans-serif);
    color: var(--smrt-color-on-surface, #1a1c1e);
    margin: 0;
  }

  .session-panel__new-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    border: none;
    background: var(--smrt-color-primary, #005ac1);
    color: var(--smrt-color-on-primary, #ffffff);
    border-radius: var(--smrt-radius-full, 9999px);
    cursor: pointer;
    transition: opacity var(--smrt-duration-short2, 150ms);
  }

  .session-panel__new-btn:hover {
    opacity: 0.85;
  }

  .session-panel__new-btn:focus-visible {
    outline: 2px solid var(--smrt-color-primary, #005ac1);
    outline-offset: 2px;
  }

  .session-panel__list {
    flex: 1;
    overflow-y: auto;
    padding: var(--smrt-spacing-2, 8px);
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-1, 4px);
  }

  .session-panel__item {
    display: flex;
    align-items: flex-start;
    gap: var(--smrt-spacing-3, 12px);
    width: 100%;
    padding: var(--smrt-spacing-3, 12px);
    border: none;
    background: transparent;
    border-radius: var(--smrt-radius-medium, 8px);
    cursor: pointer;
    text-align: left;
    color: var(--smrt-color-on-surface, #1a1c1e);
    transition: background var(--smrt-duration-short2, 150ms);
  }

  .session-panel__item:hover {
    background: var(--smrt-color-surface-container-high, #e6e6ea);
  }

  .session-panel__item--active {
    background: var(--smrt-color-secondary-container, #d7e3f7);
  }

  .session-panel__item--active:hover {
    background: var(--smrt-color-secondary-container, #d7e3f7);
  }

  .session-panel__item:focus-visible {
    outline: 2px solid var(--smrt-color-primary, #005ac1);
    outline-offset: -2px;
  }

  .session-panel__item-body {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-1, 4px);
    min-width: 0;
  }

  .session-panel__item-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--smrt-spacing-2, 8px);
  }

  .session-panel__item-name {
    font: var(--smrt-typography-label-large-font, 500 0.875rem/1.25 sans-serif);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .session-panel__item-date {
    font: var(--smrt-typography-label-small-font, 500 0.6875rem/1 sans-serif);
    color: var(--smrt-color-outline, #74777f);
    flex-shrink: 0;
  }

  .session-panel__item-meta {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-2, 8px);
  }

  .session-panel__item-status {
    font: var(--smrt-typography-label-small-font, 500 0.6875rem/1 sans-serif);
    padding: var(--smrt-spacing-1, 4px) var(--smrt-spacing-2, 8px);
    border-radius: var(--smrt-radius-full, 9999px);
    background: var(--smrt-color-surface-variant, #e1e2ec);
    color: var(--smrt-color-on-surface-variant, #43474e);
  }

  .session-panel__item-status--active {
    background: var(--smrt-color-success-container, #e8f5e9);
    color: var(--smrt-color-on-success-container, #2e7d32);
  }

  .session-panel__item-status--closed {
    background: var(--smrt-color-surface-variant, #e1e2ec);
    color: var(--smrt-color-on-surface-variant, #43474e);
  }

  .session-panel__item-status--expired {
    background: var(--smrt-color-error-container, #ffdad6);
    color: var(--smrt-color-on-error-container, #410002);
  }

  .session-panel__item-count {
    font: var(--smrt-typography-label-small-font, 500 0.6875rem/1 sans-serif);
    color: var(--smrt-color-outline, #74777f);
  }

  .session-panel__item-tools {
    display: flex;
    flex-wrap: wrap;
    gap: var(--smrt-spacing-1, 4px);
    margin-top: var(--smrt-spacing-1, 4px);
  }

  .session-panel__tool-chip {
    font-size: var(--smrt-typography-label-small-size, 0.625rem);
    font-weight: var(--smrt-typography-weight-medium, 500);
    padding: var(--smrt-spacing-1, 4px) var(--smrt-spacing-2, 8px);
    border-radius: var(--smrt-radius-small, 4px);
    background: var(--smrt-color-surface-container-highest, #dddde1);
    color: var(--smrt-color-on-surface-variant, #43474e);
    white-space: nowrap;
  }

  .session-panel__tool-chip--more {
    background: var(--smrt-color-primary-container, #d6e3ff);
    color: var(--smrt-color-on-primary-container, #001a41);
  }

  .session-panel__empty {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    min-height: 80px;
  }

  .session-panel__empty-text {
    font: var(--smrt-typography-body-small-font, 0.8125rem/1.4 sans-serif);
    color: var(--smrt-color-outline, #74777f);
  }

  @media (prefers-reduced-motion: reduce) {
    .session-panel__item,
    .session-panel__new-btn {
      transition: none;
    }
  }
</style>
