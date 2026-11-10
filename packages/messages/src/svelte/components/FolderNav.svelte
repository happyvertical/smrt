<script lang="ts">
/**
 * FolderNav - Folder/label navigation sidebar
 */
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import { M } from '../i18n.messages.js';
import type { FolderData } from '../types.js';

const { t } = useI18n();

export interface Props {
  /** Array of folders and labels to display in the sidebar. */
  folders: FolderData[];
  /** ID of the currently selected folder to highlight. */
  activeFolderId?: string;
  /** Shows unread message count badges on folders. */
  showCounts?: boolean;
  /** Called when user clicks on a folder. */
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

<nav class="smrt-folder-nav__root" aria-label={t(M['messages.folder_nav.folders'])} data-smrt-component="FolderNav">
  {#if _systemFolders.length > 0}
    <ul class="smrt-folder-nav__list" role="list" data-smrt-part="list">
      {#each _systemFolders as folder (folder.id)}
        <li>
          <Button
            variant="ghost"
            fullWidth
            class={folder.id === activeFolderId ? 'folder-item folder-item--active' : 'folder-item'}
            onclick={() => onfolderclick?.(folder)}
            aria-current={folder.id === activeFolderId ? 'true' : undefined}
          >
            <span class="smrt-folder-nav__icon" data-smrt-part="icon">{getFolderIcon(folder.specialUse)}</span>
            <span class="smrt-folder-nav__label" data-smrt-part="label">{folder.name}</span>
            {#if showCounts && folder.unreadCount > 0}
              <span class="smrt-folder-nav__count" data-smrt-part="count">{folder.unreadCount}</span>
            {/if}
          </Button>
        </li>
      {/each}
    </ul>
  {/if}

  {#if _userFolders.length > 0}
    {#if _systemFolders.length > 0}
      <hr class="smrt-folder-nav__divider" />
    {/if}
    <ul class="smrt-folder-nav__list" role="list" data-smrt-part="list">
      {#each _userFolders as folder (folder.id)}
        <li>
          <Button
            variant="ghost"
            fullWidth
            class={folder.id === activeFolderId ? 'folder-item folder-item--active' : 'folder-item'}
            onclick={() => onfolderclick?.(folder)}
            aria-current={folder.id === activeFolderId ? 'true' : undefined}
          >
            <span class="smrt-folder-nav__icon" data-smrt-part="icon">📁</span>
            <span class="smrt-folder-nav__label" data-smrt-part="label">{folder.name}</span>
            {#if showCounts && folder.unreadCount > 0}
              <span class="smrt-folder-nav__count" data-smrt-part="count">{folder.unreadCount}</span>
            {/if}
          </Button>
        </li>
      {/each}
    </ul>
  {/if}
</nav>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-folder-nav__root {
    display: flex;
    flex-direction: column;
    padding: 0.5rem 0;
  }
  .smrt-folder-nav__list {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  /*
  * Folder rows now render through smrt-ui's <Button variant="ghost" fullWidth>.
  * The <button> is emitted inside the Button child, so `.smrt-folder-nav__list :global(.folder-item)`
  * anchors on the real `.smrt-folder-nav__list` element and pierces the child scope to keep
  * the nav-row layout, neutral color, hover and active styling (issue #1589). The
  * active modifier is `folder-item--active`, NOT a Button variant class.
  */
  .smrt-folder-nav__list :global(.folder-item) {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    padding: 0.5rem 0.75rem;
  }
  .smrt-folder-nav__icon {
    flex-shrink: 0;
  }
  .smrt-folder-nav__label {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .smrt-folder-nav__count {
    flex-shrink: 0;
    min-width: 1.25rem;
    height: 1.25rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0 0.25rem;
  }
  .smrt-folder-nav__divider {
    margin: 0.25rem 0.75rem;
  }
}

@layer smrt.theme {
  /*
  * Folder rows now render through smrt-ui's <Button variant="ghost" fullWidth>.
  * The <button> is emitted inside the Button child, so `.smrt-folder-nav__list :global(.folder-item)`
  * anchors on the real `.smrt-folder-nav__list` element and pierces the child scope to keep
  * the nav-row layout, neutral color, hover and active styling (issue #1589). The
  * active modifier is `folder-item--active`, NOT a Button variant class.
  */
  .smrt-folder-nav__list :global(.folder-item) {
    border: none;
    background: none;
    font: var(--smrt-typography-body-medium-font, 0.875rem / 1.25 sans-serif);
    color: var(--smrt-color-on-surface);
    border-radius: var(--smrt-radius-small, 0.25rem);
    transition: background var(--smrt-duration-short2, 150ms);
    text-align: left;
  }
  .smrt-folder-nav__list :global(.folder-item):hover {
    background: var(--smrt-color-surface-variant);
  }
  .smrt-folder-nav__list :global(.folder-item--active) {
    background: var(--smrt-color-secondary-container);
    font-weight: var(--smrt-typography-weight-medium, 500);
  }
  .smrt-folder-nav__list :global(.folder-item):focus-visible {
    outline: 2px solid var(--smrt-color-primary);
    outline-offset: -2px;
  }
  .smrt-folder-nav__icon {
    font-size: var(--smrt-typography-body-large-size, 1rem);
  }
  .smrt-folder-nav__count {
    border-radius: var(--smrt-radius-full);
    background: var(--smrt-color-primary);
    color: var(--smrt-color-on-primary);
    font: var(--smrt-typography-label-small-font, 500 0.6875rem / 1 sans-serif);
  }
  .smrt-folder-nav__divider {
    border: none;
    border-top: var(--smrt-hairline);
  }
}

</style>
