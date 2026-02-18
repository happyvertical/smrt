<script lang="ts">
/**
 * ChatTabs - Bottom bar with expandable chat tabs (Facebook Messenger style)
 * Fixed to viewport bottom. Shows collapsed tab headers that expand upward on click.
 */
import type { ChatMessageData, ChatTabState } from '../../types.js';
import ChatTab from './ChatTab.svelte';
import ChatTabList from './ChatTabList.svelte';

export interface Props {
  /** Active chat tabs */
  tabs: ChatTabState[];
  /** Messages keyed by roomId */
  messagesByRoom?: Record<string, ChatMessageData[]>;
  /** Current user's profile ID */
  currentProfileId?: string;
  /** Expand a tab */
  onexpand: (roomId: string) => void;
  /** Collapse a tab */
  oncollapse: (roomId: string) => void;
  /** Close a tab */
  onclose: (roomId: string) => void;
  /** Send a message in a tab */
  onsend?: (roomId: string, content: string) => void;
}

const {
  tabs,
  messagesByRoom = {},
  currentProfileId = '',
  onexpand,
  oncollapse,
  onclose,
  onsend,
}: Props = $props();

const expandedTabs = $derived(tabs.filter((t) => t.isExpanded));
const collapsedTabs = $derived(tabs.filter((t) => !t.isExpanded));
</script>

<div class="chat-tabs" aria-label="Chat tabs">
  <div class="chat-tabs__expanded">
    {#each expandedTabs as tab (tab.roomId)}
      <ChatTab
        {tab}
        messages={messagesByRoom[tab.roomId] ?? []}
        {currentProfileId}
        onsend={(content) => onsend?.(tab.roomId, content)}
        oncollapse={() => oncollapse(tab.roomId)}
        onclose={() => onclose(tab.roomId)}
        onexpand={() => onexpand(tab.roomId)}
      />
    {/each}
  </div>

  {#if collapsedTabs.length > 0}
    <ChatTabList
      tabs={collapsedTabs}
      onselect={(roomId) => onexpand(roomId)}
      onclose={(roomId) => onclose(roomId)}
    />
  {/if}
</div>

<style>
  .chat-tabs {
    position: fixed;
    bottom: 0;
    right: 0;
    display: flex;
    align-items: flex-end;
    gap: 8px;
    padding: 0 16px;
    z-index: 1000;
    pointer-events: none;
  }

  .chat-tabs__expanded {
    display: flex;
    align-items: flex-end;
    gap: 8px;
    pointer-events: auto;
  }
</style>
