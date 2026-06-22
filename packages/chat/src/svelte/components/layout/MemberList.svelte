<script lang="ts">
/**
 * MemberList - Room member sidebar panel
 * Lists participants grouped by online status with role badges
 */
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { M } from '../../i18n.messages.js';
import type { ChatParticipantData } from '../../types.js';

const { t } = useI18n();

export interface Props {
  /** Room participants */
  participants: ChatParticipantData[];
  /** Callback to close the member panel */
  onclose: () => void;
}

let { participants, onclose }: Props = $props();

const onlineMembers = $derived(
  participants.filter((p) => p.onlineStatus === 'online'),
);
const awayMembers = $derived(
  participants.filter(
    (p) => p.onlineStatus === 'away' || p.onlineStatus === 'dnd',
  ),
);
const offlineMembers = $derived(
  participants.filter((p) => p.onlineStatus === 'offline'),
);

function getStatusColor(status: string): string {
  switch (status) {
    case 'online':
      return 'var(--smrt-color-tertiary, #006c4f)';
    case 'away':
      return 'var(--smrt-color-warning, #f0a000)';
    case 'dnd':
      return 'var(--smrt-color-error, #ba1a1a)';
    default:
      return 'var(--smrt-color-outline, #74777f)';
  }
}

function getStatusLabel(status: string): string {
  switch (status) {
    case 'online':
      return 'Online';
    case 'away':
      return 'Away';
    case 'dnd':
      return 'Do not disturb';
    default:
      return 'Offline';
  }
}

function getRoleBadgeLabel(role: string): string {
  switch (role) {
    case 'owner':
      return 'Owner';
    case 'admin':
      return 'Admin';
    default:
      return '';
  }
}
</script>

