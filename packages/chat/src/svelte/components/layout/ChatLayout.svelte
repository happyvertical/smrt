<script lang="ts">
/**
 * ChatLayout - Main chat container with sidebar and content area
 * Discord/Slack-style layout with resizable room list sidebar
 */
import { useI18n } from '@happyvertical/smrt-svelte/i18n';
import type { Snippet } from 'svelte';
import { M } from '../../i18n.messages.js';
import type { ChatRoomData } from '../../types.js';
import RoomList from './RoomList.svelte';

const { t } = useI18n();

export interface Props {
  /** Available chat rooms */
  rooms: ChatRoomData[];
  /** Currently selected room ID */
  currentRoomId?: string;
  /** Current user's profile ID */
  currentProfileId: string;
  /** Callback when a room is selected */
  onselectroom: (roomId: string) => void;
  /** Main content slot */
  children: Snippet;
}

let { rooms, currentRoomId, currentProfileId, onselectroom, children }: Props =
  $props();

let sidebarWidth = $state(260);
let isResizing = $state(false);

const MIN_WIDTH = 200;
const MAX_WIDTH = 400;

function handlePointerDown(event: PointerEvent) {
  isResizing = true;
  const target = event.currentTarget as HTMLElement;
  target.setPointerCapture(event.pointerId);
}

function handlePointerMove(event: PointerEvent) {
  if (!isResizing) return;
  const newWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, event.clientX));
  sidebarWidth = newWidth;
}

function handlePointerUp() {
  isResizing = false;
}
</script>

<div class="chat-layout" class:chat-layout--resizing={isResizing}>
  <aside
    class="chat-layout__sidebar"
    style:width="{sidebarWidth}px"
    aria-label={t(M['chat.chat_layout.rooms_label'])}
  >
    <RoomList
      {rooms}
      {currentRoomId}
      {onselectroom}
    />
  </aside>

  <button
    type="button"
    class="chat-layout__resize-handle"
    aria-label={t(M['chat.chat_layout.resize_sidebar'])}
    onpointerdown={handlePointerDown}
    onpointermove={handlePointerMove}
    onpointerup={handlePointerUp}
    onkeydown={(e) => {
      if (e.key === 'ArrowLeft') sidebarWidth = Math.max(MIN_WIDTH, sidebarWidth - 10);
      if (e.key === 'ArrowRight') sidebarWidth = Math.min(MAX_WIDTH, sidebarWidth + 10);
    }}
  ></button>

  <main class="chat-layout__content">
    {@render children()}
  </main>
</div>

<style>
  .chat-layout {
    display: flex;
    height: 100%;
    width: 100%;
    overflow: hidden;
    background: var(--smrt-color-surface, #fefbff);
    color: var(--smrt-color-on-surface, #1a1c1e);
  }

  .chat-layout--resizing {
    user-select: none;
    cursor: col-resize;
  }

  .chat-layout__sidebar {
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    background: var(--smrt-color-surface-container, #f0f0f4);
    border-right: 1px solid var(--smrt-color-outline-variant, #c4c6d0);
    overflow-y: auto;
    overflow-x: hidden;
  }

  .chat-layout__resize-handle {
    flex-shrink: 0;
    width: 4px;
    padding: 0;
    border: 0;
    cursor: col-resize;
    background: transparent;
    transition: background var(--smrt-duration-short2, 150ms);
  }

  .chat-layout__resize-handle:hover,
  .chat-layout__resize-handle:active {
    background: var(--smrt-color-primary, #005ac1);
    opacity: 0.4;
  }

  .chat-layout__resize-handle:focus-visible {
    outline: 2px solid var(--smrt-color-primary, #005ac1);
    outline-offset: -2px;
  }

  .chat-layout__content {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    overflow: hidden;
  }

  @media (max-width: 600px) {
    .chat-layout__sidebar {
      width: 100% !important;
      position: absolute;
      inset: 0;
      z-index: 10;
    }

    .chat-layout__resize-handle {
      display: none;
    }
  }
</style>
