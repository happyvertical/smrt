<script lang="ts">
/**
 * ChatLayout - Main chat container with sidebar and content area
 * Discord/Slack-style layout with resizable room list sidebar
 */
import { useI18n } from '@happyvertical/smrt-ui/i18n';
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
  /** Callback to open the create-room affordance in the room list */
  oncreateroom?: () => void;
  /** Main content slot */
  children: Snippet;
}

let {
  rooms,
  currentRoomId,
  currentProfileId,
  onselectroom,
  oncreateroom,
  children,
}: Props = $props();

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

<div class="smrt-chat-layout__root" data-smrt-component="ChatLayout"
  class:smrt-chat-layout__resizing={isResizing}
>
  <aside
    class="smrt-chat-layout__sidebar"
    data-smrt-part="panel"
    style:--smrt-chat-layout-sidebar-width="{sidebarWidth}px"
    aria-label={t(M['chat.chat_layout.rooms_label'])}
  >
    <RoomList
      {rooms}
      {currentRoomId}
      {onselectroom}
      {oncreateroom}
    />
  </aside>

  <!-- raw-primitive-allow: custom drag-to-resize splitter with pointer capture (pointerdown/move/up) and ArrowLeft/ArrowRight keyboard resizing; a press-and-drag control no Button primitive owns -->
  <button
    type="button"
    class="smrt-chat-layout__handle"
    data-smrt-part="meta"
    aria-label={t(M['chat.chat_layout.resize_sidebar'])}
    onpointerdown={handlePointerDown}
    onpointermove={handlePointerMove}
    onpointerup={handlePointerUp}
    onkeydown={(e) => {
      if (e.key === 'ArrowLeft') sidebarWidth = Math.max(MIN_WIDTH, sidebarWidth - 10);
      if (e.key === 'ArrowRight') sidebarWidth = Math.min(MAX_WIDTH, sidebarWidth + 10);
    }}
  ></button>

  <main class="smrt-chat-layout__body" data-smrt-part="body">
    {@render children()}
  </main>
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-chat-layout__root {
    display: flex;
    height: 100%;
    width: 100%;
    overflow: hidden;
  }
  .smrt-chat-layout__resizing {
    user-select: none;
    cursor: col-resize;
  }
  .smrt-chat-layout__sidebar {
    flex-shrink: 0;
    width: var(--smrt-chat-layout-sidebar-width);
    display: flex;
    flex-direction: column;
    overflow-y: auto;
    overflow-x: hidden;
  }
  .smrt-chat-layout__handle {
    flex-shrink: 0;
    width: 4px;
    padding: 0;
    cursor: col-resize;
  }
  .smrt-chat-layout__body {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    overflow: hidden;
  }
  @media (max-width: 600px) {
    .smrt-chat-layout__root {
      flex-direction: column;
    }
    .smrt-chat-layout__sidebar {
      width: 100%;
      max-height: 14rem;
    }
    .smrt-chat-layout__handle {
      display: none;
    }
  }
}

@layer smrt.theme {
  .smrt-chat-layout__root {
    background: var(--smrt-color-surface);
    color: var(--smrt-color-on-surface);
  }
  .smrt-chat-layout__sidebar {
    background: var(--smrt-color-surface-container);
    border-right: var(--smrt-hairline);
  }
  .smrt-chat-layout__handle {
    border: 0;
    background: transparent;
    transition: background var(--smrt-duration-short2, 150ms);
  }
  .smrt-chat-layout__handle:hover,
  .smrt-chat-layout__handle:active {
    background: var(--smrt-color-primary);
    opacity: 0.4;
  }
  .smrt-chat-layout__handle:focus-visible {
    outline: 2px solid var(--smrt-color-primary);
    outline-offset: -2px;
  }
  @media (max-width: 600px) {
    .smrt-chat-layout__sidebar {
      border-right: 0;
      border-bottom: var(--smrt-hairline);
    }
  }
}

</style>
