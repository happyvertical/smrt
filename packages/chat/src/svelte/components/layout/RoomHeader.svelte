<script lang="ts">
/**
 * RoomHeader - Room header bar with name, topic, and action buttons
 * Displays room info and provides access to members and search
 */
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import { M } from '../../i18n.messages.js';
import type { ChatRoomData } from '../../types.js';

const { t } = useI18n();

export interface Props {
  /** Current room data */
  room: ChatRoomData;
  /** Number of participants in the room */
  participantCount: number;
  /** Callback to show member list panel */
  onshowmembers?: () => void;
  /** Callback to show message search */
  onshowsearch?: () => void;
}

let { room, participantCount, onshowmembers, onshowsearch }: Props = $props();

const roomIcon = $derived.by(() => {
  switch (room.roomType) {
    case 'public':
      return '#';
    case 'private':
      return '\u{1F512}';
    case 'dm':
      return '';
    case 'agent':
      return '\u{2699}';
    default:
      return '#';
  }
});

const roomTypeLabel = $derived.by(() => {
  switch (room.roomType) {
    case 'public':
      return 'Public channel';
    case 'private':
      return 'Private channel';
    case 'dm':
      return 'Direct message';
    case 'agent':
      return 'Agent conversation';
    default:
      return 'Channel';
  }
});
</script>

<header class="smrt-room-header__root" aria-label={t(M['chat.room_header.room_label'], { name: room.name })} data-smrt-component="RoomHeader">
  <div class="smrt-room-header__info" data-smrt-part="meta">
    <div class="smrt-room-header__title" data-smrt-part="title">
      {#if room.roomType !== 'dm'}
        <span class="smrt-room-header__icon" data-smrt-part="icon" aria-hidden="true">{roomIcon}</span>
      {:else if room.avatarUrl}
        <img class="smrt-room-header__avatar" data-smrt-part="media" src={room.avatarUrl} alt="" />
      {:else}
        <span class="smrt-room-header__avatar-placeholder" data-smrt-part="icon">
          {room.name.charAt(0).toUpperCase()}
        </span>
      {/if}
      <h1 class="smrt-room-header__heading" data-smrt-part="title">{room.name}</h1>
      <span class="smrt-room-header__badge" data-smrt-part="badge">{roomTypeLabel}</span>
    </div>

    {#if room.topic}
      <p class="smrt-room-header__meta" data-smrt-part="meta" title={room.topic}>
        {room.topic}
      </p>
    {/if}
  </div>

  <div class="smrt-room-header__actions" data-smrt-part="actions">
    {#if onshowmembers}
      <Button
        variant="ghost"
        size="sm"
        type="button"
        onclick={onshowmembers}
        aria-label={t(M['chat.room_header.show_members'], { count: participantCount })}
        title={t(M['chat.room_header.members'])}
      >
        <svg class="smrt-room-header__action-icon" data-smrt-part="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
          <path d="M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
        <span class="smrt-room-header__action-count" data-smrt-part="count">{participantCount}</span>
      </Button>
    {/if}

    {#if onshowsearch}
      <Button
        variant="ghost"
        size="sm"
        type="button"
        onclick={onshowsearch}
        aria-label={t(M['chat.room_header.search_messages'])}
        title={t(M['chat.room_header.search'])}
      >
        <svg class="smrt-room-header__action-icon" data-smrt-part="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="11" cy="11" r="8" />
          <path d="m21 21-4.35-4.35" />
        </svg>
      </Button>
    {/if}
  </div>
</header>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-room-header__root {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.75rem 1rem;
    min-height: 3.5rem;
  }
  .smrt-room-header__info {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
  }
  .smrt-room-header__title {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .smrt-room-header__icon {
    flex-shrink: 0;
  }
  .smrt-room-header__avatar {
    flex-shrink: 0;
    width: 1.75rem;
    height: 1.75rem;
    object-fit: cover;
  }
  .smrt-room-header__avatar-placeholder {
    flex-shrink: 0;
    width: 1.75rem;
    height: 1.75rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .smrt-room-header__heading {
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .smrt-room-header__badge {
    flex-shrink: 0;
    padding: 0.125rem 0.5rem;
  }
  .smrt-room-header__meta {
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    padding-left: 1.75rem;
  }
  .smrt-room-header__actions {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 0.25rem;
  }
  /* :global() pierces into each Button's rendered <button> (see #1589). */
  .smrt-room-header__actions :global([data-smrt-component="Button"]) {
    gap: 0.25rem;
    padding: 0.375rem 0.5rem;
  }
  .smrt-room-header__action-icon {
    width: 1.25rem;
    height: 1.25rem;
  }
}

@layer smrt.theme {
  .smrt-room-header__root {
    background: var(--smrt-color-surface);
    border-bottom: var(--smrt-hairline);
  }
  .smrt-room-header__icon {
    font-size: var(--smrt-typography-title-medium-size, 1.125rem);
    font-weight: var(--smrt-typography-weight-bold, 700);
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-room-header__avatar {
    border-radius: var(--smrt-radius-full);
  }
  .smrt-room-header__avatar-placeholder {
    border-radius: var(--smrt-radius-full);
    background: var(--smrt-color-primary-container);
    color: var(--smrt-color-on-primary-container);
    font: var(--smrt-typography-label-medium-font, 500 0.75rem / 1 sans-serif);
  }
  .smrt-room-header__heading {
    font: var(--smrt-typography-title-medium-font, 600 1rem / 1.5 sans-serif);
    color: var(--smrt-color-on-surface);
  }
  .smrt-room-header__badge {
    border-radius: var(--smrt-radius-full);
    background: var(--smrt-color-surface-container);
    color: var(--smrt-color-on-surface-variant);
    font: var(--smrt-typography-label-small-font, 500 0.6875rem / 1 sans-serif);
  }
  .smrt-room-header__meta {
    font: var(--smrt-typography-body-small-font, 0.75rem / 1.25 sans-serif);
    color: var(--smrt-color-on-surface-variant);
  }
  /* :global() pierces into each Button's rendered <button> (see #1589). */
  .smrt-room-header__actions :global([data-smrt-component="Button"]) {
    background: none;
    border-radius: var(--smrt-radius-medium, 0.5rem);
    color: var(--smrt-color-on-surface-variant);
    transition: background var(--smrt-duration-short2, 150ms);
  }
  .smrt-room-header__actions :global([data-smrt-component="Button"]:hover) {
    background: var(--smrt-color-surface-variant);
  }
  .smrt-room-header__action-count {
    font: var(--smrt-typography-label-medium-font, 500 0.75rem / 1 sans-serif);
    color: var(--smrt-color-on-surface-variant);
  }
  @media (prefers-reduced-motion: reduce) {
    .smrt-room-header__actions :global([data-smrt-component="Button"]) {
      transition: none;
    }
  }
}

</style>
