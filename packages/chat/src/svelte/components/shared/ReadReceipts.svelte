<script lang="ts">
/**
 * ReadReceipts - Message read status display
 * Shows checkmarks or small avatars indicating who has read a message.
 */
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { M } from '../../i18n.js';

const { t } = useI18n();

export interface Props {
  /** Users who have read the message */
  readBy: Array<{ name: string; avatarUrl?: string }>;
  /** Total participants in the conversation */
  totalParticipants: number;
}

const { readBy, totalParticipants }: Props = $props();

const allRead = $derived(readBy.length >= totalParticipants - 1);
const showAvatars = $derived(readBy.length <= 5);

function getInitial(name: string): string {
  return (name[0] ?? '?').toUpperCase();
}
</script>

<span class="read-receipts" aria-label={t(M['chat.read_receipts.read_status'], { readCount: readBy.length, total: totalParticipants })}>
  {#if readBy.length === 0}
    <!-- Single check: sent -->
    <svg class="read-receipts__icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path d="M13.5 4.5l-7 7L3 8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  {:else if !showAvatars}
    <!-- Double check with count -->
    <svg class="read-receipts__icon read-receipts__icon--read" viewBox="0 0 20 16" width="18" height="14" aria-hidden="true">
      <path d="M15.5 4.5l-7 7L5 8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
      <path d="M19 4.5l-7 7" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
    <span class="read-receipts__count">{readBy.length}</span>
  {:else}
    <!-- Double check with mini avatars -->
    <svg class="read-receipts__icon" class:read-receipts__icon--read={allRead} viewBox="0 0 20 16" width="18" height="14" aria-hidden="true">
      <path d="M15.5 4.5l-7 7L5 8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
      <path d="M19 4.5l-7 7" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
    {#if readBy.length > 0}
      <span class="read-receipts__avatars">
        {#each readBy.slice(0, 3) as reader}
          {#if reader.avatarUrl}
            <img class="read-receipts__mini-avatar" src={reader.avatarUrl} alt={reader.name} />
          {:else}
            <span class="read-receipts__mini-avatar read-receipts__mini-avatar--initials" title={reader.name}>
              {getInitial(reader.name)}
            </span>
          {/if}
        {/each}
        {#if readBy.length > 3}
          <span class="read-receipts__mini-avatar read-receipts__mini-avatar--more">
            +{readBy.length - 3}
          </span>
        {/if}
      </span>
    {/if}
  {/if}
</span>

<style>
  .read-receipts {
    display: inline-flex;
    align-items: center;
    gap: var(--smrt-spacing-1, 0.25rem);
    color: var(--smrt-color-outline, #74777f);
  }

  .read-receipts__icon {
    flex-shrink: 0;
  }

  .read-receipts__icon--read {
    color: var(--smrt-color-primary, #005ac1);
  }

  .read-receipts__count {
    font-size: var(--smrt-typography-label-small-size, 0.625rem);
    color: var(--smrt-color-on-surface-variant, #43474e);
  }

  .read-receipts__avatars {
    display: inline-flex;
    align-items: center;
  }

  .read-receipts__mini-avatar {
    width: 16px;
    height: 16px;
    border-radius: var(--smrt-radius-full, 9999px);
    border: 1px solid var(--smrt-color-surface, #ffffff);
    margin-left: -4px;
    object-fit: cover;
    flex-shrink: 0;
  }

  .read-receipts__mini-avatar:first-child {
    margin-left: 0;
  }

  .read-receipts__mini-avatar--initials {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: var(--smrt-color-surface-container-high, #e1e3e8);
    color: var(--smrt-color-on-surface-variant, #43474e);
    font-size: var(--smrt-typography-label-small-size, 0.5rem);
    font-weight: var(--smrt-typography-weight-medium, 500);
  }

  .read-receipts__mini-avatar--more {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: var(--smrt-color-surface-container, #f3f4f6);
    color: var(--smrt-color-on-surface-variant, #43474e);
    font-size: var(--smrt-typography-label-small-size, 0.5rem);
    font-weight: var(--smrt-typography-weight-medium, 500);
  }
</style>
