<script lang="ts">
/**
 * AgentSessionPanel - Session management sidebar
 * Lists past agent sessions with status, message count, and allowed tools.
 * Allows selecting an existing session or creating a new one.
 */
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import { M } from '../../i18n.js';
import type { AgentSessionData } from '../../types.js';
import Avatar from '../shared/Avatar.svelte';

const { t } = useI18n();

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

<aside class="smrt-agent-session-panel__root" aria-label={t(M['chat.agent_session_panel.sessions'])} data-smrt-component="AgentSessionPanel">
  <div class="smrt-agent-session-panel__header" data-smrt-part="header">
    <h2 class="smrt-agent-session-panel__title" data-smrt-part="title">Sessions</h2>
    {#if onnewsession}
      <Button
        variant="ghost"
        type="button"
        onclick={onnewsession}
        aria-label={t(M['chat.agent_session_panel.new_session'])}
        title={t(M['chat.agent_session_panel.new_session'])}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z" />
        </svg>
      </Button>
    {/if}
  </div>

  <div class="smrt-agent-session-panel__list" data-smrt-part="list" role="listbox" aria-label={t(M['chat.agent_session_panel.session_list'])}>
    {#each sessions as session (session.id)}
      {@const isCurrent = session.id === currentSessionId}
      <!-- raw-primitive-allow: large pressable selection card with role=option wrapping rich content (avatar, name, date, status, message count, tool chips) inside a role=listbox; no Button primitive owns this structural listbox-option pattern -->
      <button
        class="smrt-agent-session-panel__item"
        data-smrt-part="option"
        type="button"
        role="option"
        aria-selected={isCurrent}
        onclick={() => onselectsession(session.id)}
  class:smrt-agent-session-panel__item--active={isCurrent}

      >
        <Avatar
          name={session.agentName}
          avatarUrl={session.agentAvatarUrl}
          size="sm"
        />

        <div class="smrt-agent-session-panel__item-body" data-smrt-part="body">
          <div class="smrt-agent-session-panel__item-header" data-smrt-part="heading">
            <span class="smrt-agent-session-panel__item-name" data-smrt-part="label">{session.agentName}</span>
            <time class="smrt-agent-session-panel__item-date" data-smrt-part="time">
              {formatDate(session.createdAt)}
            </time>
          </div>

          <div class="smrt-agent-session-panel__item-meta" data-smrt-part="meta">
            <span
              class="smrt-agent-session-panel__item-status"
              data-smrt-part="status"
            
  class:smrt-agent-session-panel__item-status--active={session.status === 'active'}
  class:smrt-agent-session-panel__item-status--closed={session.status === 'closed'}
  class:smrt-agent-session-panel__item-status--expired={session.status === 'expired'}
>
              {statusLabel[session.status] ?? session.status}
            </span>
            <span class="smrt-agent-session-panel__item-count" data-smrt-part="count">
              {session.messageCount} msg{session.messageCount !== 1 ? 's' : ''}
            </span>
          </div>

          {#if session.allowedTools.length > 0}
            <div class="smrt-agent-session-panel__item-tools" data-smrt-part="tools">
              {#each session.allowedTools.slice(0, 3) as tool}
                <span class="smrt-agent-session-panel__tool-chip" data-smrt-part="chip">{tool}</span>
              {/each}
              {#if session.allowedTools.length > 3}
                <span class="smrt-agent-session-panel__tool-chip smrt-agent-session-panel__tool-chip--more" data-smrt-part="chip">
                  +{session.allowedTools.length - 3}
                </span>
              {/if}
            </div>
          {/if}
        </div>
      </button>
    {/each}

    {#if sessions.length === 0}
      <div class="smrt-agent-session-panel__empty" data-smrt-part="empty">
        <span class="smrt-agent-session-panel__empty-text" data-smrt-part="message">{t(M['chat.agent_session_panel.empty'])}</span>
      </div>
    {/if}
  </div>
</aside>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-agent-session-panel__root {
    display: flex;
    flex-direction: column;
    height: 100%;
    width: 280px;
    overflow: hidden;
  }
  .smrt-agent-session-panel__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--smrt-spacing-4);
    flex-shrink: 0;
  }
  .smrt-agent-session-panel__title {
    margin: 0;
  }
  /* :global() pierces into the Button child's rendered <button> (see #1589). */
  .smrt-agent-session-panel__header :global([data-smrt-component="Button"]) {
    width: 36px;
    height: 36px;
    padding: 0;
  }
  .smrt-agent-session-panel__list {
    flex: 1;
    overflow-y: auto;
    padding: var(--smrt-spacing-2);
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-1);
  }
  .smrt-agent-session-panel__item {
    display: flex;
    align-items: flex-start;
    gap: var(--smrt-spacing-3);
    width: 100%;
    padding: var(--smrt-spacing-3);
    cursor: pointer;
  }
  .smrt-agent-session-panel__item-body {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-1);
    min-width: 0;
  }
  .smrt-agent-session-panel__item-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--smrt-spacing-2);
  }
  .smrt-agent-session-panel__item-name {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .smrt-agent-session-panel__item-date {
    flex-shrink: 0;
  }
  .smrt-agent-session-panel__item-meta {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-2);
  }
  .smrt-agent-session-panel__item-status {
    padding: var(--smrt-spacing-1) var(--smrt-spacing-2);
  }
  .smrt-agent-session-panel__item-tools {
    display: flex;
    flex-wrap: wrap;
    gap: var(--smrt-spacing-1);
    margin-top: var(--smrt-spacing-1);
  }
  .smrt-agent-session-panel__tool-chip {
    padding: var(--smrt-spacing-1) var(--smrt-spacing-2);
    white-space: nowrap;
  }
  .smrt-agent-session-panel__empty {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    min-height: 80px;
  }
}

