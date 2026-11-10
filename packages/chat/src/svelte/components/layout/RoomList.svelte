<script lang="ts">
/**
 * RoomList - Sidebar room navigation with grouping and unread badges
 * Groups rooms by type: channels, DMs, and agent conversations
 */
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import { M } from '../../i18n.messages.js';
import type { ChatRoomData } from '../../types.js';

const { t } = useI18n();

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

<nav class="smrt-room-list__root" aria-label={t(M['chat.room_list.rooms_label'])} data-smrt-component="RoomList">
  {#if oncreateroom}
    <div class="smrt-room-list__header" data-smrt-part="header">
      <Button
        variant="ghost"
        fullWidth
        type="button"
        onclick={oncreateroom}
        aria-label={t(M['chat.room_list.create_new_room'])}
      >
        {t(M['chat.room_list.new_room'])}
      </Button>
    </div>
  {/if}

  {#if channels.length > 0}
    <section class="smrt-room-list__group" data-smrt-part="group">
      <!-- raw-primitive-allow: section disclosure trigger with aria-expanded toggling a collapsible room list, wrapping rich content (rotating chevron, group label, room count); structural accordion header no Button primitive owns -->
      <button
        class="smrt-room-list__group-header"
        data-smrt-part="trigger"
        type="button"
        onclick={() => toggleGroup('channels')}
        aria-expanded={!collapsedGroups['channels']}
      >
        <span class="smrt-room-list__group-chevron" data-smrt-part="chevron"
  class:smrt-room-list__group-chevron--collapsed={collapsedGroups['channels']}
>
          &#9662;
        </span>
        <span class="smrt-room-list__group-label" data-smrt-part="group-label">Channels</span>
        <span class="smrt-room-list__group-count" data-smrt-part="group-count">{channels.length}</span>
      </button>

      {#if !collapsedGroups['channels']}
        <ul class="smrt-room-list__group-list" data-smrt-part="list" role="list">
          {#each channels as room (room.id)}
            <li>
              <!-- raw-primitive-allow: pressable room-selection row with active and aria-current state, wrapping rich content (type icon, name, unread badge); no Button primitive owns this structural nav-selection pattern -->
              <button
                class="smrt-room-list__item"
                data-smrt-part="row"
                type="button"
                onclick={() => onselectroom(room.id)}
  class:smrt-room-list__item--active={room.id === currentRoomId}
  class:smrt-room-list__item--muted={room.isMuted}

                aria-current={room.id === currentRoomId ? 'true' : undefined}
              >
                <span class="smrt-room-list__item-icon" data-smrt-part="icon">{getRoomIcon(room)}</span>
                <span class="smrt-room-list__item-name" data-smrt-part="label">{room.name}</span>
                {#if room.unreadCount > 0}
                  <span class="smrt-room-list__badge" data-smrt-part="badge" aria-label={t(M['chat.room_list.unread_messages'], { count: room.unreadCount })}>
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
    <section class="smrt-room-list__group" data-smrt-part="group">
      <!-- raw-primitive-allow: section disclosure trigger with aria-expanded toggling a collapsible room list, wrapping rich content (rotating chevron, group label, room count); structural accordion header no Button primitive owns -->
      <button
        class="smrt-room-list__group-header"
        data-smrt-part="trigger"
        type="button"
        onclick={() => toggleGroup('dms')}
        aria-expanded={!collapsedGroups['dms']}
      >
        <span class="smrt-room-list__group-chevron" data-smrt-part="chevron"
  class:smrt-room-list__group-chevron--collapsed={collapsedGroups['dms']}
>
          &#9662;
        </span>
        <span class="smrt-room-list__group-label" data-smrt-part="group-label">{t(M['chat.room_list.direct_messages'])}</span>
        <span class="smrt-room-list__group-count" data-smrt-part="group-count">{directMessages.length}</span>
      </button>

      {#if !collapsedGroups['dms']}
        <ul class="smrt-room-list__group-list" data-smrt-part="list" role="list">
          {#each directMessages as room (room.id)}
            <li>
              <!-- raw-primitive-allow: pressable room-selection row with active and aria-current state, wrapping rich content (avatar, name, last-message preview, timestamp, unread badge); no Button primitive owns this structural nav-selection pattern -->
              <button
                class="smrt-room-list__item"
                data-smrt-part="row"
                type="button"
                onclick={() => onselectroom(room.id)}
  class:smrt-room-list__item--active={room.id === currentRoomId}
  class:smrt-room-list__item--muted={room.isMuted}

                aria-current={room.id === currentRoomId ? 'true' : undefined}
              >
                {#if room.avatarUrl}
                  <img class="smrt-room-list__item-avatar" data-smrt-part="avatar" src={room.avatarUrl} alt="" />
                {:else}
                  <span class="smrt-room-list__item-avatar-placeholder" data-smrt-part="avatar">
                    {room.name.charAt(0).toUpperCase()}
                  </span>
                {/if}
                <span class="smrt-room-list__item-body" data-smrt-part="body">
                  <span class="smrt-room-list__item-name" data-smrt-part="label">{room.name}</span>
                  {#if room.lastMessage}
                    <span class="smrt-room-list__item-preview" data-smrt-part="preview">{room.lastMessage.content}</span>
                  {/if}
                </span>
                <span class="smrt-room-list__item-meta" data-smrt-part="meta">
                  {#if room.lastMessageAt}
                    <span class="smrt-room-list__item-time" data-smrt-part="time">{formatTimestamp(room.lastMessageAt)}</span>
                  {/if}
                  {#if room.unreadCount > 0}
                    <span class="smrt-room-list__badge" data-smrt-part="badge" aria-label={t(M['chat.room_list.unread_messages'], { count: room.unreadCount })}>
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
    <section class="smrt-room-list__group" data-smrt-part="group">
      <!-- raw-primitive-allow: section disclosure trigger with aria-expanded toggling a collapsible room list, wrapping rich content (rotating chevron, group label, room count); structural accordion header no Button primitive owns -->
      <button
        class="smrt-room-list__group-header"
        data-smrt-part="trigger"
        type="button"
        onclick={() => toggleGroup('agents')}
        aria-expanded={!collapsedGroups['agents']}
      >
        <span class="smrt-room-list__group-chevron" data-smrt-part="chevron"
  class:smrt-room-list__group-chevron--collapsed={collapsedGroups['agents']}
>
          &#9662;
        </span>
        <span class="smrt-room-list__group-label" data-smrt-part="group-label">Agents</span>
        <span class="smrt-room-list__group-count" data-smrt-part="group-count">{agentRooms.length}</span>
      </button>

      {#if !collapsedGroups['agents']}
        <ul class="smrt-room-list__group-list" data-smrt-part="list" role="list">
          {#each agentRooms as room (room.id)}
            <li>
              <!-- raw-primitive-allow: pressable room-selection row with active and aria-current state, wrapping rich content (agent icon, name, unread badge); no Button primitive owns this structural nav-selection pattern -->
              <button
                class="smrt-room-list__item"
                data-smrt-part="row"
                type="button"
                onclick={() => onselectroom(room.id)}
  class:smrt-room-list__item--active={room.id === currentRoomId}

                aria-current={room.id === currentRoomId ? 'true' : undefined}
              >
                <span class="smrt-room-list__item-agent-icon" data-smrt-part="icon" aria-hidden="true">&#9881;</span>
                <span class="smrt-room-list__item-name" data-smrt-part="label">{room.name}</span>
                {#if room.unreadCount > 0}
                  <span class="smrt-room-list__badge" data-smrt-part="badge" aria-label={t(M['chat.room_list.unread_messages'], { count: room.unreadCount })}>
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
    <div class="smrt-room-list__empty" data-smrt-part="empty">
      <p>{t(M['chat.room_list.no_rooms'])}</p>
      {#if oncreateroom}
        <Button variant="ghost" size="sm" type="button" onclick={oncreateroom}>
          {t(M['chat.room_list.create_first_room'])}
        </Button>
      {/if}
    </div>
  {/if}
</nav>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-room-list__root {
    display: flex;
    flex-direction: column;
    height: 100%;
    padding: 0.5rem 0;
  }
  .smrt-room-list__header {
    padding: 0.5rem 0.75rem;
  }
  /* :global() pierces into the Button child's rendered <button> (see #1589). */
  .smrt-room-list__header :global([data-smrt-component="Button"]) {
    padding: 0.5rem 0.75rem;
  }
  .smrt-room-list__group {
    margin-top: 0.25rem;
  }
  .smrt-room-list__group-header {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    width: 100%;
    padding: 0.375rem 0.75rem;
    cursor: pointer;
  }
  .smrt-room-list__group-label {
    flex: 1;
  }
  .smrt-room-list__group-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .smrt-room-list__item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    padding: 0.375rem 0.75rem;
    cursor: pointer;
  }
  .smrt-room-list__item-icon {
    flex-shrink: 0;
    width: 1.25rem;
  }
  .smrt-room-list__item-agent-icon {
    flex-shrink: 0;
    width: 1.25rem;
  }
  .smrt-room-list__item-avatar {
    flex-shrink: 0;
    width: 2rem;
    height: 2rem;
    object-fit: cover;
  }
  .smrt-room-list__item-avatar-placeholder {
    flex-shrink: 0;
    width: 2rem;
    height: 2rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .smrt-room-list__item-body {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
  }
  .smrt-room-list__item-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .smrt-room-list__item-preview {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .smrt-room-list__item-meta {
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 0.25rem;
  }
  .smrt-room-list__badge {
    flex-shrink: 0;
    min-width: 1.25rem;
    height: 1.25rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0 0.25rem;
  }
  .smrt-room-list__empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    padding: 2rem 1rem;
  }
  .smrt-room-list__empty p {
    margin: 0;
  }
}

@layer smrt.theme {
  /* :global() pierces into the Button child's rendered <button> (see #1589). */
  .smrt-room-list__header :global([data-smrt-component="Button"]) {
    border: 1px dashed var(--smrt-color-outline);
    border-radius: var(--smrt-radius-medium, 0.5rem);
    background: transparent;
    color: var(--smrt-color-primary);
    font: var(--smrt-typography-label-large-font, 500 0.875rem / 1.25 sans-serif);
    transition: background var(--smrt-duration-short2, 150ms);
  }
  .smrt-room-list__header :global([data-smrt-component="Button"]:hover) {
    background: var(--smrt-color-primary-container);
  }
  .smrt-room-list__group-header {
    border: none;
    background: none;
    font: var(--smrt-typography-label-small-font, 500 0.6875rem / 1 sans-serif);
    color: var(--smrt-color-on-surface-variant);
    text-transform: uppercase;
    letter-spacing: var(--smrt-typography-label-small-tracking, 0.05em);
  }
  .smrt-room-list__group-header:hover {
    color: var(--smrt-color-on-surface);
  }
  .smrt-room-list__group-chevron {
    font-size: var(--smrt-typography-label-small-size, 0.625rem);
    transition: transform var(--smrt-duration-short2, 150ms);
  }
  .smrt-room-list__group-chevron--collapsed {
    transform: rotate(-90deg);
  }
  .smrt-room-list__group-label {
    text-align: left;
  }
  .smrt-room-list__group-count {
    color: var(--smrt-color-outline);
    font-size: var(--smrt-typography-label-small-size, 0.625rem);
  }
  .smrt-room-list__item {
    border: none;
    background: none;
    font: var(--smrt-typography-body-medium-font, 0.875rem / 1.25 sans-serif);
    color: var(--smrt-color-on-surface);
    border-radius: var(--smrt-radius-small, 0.25rem);
    text-align: left;
    transition: background var(--smrt-duration-short2, 150ms);
  }
  .smrt-room-list__item:hover {
    background: var(--smrt-color-surface-variant);
  }
  .smrt-room-list__item--active {
    background: var(--smrt-color-secondary-container);
    font-weight: var(--smrt-typography-weight-medium, 500);
  }
  .smrt-room-list__item--muted {
    opacity: 0.6;
  }
  .smrt-room-list__item:focus-visible {
    outline: 2px solid var(--smrt-color-primary);
    outline-offset: -2px;
  }
  .smrt-room-list__item-icon {
    text-align: center;
    color: var(--smrt-color-on-surface-variant);
    font-weight: var(--smrt-typography-weight-semibold, 600);
  }
  .smrt-room-list__item-agent-icon {
    text-align: center;
    font-size: var(--smrt-typography-body-large-size, 1rem);
  }
  .smrt-room-list__item-avatar {
    border-radius: var(--smrt-radius-full);
  }
  .smrt-room-list__item-avatar-placeholder {
    border-radius: var(--smrt-radius-full);
    background: var(--smrt-color-primary-container);
    color: var(--smrt-color-on-primary-container);
    font: var(--smrt-typography-label-medium-font, 500 0.75rem / 1 sans-serif);
  }
  .smrt-room-list__item-preview {
    font: var(--smrt-typography-body-small-font, 0.75rem / 1.25 sans-serif);
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-room-list__item-time {
    font: var(--smrt-typography-label-small-font, 500 0.6875rem / 1 sans-serif);
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-room-list__badge {
    border-radius: var(--smrt-radius-full);
    background: var(--smrt-color-primary);
    color: var(--smrt-color-on-primary);
    font: var(--smrt-typography-label-small-font, 500 0.6875rem / 1 sans-serif);
  }
  .smrt-room-list__empty {
    text-align: center;
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-room-list__empty p {
    font: var(--smrt-typography-body-medium-font, 0.875rem / 1.25 sans-serif);
  }
  /* :global() pierces into the Button child's rendered <button> (see #1589). */
  .smrt-room-list__empty :global([data-smrt-component="Button"]) {
    background: none;
    color: var(--smrt-color-primary);
    font: var(--smrt-typography-label-large-font, 500 0.875rem / 1.25 sans-serif);
    text-decoration: underline;
  }
  .smrt-room-list__empty :global([data-smrt-component="Button"]:hover) {
    background: none;
  }
  @media (prefers-reduced-motion: reduce) {
    .smrt-room-list__item,
    .smrt-room-list__group-chevron {
      transition: none;
    }
    .smrt-room-list__header :global([data-smrt-component="Button"]) {
      transition: none;
    }
  }
}

</style>
