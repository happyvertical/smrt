<script lang="ts">
/**
 * RoomHeader - Room header bar with name, topic, and action buttons
 * Displays room info and provides access to members and search
 */
import type { ChatRoomData } from '../../types.js';

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

<header class="room-header" aria-label="Room: {room.name}">
  <div class="room-header__info">
    <div class="room-header__title-row">
      {#if room.roomType !== 'dm'}
        <span class="room-header__icon" aria-hidden="true">{roomIcon}</span>
      {:else if room.avatarUrl}
        <img class="room-header__avatar" src={room.avatarUrl} alt="" />
      {:else}
        <span class="room-header__avatar-placeholder">
          {room.name.charAt(0).toUpperCase()}
        </span>
      {/if}
      <h1 class="room-header__name">{room.name}</h1>
      <span class="room-header__type-badge">{roomTypeLabel}</span>
    </div>

    {#if room.topic}
      <p class="room-header__topic" title={room.topic}>
        {room.topic}
      </p>
    {/if}
  </div>

  <div class="room-header__actions">
    {#if onshowmembers}
      <button
        class="header-btn"
        type="button"
        onclick={onshowmembers}
        aria-label="Show members ({participantCount})"
        title="Members"
      >
        <svg class="header-btn__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
          <path d="M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
        <span class="header-btn__count">{participantCount}</span>
      </button>
    {/if}

    {#if onshowsearch}
      <button
        class="header-btn"
        type="button"
        onclick={onshowsearch}
        aria-label="Search messages"
        title="Search"
      >
        <svg class="header-btn__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="11" cy="11" r="8" />
          <path d="m21 21-4.35-4.35" />
        </svg>
      </button>
    {/if}
  </div>
</header>

<style>
  .room-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.75rem 1rem;
    background: var(--smrt-color-surface, #fefbff);
    border-bottom: 1px solid var(--smrt-color-outline-variant, #c4c6d0);
    min-height: 3.5rem;
  }

  .room-header__info {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
  }

  .room-header__title-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .room-header__icon {
    flex-shrink: 0;
    font-size: var(--smrt-typography-title-medium-size, 1.125rem);
    font-weight: var(--smrt-typography-weight-bold, 700);
    color: var(--smrt-color-on-surface-variant, #43474e);
  }

  .room-header__avatar {
    flex-shrink: 0;
    width: 1.75rem;
    height: 1.75rem;
    border-radius: var(--smrt-radius-full, 9999px);
    object-fit: cover;
  }

  .room-header__avatar-placeholder {
    flex-shrink: 0;
    width: 1.75rem;
    height: 1.75rem;
    border-radius: var(--smrt-radius-full, 9999px);
    background: var(--smrt-color-primary-container, #d6e3ff);
    color: var(--smrt-color-on-primary-container, #001a41);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font: var(--smrt-typography-label-medium-font, 500 0.75rem / 1 sans-serif);
  }

  .room-header__name {
    margin: 0;
    font: var(--smrt-typography-title-medium-font, 600 1rem / 1.5 sans-serif);
    color: var(--smrt-color-on-surface, #1a1c1e);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .room-header__type-badge {
    flex-shrink: 0;
    padding: 0.125rem 0.5rem;
    border-radius: var(--smrt-radius-full, 9999px);
    background: var(--smrt-color-surface-container, #f0f0f4);
    color: var(--smrt-color-on-surface-variant, #43474e);
    font: var(--smrt-typography-label-small-font, 500 0.6875rem / 1 sans-serif);
  }

  .room-header__topic {
    margin: 0;
    font: var(--smrt-typography-body-small-font, 0.75rem / 1.25 sans-serif);
    color: var(--smrt-color-on-surface-variant, #43474e);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    padding-left: 1.75rem;
  }

  .room-header__actions {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 0.25rem;
  }

  .header-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.375rem 0.5rem;
    border: none;
    background: none;
    border-radius: var(--smrt-radius-medium, 0.5rem);
    color: var(--smrt-color-on-surface-variant, #43474e);
    cursor: pointer;
    transition: background var(--smrt-duration-short2, 150ms);
  }

  .header-btn:hover {
    background: var(--smrt-color-surface-variant, #e1e2ec);
  }

  .header-btn:focus-visible {
    outline: 2px solid var(--smrt-color-primary, #005ac1);
    outline-offset: -2px;
  }

  .header-btn__icon {
    width: 1.25rem;
    height: 1.25rem;
  }

  .header-btn__count {
    font: var(--smrt-typography-label-medium-font, 500 0.75rem / 1 sans-serif);
    color: var(--smrt-color-on-surface-variant, #43474e);
  }

  @media (prefers-reduced-motion: reduce) {
    .header-btn {
      transition: none;
    }
  }
</style>
