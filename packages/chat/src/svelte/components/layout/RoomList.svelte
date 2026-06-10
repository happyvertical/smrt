<script lang="ts">
/**
 * RoomList - Sidebar room navigation with grouping and unread badges
 * Groups rooms by type: channels, DMs, and agent conversations
 */
import type { ChatRoomData } from '../../types.js';

export interface Props {
  /** Available chat rooms */
  rooms: ChatRoomData[];
  /** Currently selected room ID */
  currentRoomId?: string;
  /** Callback when a room is selected */
  onselectroom: (roomId: string) => void;
  /** Callback to open create room dialog */
  oncreateroom?: () => void;
}

let { rooms, currentRoomId, onselectroom, oncreateroom }: Props = $props();

let collapsedGroups = $state<Record<string, boolean>>({});

const channels = $derived(
  rooms.filter((r) => r.roomType === 'public' || r.roomType === 'private'),
);
const directMessages = $derived(rooms.filter((r) => r.roomType === 'dm'));
const agentRooms = $derived(rooms.filter((r) => r.roomType === 'agent'));

function toggleGroup(group: string) {
  collapsedGroups[group] = !collapsedGroups[group];
}

function getRoomIcon(room: ChatRoomData): string {
  switch (room.roomType) {
    case 'public':
      return '#';
    case 'private':
      return '\u{1F512}';
    case 'dm':
      return '';
    case 'agent':
      return '';
    default:
      return '#';
  }
}

