<script lang="ts">
/**
 * FolderNav - Folder/label navigation sidebar
 */
import { useI18n } from '@happyvertical/smrt-svelte/i18n';
import { M } from '../i18n.messages.js';
import type { FolderData } from '../types.js';

const { t } = useI18n();

export interface Props {
  folders: FolderData[];
  activeFolderId?: string;
  showCounts?: boolean;
  onfolderclick?: (folder: FolderData) => void;
}

const {
  folders,
  activeFolderId,
  showCounts = true,
  onfolderclick,
}: Props = $props();

const _systemFolders = $derived(folders.filter((f) => f.specialUse));

const _userFolders = $derived(folders.filter((f) => !f.specialUse));

function getFolderIcon(specialUse?: string): string {
  switch (specialUse) {
    case '\\Inbox':
      return '📥';
    case '\\Sent':
      return '📤';
    case '\\Drafts':
      return '✎';
    case '\\Trash':
      return '🗑';
    case '\\Junk':
    case '\\Spam':
      return '⚠';
    default:
      return '📁';
  }
}
</script>

<nav class="folder-nav" aria-label={t(M['messages.folder_nav.folders'])}>
  {#if _systemFolders.length > 0}
    <ul class="folder-list" role="list">
      {#each _systemFolders as folder (folder.id)}
        <li>
          <button
            class="folder-item"
            class:folder-item--active={folder.id === activeFolderId}
            type="button"
            onclick={() => onfolderclick?.(folder)}
            aria-current={folder.id === activeFolderId ? 'true' : undefined}
          >
            <span class="folder-icon">{getFolderIcon(folder.specialUse)}</span>
            <span class="folder-name">{folder.name}</span>
            {#if showCounts && folder.unreadCount > 0}
              <span class="unread-badge">{folder.unreadCount}</span>
            {/if}
          </button>
        </li>
      {/each}
    </ul>
  {/if}

  {#if _userFolders.length > 0}
    {#if _systemFolders.length > 0}
      <hr class="divider" />
    {/if}
    <ul class="folder-list" role="list">
      {#each _userFolders as folder (folder.id)}
        <li>
          <button
            class="folder-item"
            class:folder-item--active={folder.id === activeFolderId}
            type="button"
            onclick={() => onfolderclick?.(folder)}
            aria-current={folder.id === activeFolderId ? 'true' : undefined}
          >
            <span class="folder-icon">📁</span>
            <span class="folder-name">{folder.name}</span>
            {#if showCounts && folder.unreadCount > 0}
              <span class="unread-badge">{folder.unreadCount}</span>
            {/if}
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</nav>

<style>
  .folder-nav {
    display: flex;
    flex-direction: column;
    padding: 0.5rem 0;
  }

  .folder-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .folder-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    padding: 0.5rem 0.75rem;
    border: none;
    background: none;
    cursor: pointer;
    font: var(--smrt-typography-body-medium-font, 0.875rem / 1.25 sans-serif);
    color: var(--smrt-color-on-surface, #1a1c1e);
    border-radius: var(--smrt-radius-small, 0.25rem);
    transition: background var(--smrt-duration-short2, 150ms);
    text-align: left;
  }

  .folder-item:hover {
    background: var(--smrt-color-surface-variant, #e1e2ec);
  }

  .folder-item--active {
    background: var(--smrt-color-secondary-container, #d7e3f7);
    font-weight: var(--smrt-typography-weight-medium, 500);
  }

  .folder-item:focus-visible {
    outline: 2px solid var(--smrt-color-primary, #005ac1);
    outline-offset: -2px;
  }

  .folder-icon {
    flex-shrink: 0;
    font-size: var(--smrt-typography-body-large-size, 1rem);
  }

  .folder-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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

  .divider {
    border: none;
    border-top: 1px solid var(--smrt-color-outline-variant, #c4c6d0);
    margin: 0.25rem 0.75rem;
  }
</style>
