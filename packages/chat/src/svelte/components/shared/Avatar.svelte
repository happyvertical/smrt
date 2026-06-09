<script lang="ts">
/**
 * Avatar - Profile avatar with online presence indicator
 * Shows initials fallback when no image URL is provided.
 */

export interface Props {
  /** Display name used for initials fallback */
  name: string;
  /** URL for the avatar image */
  avatarUrl?: string;
  /** Online presence status */
  onlineStatus?: 'online' | 'away' | 'dnd' | 'offline';
  /** Avatar size */
  size?: 'sm' | 'md' | 'lg';
}

const { name, avatarUrl, onlineStatus, size = 'md' }: Props = $props();
const safeName = $derived(name?.trim() || '');
const avatarAlt = $derived(safeName || 'Avatar');
const avatarLabel = $derived(safeName ? `${safeName}'s avatar` : 'Avatar');

const initials = $derived.by(() => {
  const parts = safeName.split(/\s+/);
  if (!parts[0]) return '?';
  if (parts.length >= 2) {
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  return (parts[0]?.[0] ?? '?').toUpperCase();
});

let imgError = $state(false);

function handleImgError() {
  imgError = true;
}
</script>

<div class="avatar {size}" aria-label={avatarLabel}>
  {#if avatarUrl && !imgError}
    <img
      class="avatar__img"
      src={avatarUrl}
      alt={avatarAlt}
      onerror={handleImgError}
    />
  {:else}
    <span class="avatar__initials">{initials}</span>
  {/if}

  {#if onlineStatus}
    <span class="avatar__presence {onlineStatus}" aria-label="{onlineStatus}"></span>
  {/if}
</div>

<style>
  .avatar {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--smrt-radius-full, 9999px);
    background: var(--smrt-color-primary-container, #d6e3ff);
    color: var(--smrt-color-on-primary-container, #001a41);
    font-weight: var(--smrt-typography-weight-medium, 500);
    flex-shrink: 0;
    overflow: hidden;
  }

  .sm {
    width: 28px;
    height: 28px;
    font-size: var(--smrt-typography-label-small-size, 0.6875rem);
  }

  .md {
    width: 36px;
    height: 36px;
    font-size: var(--smrt-typography-label-large-size, 0.8125rem);
  }

  .lg {
    width: 48px;
    height: 48px;
    font-size: var(--smrt-typography-body-large-size, 1rem);
  }

  .avatar__img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    border-radius: var(--smrt-radius-full, 9999px);
  }

  .avatar__initials {
    user-select: none;
    line-height: 1;
  }

  .avatar__presence {
    position: absolute;
    bottom: 0;
    right: 0;
    border-radius: var(--smrt-radius-full, 9999px);
    border: 2px solid var(--smrt-color-surface, #ffffff);
  }

  .sm .avatar__presence {
    width: 8px;
    height: 8px;
  }

  .md .avatar__presence {
    width: 10px;
    height: 10px;
  }

  .lg .avatar__presence {
    width: 12px;
    height: 12px;
  }

  .avatar__presence.online {
    background: var(--smrt-color-success, #4caf50);
  }

  .avatar__presence.away {
    background: var(--smrt-color-warning, #ff9800);
  }

  .avatar__presence.dnd {
    background: var(--smrt-color-error, #f44336);
  }

  .avatar__presence.offline {
    background: var(--smrt-color-outline, #74777f);
  }
</style>