function formatTimestamp(date?: string | Date | null): string {
  if (!date) return '';
  const d = typeof date === 'string' ? new Date(date) : date;
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  const oneDay = 86400000;
  if (diff < oneDay) {
    return d.toLocaleTimeString(undefined, {
      hour: 'numeric',
      minute: '2-digit',
    });
  }
  if (diff < 7 * oneDay) {
    return d.toLocaleDateString(undefined, { weekday: 'short' });
  }
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
</script>

<nav class="room-list" aria-label="Chat rooms">
  {#if oncreateroom}
    <div class="room-list__header">
      <button
        class="create-room-btn"
        type="button"
        onclick={oncreateroom}
        aria-label="Create new room"
      >
        + New Room
      </button>
    </div>
  {/if}

  {#if channels.length > 0}
    <section class="room-group">
      <button
        class="room-group__header"
        type="button"
        onclick={() => toggleGroup('channels')}
        aria-expanded={!collapsedGroups['channels']}
      >
        <span class="room-group__chevron" class:room-group__chevron--collapsed={collapsedGroups['channels']}>
          &#9662;
        </span>
        <span class="room-group__label">Channels</span>
        <span class="room-group__count">{channels.length}</span>
      </button>

      {#if !collapsedGroups['channels']}
        <ul class="room-group__list" role="list">
          {#each channels as room (room.id)}
            <li>
              <button
                class="room-item"
                class:room-item--active={room.id === currentRoomId}
                class:room-item--muted={room.isMuted}
                type="button"
                onclick={() => onselectroom(room.id)}
                aria-current={room.id === currentRoomId ? 'true' : undefined}
              >
                <span class="room-item__icon">{getRoomIcon(room)}</span>
                <span class="room-item__name">{room.name}</span>
                {#if room.unreadCount > 0}
                  <span class="unread-badge" aria-label="{room.unreadCount} unread messages">
                    {room.unreadCount > 99 ? '99+' : room.unreadCount}
                  </span>
                {/if}
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  {/if}

  {#if directMessages.length > 0}
    <section class="room-group">
      <button
        class="room-group__header"
        type="button"
        onclick={() => toggleGroup('dms')}
        aria-expanded={!collapsedGroups['dms']}
      >
        <span class="room-group__chevron" class:room-group__chevron--collapsed={collapsedGroups['dms']}>
          &#9662;
        </span>
        <span class="room-group__label">Direct Messages</span>
        <span class="room-group__count">{directMessages.length}</span>
      </button>

      {#if !collapsedGroups['dms']}
        <ul class="room-group__list" role="list">
          {#each directMessages as room (room.id)}
            <li>
              <button
                class="room-item"
                class:room-item--active={room.id === currentRoomId}
                class:room-item--muted={room.isMuted}
                type="button"
                onclick={() => onselectroom(room.id)}
                aria-current={room.id === currentRoomId ? 'true' : undefined}
              >
                {#if room.avatarUrl}
                  <img class="room-item__avatar" src={room.avatarUrl} alt="" />
                {:else}
                  <span class="room-item__avatar-placeholder">
                    {room.name.charAt(0).toUpperCase()}
                  </span>
                {/if}
                <span class="room-item__details">
                  <span class="room-item__name">{room.name}</span>
                  {#if room.lastMessage}
                    <span class="room-item__preview">{room.lastMessage.content}</span>
                  {/if}
                </span>
                <span class="room-item__meta">
                  {#if room.lastMessageAt}
                    <span class="room-item__time">{formatTimestamp(room.lastMessageAt)}</span>
                  {/if}
                  {#if room.unreadCount > 0}
                    <span class="unread-badge" aria-label="{room.unreadCount} unread messages">
                      {room.unreadCount > 99 ? '99+' : room.unreadCount}
                    </span>
                  {/if}
                </span>
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  {/if}

  {#if agentRooms.length > 0}
    <section class="room-group">
      <button
        class="room-group__header"
        type="button"
        onclick={() => toggleGroup('agents')}
        aria-expanded={!collapsedGroups['agents']}
      >
        <span class="room-group__chevron" class:room-group__chevron--collapsed={collapsedGroups['agents']}>
          &#9662;
        </span>
        <span class="room-group__label">Agents</span>
        <span class="room-group__count">{agentRooms.length}</span>
      </button>

      {#if !collapsedGroups['agents']}
        <ul class="room-group__list" role="list">
          {#each agentRooms as room (room.id)}
            <li>
              <button
                class="room-item"
                class:room-item--active={room.id === currentRoomId}
                type="button"
                onclick={() => onselectroom(room.id)}
                aria-current={room.id === currentRoomId ? 'true' : undefined}
              >
                <span class="room-item__agent-icon" aria-hidden="true">&#9881;</span>
                <span class="room-item__name">{room.name}</span>
                {#if room.unreadCount > 0}
                  <span class="unread-badge" aria-label="{room.unreadCount} unread messages">
                    {room.unreadCount > 99 ? '99+' : room.unreadCount}
                  </span>
                {/if}
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  {/if}

  {#if rooms.length === 0}
    <div class="room-list__empty">
      <p>No rooms yet</p>
      {#if oncreateroom}
        <button class="create-link" type="button" onclick={oncreateroom}>
          Create your first room
        </button>
      {/if}
    </div>
  {/if}
</nav>

<style>
  .room-list {
    display: flex;
    flex-direction: column;
    height: 100%;
    padding: 0.5rem 0;
  }

  .room-list__header {
    padding: 0.5rem 0.75rem;
  }

  .create-room-btn {
    width: 100%;
    padding: 0.5rem 0.75rem;
    border: 1px dashed var(--smrt-color-outline, #74777f);
    border-radius: var(--smrt-radius-medium, 0.5rem);
    background: transparent;
    color: var(--smrt-color-primary, #005ac1);
    font: var(--smrt-typography-label-large-font, 500 0.875rem / 1.25 sans-serif);
    cursor: pointer;
    transition: background var(--smrt-duration-short2, 150ms);
  }

  .create-room-btn:hover {
    background: var(--smrt-color-primary-container, #d6e3ff);
  }

  .create-room-btn:focus-visible {
    outline: 2px solid var(--smrt-color-primary, #005ac1);
    outline-offset: -2px;
  }

  .room-group {
    margin-top: 0.25rem;
  }

  .room-group__header {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    width: 100%;
    padding: 0.375rem 0.75rem;
    border: none;
    background: none;
    cursor: pointer;
    font: var(--smrt-typography-label-small-font, 500 0.6875rem / 1 sans-serif);
    color: var(--smrt-color-on-surface-variant, #43474e);
    text-transform: uppercase;
    letter-spacing: var(--smrt-typography-label-small-tracking, 0.05em);
  }

  .room-group__header:hover {
    color: var(--smrt-color-on-surface, #1a1c1e);
  }

  .room-group__chevron {
    font-size: var(--smrt-typography-label-small-size, 0.625rem);
    transition: transform var(--smrt-duration-short2, 150ms);
  }

  .room-group__chevron--collapsed {
    transform: rotate(-90deg);
  }

  .room-group__label {
    flex: 1;
    text-align: left;
  }

  .room-group__count {
    color: var(--smrt-color-outline, #74777f);
    font-size: var(--smrt-typography-label-small-size, 0.625rem);
  }

  .room-group__list {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .room-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    padding: 0.375rem 0.75rem;
    border: none;
    background: none;
    cursor: pointer;
    font: var(--smrt-typography-body-medium-font, 0.875rem / 1.25 sans-serif);
    color: var(--smrt-color-on-surface, #1a1c1e);
    border-radius: var(--smrt-radius-small, 0.25rem);
    text-align: left;
    transition: background var(--smrt-duration-short2, 150ms);
  }

  .room-item:hover {
    background: var(--smrt-color-surface-variant, #e1e2ec);
  }

  .room-item--active {
    background: var(--smrt-color-secondary-container, #d7e3f7);
    font-weight: var(--smrt-typography-weight-medium, 500);
  }

  .room-item--muted {
    opacity: 0.6;
  }

  .room-item:focus-visible {
    outline: 2px solid var(--smrt-color-primary, #005ac1);
    outline-offset: -2px;
  }

  .room-item__icon {
    flex-shrink: 0;
    width: 1.25rem;
    text-align: center;
    color: var(--smrt-color-on-surface-variant, #43474e);
    font-weight: var(--smrt-typography-weight-semibold, 600);
  }

  .room-item__agent-icon {
    flex-shrink: 0;
    width: 1.25rem;
    text-align: center;
    font-size: var(--smrt-typography-body-large-size, 1rem);
  }

  .room-item__avatar {
    flex-shrink: 0;
    width: 2rem;
    height: 2rem;
    border-radius: var(--smrt-radius-full, 9999px);
    object-fit: cover;
  }

  .room-item__avatar-placeholder {
    flex-shrink: 0;
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

  .room-item__details {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
  }

  .room-item__name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .room-item__preview {
    font: var(--smrt-typography-body-small-font, 0.75rem / 1.25 sans-serif);
    color: var(--smrt-color-on-surface-variant, #43474e);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .room-item__meta {
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 0.25rem;
  }

  .room-item__time {
    font: var(--smrt-typography-label-small-font, 500 0.6875rem / 1 sans-serif);
    color: var(--smrt-color-on-surface-variant, #43474e);
  }

  .unread-badge {
    flex-shrink: 0;
    min-width: 1.25rem;
    height: 1.25rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--smrt-radius-full, 9999px);
    background: var(--smrt-color-primary, #005ac1);
    color: var(--smrt-color-on-primary, #fff);
    font: var(--smrt-typography-label-small-font, 500 0.6875rem / 1 sans-serif);
    padding: 0 0.25rem;
  }

  .room-list__empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    padding: 2rem 1rem;
    text-align: center;
    color: var(--smrt-color-on-surface-variant, #43474e);
  }

  .room-list__empty p {
    margin: 0;
    font: var(--smrt-typography-body-medium-font, 0.875rem / 1.25 sans-serif);
  }

  .create-link {
    border: none;
    background: none;
    color: var(--smrt-color-primary, #005ac1);
    font: var(--smrt-typography-label-large-font, 500 0.875rem / 1.25 sans-serif);
    cursor: pointer;
    text-decoration: underline;
  }

  @media (prefers-reduced-motion: reduce) {
    .room-item,
    .create-room-btn,
    .room-group__chevron {
      transition: none;
    }
  }
</style>