<aside class="member-list" aria-label={t(M['chat.member_list.room_members'])}>
  <div class="member-list__header">
    <h2 class="member-list__title">Members</h2>
    <span class="member-list__count">{participants.length}</span>
    <button
      class="close-btn"
      type="button"
      onclick={onclose}
      aria-label={t(M['chat.member_list.close'])}
    >
      <svg class="close-btn__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M18 6 6 18" />
        <path d="m6 6 12 12" />
      </svg>
    </button>
  </div>

  <div class="member-list__content">
    {#if onlineMembers.length > 0}
      <section class="member-group">
        <h3 class="member-group__header">
          Online
          <span class="member-group__count">{onlineMembers.length}</span>
        </h3>
        <ul class="member-group__list" role="list">
          {#each onlineMembers as member (member.id)}
            <li class="member-item">
              <div class="member-item__avatar-wrap">
                {#if member.avatarUrl}
                  <img class="member-item__avatar" src={member.avatarUrl} alt="" />
                {:else}
                  <span class="member-item__avatar-placeholder">
                    {(member.nickname || member.name).charAt(0).toUpperCase()}
                  </span>
                {/if}
                <span
                  class="member-item__status-dot"
                  style:background={getStatusColor(member.onlineStatus)}
                  aria-label={getStatusLabel(member.onlineStatus)}
                ></span>
              </div>
              <span class="member-item__info">
                <span class="member-item__name">{member.nickname || member.name}</span>
                {#if getRoleBadgeLabel(member.role)}
                  <span class="role-badge role-badge--{member.role}">
                    {getRoleBadgeLabel(member.role)}
                  </span>
                {/if}
              </span>
            </li>
          {/each}
        </ul>
      </section>
    {/if}

    {#if awayMembers.length > 0}
      <section class="member-group">
        <h3 class="member-group__header">
          Away
          <span class="member-group__count">{awayMembers.length}</span>
        </h3>
        <ul class="member-group__list" role="list">
          {#each awayMembers as member (member.id)}
            <li class="member-item">
              <div class="member-item__avatar-wrap">
                {#if member.avatarUrl}
                  <img class="member-item__avatar" src={member.avatarUrl} alt="" />
                {:else}
                  <span class="member-item__avatar-placeholder">
                    {(member.nickname || member.name).charAt(0).toUpperCase()}
                  </span>
                {/if}
                <span
                  class="member-item__status-dot"
                  style:background={getStatusColor(member.onlineStatus)}
                  aria-label={getStatusLabel(member.onlineStatus)}
                ></span>
              </div>
              <span class="member-item__info">
                <span class="member-item__name">{member.nickname || member.name}</span>
                {#if getRoleBadgeLabel(member.role)}
                  <span class="role-badge role-badge--{member.role}">
                    {getRoleBadgeLabel(member.role)}
                  </span>
                {/if}
              </span>
            </li>
          {/each}
        </ul>
      </section>
    {/if}

    {#if offlineMembers.length > 0}
      <section class="member-group">
        <h3 class="member-group__header">
          Offline
          <span class="member-group__count">{offlineMembers.length}</span>
        </h3>
        <ul class="member-group__list" role="list">
          {#each offlineMembers as member (member.id)}
            <li class="member-item member-item--offline">
              <div class="member-item__avatar-wrap">
                {#if member.avatarUrl}
                  <img class="member-item__avatar" src={member.avatarUrl} alt="" />
                {:else}
                  <span class="member-item__avatar-placeholder">
                    {(member.nickname || member.name).charAt(0).toUpperCase()}
                  </span>
                {/if}
                <span
                  class="member-item__status-dot"
                  style:background={getStatusColor(member.onlineStatus)}
                  aria-label={getStatusLabel(member.onlineStatus)}
                ></span>
              </div>
              <span class="member-item__info">
                <span class="member-item__name">{member.nickname || member.name}</span>
                {#if getRoleBadgeLabel(member.role)}
                  <span class="role-badge role-badge--{member.role}">
                    {getRoleBadgeLabel(member.role)}
                  </span>
                {/if}
              </span>
            </li>
          {/each}
        </ul>
      </section>
    {/if}

    {#if participants.length === 0}
      <p class="member-list__empty">{t(M['chat.member_list.empty'])}</p>
    {/if}
  </div>
</aside>

<style>
  .member-list {
    display: flex;
    flex-direction: column;
    width: 240px;
    height: 100%;
    background: var(--smrt-color-surface-container, #f0f0f4);
    border-left: 1px solid var(--smrt-color-outline-variant, #c4c6d0);
    overflow: hidden;
  }

  .member-list__header {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.75rem 1rem;
    border-bottom: 1px solid var(--smrt-color-outline-variant, #c4c6d0);
  }

  .member-list__title {
    margin: 0;
    font: var(--smrt-typography-title-small-font, 600 0.875rem / 1.25 sans-serif);
    color: var(--smrt-color-on-surface, #1a1c1e);
  }

  .member-list__count {
    font: var(--smrt-typography-label-small-font, 500 0.6875rem / 1 sans-serif);
    color: var(--smrt-color-on-surface-variant, #43474e);
  }

  .close-btn {
    margin-left: auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.75rem;
    height: 1.75rem;
    border: none;
    background: none;
    border-radius: var(--smrt-radius-medium, 0.5rem);
    color: var(--smrt-color-on-surface-variant, #43474e);
    cursor: pointer;
    transition: background var(--smrt-duration-short2, 150ms);
  }

  .close-btn:hover {
    background: var(--smrt-color-surface-variant, #e1e2ec);
  }

  .close-btn:focus-visible {
    outline: 2px solid var(--smrt-color-primary, #005ac1);
    outline-offset: -2px;
  }

  .close-btn__icon {
    width: 1rem;
    height: 1rem;
  }

  .member-list__content {
    flex: 1;
    overflow-y: auto;
    padding: 0.5rem 0;
  }

  .member-group {
    margin-bottom: 0.5rem;
  }

  .member-group__header {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    margin: 0;
    padding: 0.375rem 1rem;
    font: var(--smrt-typography-label-small-font, 500 0.6875rem / 1 sans-serif);
    color: var(--smrt-color-on-surface-variant, #43474e);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .member-group__count {
    color: var(--smrt-color-outline, #74777f);
  }

  .member-group__list {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .member-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.375rem 1rem;
    cursor: default;
  }

  .member-item--offline {
    opacity: 0.5;
  }

  .member-item__avatar-wrap {
    position: relative;
    flex-shrink: 0;
  }

  .member-item__avatar {
    width: 2rem;
    height: 2rem;
    border-radius: var(--smrt-radius-full, 9999px);
    object-fit: cover;
  }

  .member-item__avatar-placeholder {
    width: 2rem;
    height: 2rem;
    border-radius: var(--smrt-radius-full, 9999px);
    background: var(--smrt-color-primary-container, #d6e3ff);
    color: var(--smrt-color-on-primary-container, #001a41);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font: var(--smrt-typography-label-medium-font, 500 0.75rem / 1 sans-serif);
  }

  .member-item__status-dot {
    position: absolute;
    bottom: 0;
    right: 0;
    width: 0.625rem;
    height: 0.625rem;
    border-radius: var(--smrt-radius-full, 9999px);
    border: 2px solid var(--smrt-color-surface-container, #f0f0f4);
  }

  .member-item__info {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 0.375rem;
  }

  .member-item__name {
    font: var(--smrt-typography-body-medium-font, 0.875rem / 1.25 sans-serif);
    color: var(--smrt-color-on-surface, #1a1c1e);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .role-badge {
    flex-shrink: 0;
    padding: 0.0625rem 0.375rem;
    border-radius: var(--smrt-radius-full, 9999px);
    font: var(--smrt-typography-label-small-font, 500 0.6875rem / 1 sans-serif);
  }

  .role-badge--owner {
    background: var(--smrt-color-tertiary-container, #c2f0dd);
    color: var(--smrt-color-on-tertiary-container, #002114);
  }

  .role-badge--admin {
    background: var(--smrt-color-secondary-container, #d7e3f7);
    color: var(--smrt-color-on-secondary-container, #101c2b);
  }

  .member-list__empty {
    text-align: center;
    padding: 2rem 1rem;
    margin: 0;
    color: var(--smrt-color-on-surface-variant, #43474e);
    font: var(--smrt-typography-body-medium-font, 0.875rem / 1.25 sans-serif);
  }

  @media (prefers-reduced-motion: reduce) {
    .close-btn {
      transition: none;
    }
  }
</style>