@layer smrt.theme {
  .smrt-agent-session-panel__root {
    background: var(--smrt-color-surface-container);
    border-right: var(--smrt-hairline);
  }
  .smrt-agent-session-panel__header {
    border-bottom: var(--smrt-hairline);
  }
  .smrt-agent-session-panel__title {
    font: var(--smrt-typography-title-medium-font, 600 1rem/1.25 sans-serif);
    color: var(--smrt-color-on-surface);
  }
  /* :global() pierces into the Button child's rendered <button> (see #1589). */
  .smrt-agent-session-panel__header :global([data-smrt-component="Button"]) {
    background: var(--smrt-color-primary);
    color: var(--smrt-color-on-primary);
    border-radius: var(--smrt-radius-full);
    transition: opacity var(--smrt-duration-short2, 150ms);
  }
  .smrt-agent-session-panel__header :global([data-smrt-component="Button"]:hover) {
    background: var(--smrt-color-primary);
    opacity: 0.85;
  }
  .smrt-agent-session-panel__item {
    border: none;
    background: transparent;
    border-radius: var(--smrt-radius-medium);
    text-align: left;
    color: var(--smrt-color-on-surface);
    transition: background var(--smrt-duration-short2, 150ms);
  }
  .smrt-agent-session-panel__item:hover {
    background: var(--smrt-color-surface-container-high);
  }
  .smrt-agent-session-panel__item--active {
    background: var(--smrt-color-secondary-container);
  }
  .smrt-agent-session-panel__item--active:hover {
    background: var(--smrt-color-secondary-container);
  }
  .smrt-agent-session-panel__item:focus-visible {
    outline: 2px solid var(--smrt-color-primary);
    outline-offset: -2px;
  }
  .smrt-agent-session-panel__item-name {
    font: var(--smrt-typography-label-large-font, 500 0.875rem/1.25 sans-serif);
  }
  .smrt-agent-session-panel__item-date {
    font: var(--smrt-typography-label-small-font, 500 0.6875rem/1 sans-serif);
    color: var(--smrt-color-outline);
  }
  .smrt-agent-session-panel__item-status {
    font: var(--smrt-typography-label-small-font, 500 0.6875rem/1 sans-serif);
    border-radius: var(--smrt-radius-full);
    background: var(--smrt-color-surface-variant);
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-agent-session-panel__item-status--active {
    background: var(--smrt-color-success-container);
    color: var(--smrt-color-on-success-container);
  }
  .smrt-agent-session-panel__item-status--closed {
    background: var(--smrt-color-surface-variant);
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-agent-session-panel__item-status--expired {
    background: var(--smrt-color-error-container);
    color: var(--smrt-color-on-error-container);
  }
  .smrt-agent-session-panel__item-count {
    font: var(--smrt-typography-label-small-font, 500 0.6875rem/1 sans-serif);
    color: var(--smrt-color-outline);
  }
  .smrt-agent-session-panel__tool-chip {
    font-size: var(--smrt-typography-label-small-size, 0.625rem);
    font-weight: var(--smrt-typography-weight-medium, 500);
    border-radius: var(--smrt-radius-small);
    background: var(--smrt-color-surface-container-highest);
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-agent-session-panel__tool-chip--more {
    background: var(--smrt-color-primary-container);
    color: var(--smrt-color-on-primary-container);
  }
  .smrt-agent-session-panel__empty-text {
    font: var(--smrt-typography-body-small-font, 0.8125rem/1.4 sans-serif);
    color: var(--smrt-color-outline);
  }
  @media (prefers-reduced-motion: reduce) {
    .smrt-agent-session-panel__item {
      transition: none;
    }
    .smrt-agent-session-panel__header :global([data-smrt-component="Button"]) {
      transition: none;
    }
  }
}

</style>
