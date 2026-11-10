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

<span class="smrt-read-receipts__root" aria-label={t(M['chat.read_receipts.read_status'], { readCount: readBy.length, total: totalParticipants })} data-smrt-component="ReadReceipts">
  {#if readBy.length === 0}
    <!-- Single check: sent -->
    <svg class="smrt-read-receipts__icon" data-smrt-part="indicator" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path d="M13.5 4.5l-7 7L3 8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  {:else if !showAvatars}
    <!-- Double check with count -->
    <svg class="smrt-read-receipts__icon smrt-read-receipts__icon--read" data-smrt-part="indicator" viewBox="0 0 20 16" width="18" height="14" aria-hidden="true">
      <path d="M15.5 4.5l-7 7L5 8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
      <path d="M19 4.5l-7 7" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
    <span class="smrt-read-receipts__count" data-smrt-part="count">{readBy.length}</span>
  {:else}
    <!-- Double check with mini avatars -->
    <svg class="smrt-read-receipts__icon" data-smrt-part="indicator" viewBox="0 0 20 16" width="18" height="14" aria-hidden="true"
  class:smrt-read-receipts__icon--read={allRead}
>
      <path d="M15.5 4.5l-7 7L5 8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
      <path d="M19 4.5l-7 7" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
    {#if readBy.length > 0}
      <span class="smrt-read-receipts__avatars" data-smrt-part="list">
        {#each readBy.slice(0, 3) as reader}
          {#if reader.avatarUrl}
            <img class="smrt-read-receipts__mini-avatar" data-smrt-part="media" src={reader.avatarUrl} alt={reader.name} />
          {:else}
            <span class="smrt-read-receipts__mini-avatar smrt-read-receipts__mini-avatar--initials" data-smrt-part="icon" title={reader.name}>
              {getInitial(reader.name)}
            </span>
          {/if}
        {/each}
        {#if readBy.length > 3}
          <span class="smrt-read-receipts__mini-avatar smrt-read-receipts__mini-avatar--more" data-smrt-part="icon">
            +{readBy.length - 3}
          </span>
        {/if}
      </span>
    {/if}
  {/if}
</span>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-read-receipts__root {
    display: inline-flex;
    align-items: center;
    gap: var(--smrt-spacing-1, 0.25rem);
  }
  .smrt-read-receipts__icon {
    flex-shrink: 0;
  }
  .smrt-read-receipts__avatars {
    display: inline-flex;
    align-items: center;
  }
  .smrt-read-receipts__mini-avatar {
    width: 16px;
    height: 16px;
    margin-left: -4px;
    object-fit: cover;
    flex-shrink: 0;
  }
  .smrt-read-receipts__mini-avatar:first-child {
    margin-left: 0;
  }
  .smrt-read-receipts__mini-avatar--initials {
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .smrt-read-receipts__mini-avatar--more {
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
}

@layer smrt.theme {
  .smrt-read-receipts__root {
    color: var(--smrt-color-outline);
  }
  .smrt-read-receipts__icon--read {
    color: var(--smrt-color-primary);
  }
  .smrt-read-receipts__count {
    font-size: var(--smrt-typography-label-small-size, 0.625rem);
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-read-receipts__mini-avatar {
    border-radius: var(--smrt-radius-full);
    border: 1px solid var(--smrt-color-surface);
  }
  .smrt-read-receipts__mini-avatar--initials {
    background: var(--smrt-color-surface-container-high);
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-label-small-size, 0.5rem);
    font-weight: var(--smrt-typography-weight-medium, 500);
  }
  .smrt-read-receipts__mini-avatar--more {
    background: var(--smrt-color-surface-container);
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-label-small-size, 0.5rem);
    font-weight: var(--smrt-typography-weight-medium, 500);
  }
}

</style>
