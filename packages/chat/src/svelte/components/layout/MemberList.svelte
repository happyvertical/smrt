<script lang="ts">
/**
 * MemberList - Room member sidebar panel
 * Lists participants grouped by online status with role badges
 */
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
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
    // "online" reconciled to the success token (was --smrt-color-tertiary)
    // so it matches UserPresence and stays semantically green (T2 #1391).
    case 'online':
      return 'var(--smrt-color-success)';
    case 'away':
      return 'var(--smrt-color-warning)';
    case 'dnd':
      return 'var(--smrt-color-error)';
    default:
      return 'var(--smrt-color-outline)';
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

<aside class="smrt-member-list__root" aria-label={t(M['chat.member_list.room_members'])} data-smrt-component="MemberList">
  <div class="smrt-member-list__header" data-smrt-part="header">
    <h2 class="smrt-member-list__title" data-smrt-part="title">Members</h2>
    <span class="smrt-member-list__count" data-smrt-part="count">{participants.length}</span>
    <Button
      variant="ghost"
      size="sm"
      type="button"
      onclick={onclose}
      aria-label={t(M['chat.member_list.close'])}
    >
      <svg class="smrt-member-list__close-icon" data-smrt-part="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M18 6 6 18" />
        <path d="m6 6 12 12" />
      </svg>
    </Button>
  </div>

  <div class="smrt-member-list__content" data-smrt-part="body">
    {#if onlineMembers.length > 0}
      <section class="smrt-member-list__group" data-smrt-part="group">
        <h3 class="smrt-member-list__group-header" data-smrt-part="group-title">
          Online
          <span class="smrt-member-list__group-count" data-smrt-part="group-count">{onlineMembers.length}</span>
        </h3>
        <ul class="smrt-member-list__group-list" data-smrt-part="list" role="list">
          {#each onlineMembers as member (member.id)}
            <li class="smrt-member-list__item" data-smrt-part="row">
              <div class="smrt-member-list__avatar" data-smrt-part="avatar">
                {#if member.avatarUrl}
                  <img class="smrt-member-list__avatar-image" data-smrt-part="avatar-image" src={member.avatarUrl} alt="" />
                {:else}
                  <span class="smrt-member-list__avatar-placeholder" data-smrt-part="avatar-image">
                    {(member.nickname || member.name).charAt(0).toUpperCase()}
                  </span>
                {/if}
                <span
                  class="smrt-member-list__indicator"
                  data-smrt-part="indicator"
                  style:background={getStatusColor(member.onlineStatus)}
                  aria-label={getStatusLabel(member.onlineStatus)}
                ></span>
              </div>
              <span class="smrt-member-list__info" data-smrt-part="info">
                <span class="smrt-member-list__name" data-smrt-part="label">{member.nickname || member.name}</span>
                {#if getRoleBadgeLabel(member.role)}
                  <span class="smrt-member-list__badge smrt-member-list__badge--{member.role}" data-smrt-part="badge">
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
      <section class="smrt-member-list__group" data-smrt-part="group">
        <h3 class="smrt-member-list__group-header" data-smrt-part="group-title">
          Away
          <span class="smrt-member-list__group-count" data-smrt-part="group-count">{awayMembers.length}</span>
        </h3>
        <ul class="smrt-member-list__group-list" data-smrt-part="list" role="list">
          {#each awayMembers as member (member.id)}
            <li class="smrt-member-list__item" data-smrt-part="row">
              <div class="smrt-member-list__avatar" data-smrt-part="avatar">
                {#if member.avatarUrl}
                  <img class="smrt-member-list__avatar-image" data-smrt-part="avatar-image" src={member.avatarUrl} alt="" />
                {:else}
                  <span class="smrt-member-list__avatar-placeholder" data-smrt-part="avatar-image">
                    {(member.nickname || member.name).charAt(0).toUpperCase()}
                  </span>
                {/if}
                <span
                  class="smrt-member-list__indicator"
                  data-smrt-part="indicator"
                  style:background={getStatusColor(member.onlineStatus)}
                  aria-label={getStatusLabel(member.onlineStatus)}
                ></span>
              </div>
              <span class="smrt-member-list__info" data-smrt-part="info">
                <span class="smrt-member-list__name" data-smrt-part="label">{member.nickname || member.name}</span>
                {#if getRoleBadgeLabel(member.role)}
                  <span class="smrt-member-list__badge smrt-member-list__badge--{member.role}" data-smrt-part="badge">
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
      <section class="smrt-member-list__group" data-smrt-part="group">
        <h3 class="smrt-member-list__group-header" data-smrt-part="group-title">
          Offline
          <span class="smrt-member-list__group-count" data-smrt-part="group-count">{offlineMembers.length}</span>
        </h3>
        <ul class="smrt-member-list__group-list" data-smrt-part="list" role="list">
          {#each offlineMembers as member (member.id)}
            <li class="smrt-member-list__item smrt-member-list__item--offline" data-smrt-part="row">
              <div class="smrt-member-list__avatar" data-smrt-part="avatar">
                {#if member.avatarUrl}
                  <img class="smrt-member-list__avatar-image" data-smrt-part="avatar-image" src={member.avatarUrl} alt="" />
                {:else}
                  <span class="smrt-member-list__avatar-placeholder" data-smrt-part="avatar-image">
                    {(member.nickname || member.name).charAt(0).toUpperCase()}
                  </span>
                {/if}
                <span
                  class="smrt-member-list__indicator"
                  data-smrt-part="indicator"
                  style:background={getStatusColor(member.onlineStatus)}
                  aria-label={getStatusLabel(member.onlineStatus)}
                ></span>
              </div>
              <span class="smrt-member-list__info" data-smrt-part="info">
                <span class="smrt-member-list__name" data-smrt-part="label">{member.nickname || member.name}</span>
                {#if getRoleBadgeLabel(member.role)}
                  <span class="smrt-member-list__badge smrt-member-list__badge--{member.role}" data-smrt-part="badge">
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
      <p class="smrt-member-list__empty" data-smrt-part="empty">{t(M['chat.member_list.empty'])}</p>
    {/if}
  </div>
</aside>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-member-list__root {
    display: flex;
    flex-direction: column;
    width: 240px;
    height: 100%;
    overflow: hidden;
  }
  .smrt-member-list__header {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.75rem 1rem;
  }
  .smrt-member-list__title {
    margin: 0;
  }
  /* :global() pierces into the Button child's rendered <button> (see #1589). */
  .smrt-member-list__header :global([data-smrt-component="Button"]) {
    margin-left: auto;
    width: 1.75rem;
    height: 1.75rem;
    padding: 0;
  }
  .smrt-member-list__close-icon {
    width: 1rem;
    height: 1rem;
  }
  .smrt-member-list__content {
    flex: 1;
    overflow-y: auto;
    padding: 0.5rem 0;
  }
  .smrt-member-list__group {
    margin-bottom: 0.5rem;
  }
  .smrt-member-list__group-header {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    margin: 0;
    padding: 0.375rem 1rem;
  }
  .smrt-member-list__group-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .smrt-member-list__item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.375rem 1rem;
    cursor: default;
  }
  .smrt-member-list__avatar {
    position: relative;
    flex-shrink: 0;
  }
  .smrt-member-list__avatar-image {
    width: 2rem;
    height: 2rem;
    object-fit: cover;
  }
  .smrt-member-list__avatar-placeholder {
    width: 2rem;
    height: 2rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .smrt-member-list__indicator {
    position: absolute;
    bottom: 0;
    right: 0;
    width: 0.625rem;
    height: 0.625rem;
  }
  .smrt-member-list__info {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 0.375rem;
  }
  .smrt-member-list__name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .smrt-member-list__badge {
    flex-shrink: 0;
    padding: 0.0625rem 0.375rem;
  }
  .smrt-member-list__empty {
    padding: 2rem 1rem;
    margin: 0;
  }
}

@layer smrt.theme {
  .smrt-member-list__root {
    background: var(--smrt-color-surface-container);
    border-left: var(--smrt-hairline);
  }
  .smrt-member-list__header {
    border-bottom: var(--smrt-hairline);
  }
  .smrt-member-list__title {
    font: var(--smrt-typography-title-small-font, 600 0.875rem / 1.25 sans-serif);
    color: var(--smrt-color-on-surface);
  }
  .smrt-member-list__count {
    font: var(--smrt-typography-label-small-font, 500 0.6875rem / 1 sans-serif);
    color: var(--smrt-color-on-surface-variant);
  }
  /* :global() pierces into the Button child's rendered <button> (see #1589). */
  .smrt-member-list__header :global([data-smrt-component="Button"]) {
    background: none;
    border-radius: var(--smrt-radius-medium, 0.5rem);
    color: var(--smrt-color-on-surface-variant);
    transition: background var(--smrt-duration-short2, 150ms);
  }
  .smrt-member-list__header :global([data-smrt-component="Button"]:hover) {
    background: var(--smrt-color-surface-variant);
  }
  .smrt-member-list__group-header {
    font: var(--smrt-typography-label-small-font, 500 0.6875rem / 1 sans-serif);
    color: var(--smrt-color-on-surface-variant);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .smrt-member-list__group-count {
    color: var(--smrt-color-outline);
  }
  .smrt-member-list__item--offline {
    opacity: 0.5;
  }
  .smrt-member-list__avatar-image {
    border-radius: var(--smrt-radius-full);
  }
  .smrt-member-list__avatar-placeholder {
    border-radius: var(--smrt-radius-full);
    background: var(--smrt-color-primary-container);
    color: var(--smrt-color-on-primary-container);
    font: var(--smrt-typography-label-medium-font, 500 0.75rem / 1 sans-serif);
  }
  .smrt-member-list__indicator {
    border-radius: var(--smrt-radius-full);
    border: 2px solid var(--smrt-color-surface-container);
  }
  .smrt-member-list__name {
    font: var(--smrt-typography-body-medium-font, 0.875rem / 1.25 sans-serif);
    color: var(--smrt-color-on-surface);
  }
  .smrt-member-list__badge {
    border-radius: var(--smrt-radius-full);
    font: var(--smrt-typography-label-small-font, 500 0.6875rem / 1 sans-serif);
  }
  .smrt-member-list__badge--owner {
    background: var(--smrt-color-tertiary-container);
    color: var(--smrt-color-on-tertiary-container);
  }
  .smrt-member-list__badge--admin {
    background: var(--smrt-color-secondary-container);
    color: var(--smrt-color-on-secondary-container);
  }
  .smrt-member-list__empty {
    text-align: center;
    color: var(--smrt-color-on-surface-variant);
    font: var(--smrt-typography-body-medium-font, 0.875rem / 1.25 sans-serif);
  }
  @media (prefers-reduced-motion: reduce) {
    .smrt-member-list__header :global([data-smrt-component="Button"]) {
      transition: none;
    }
  }
}

</style>
