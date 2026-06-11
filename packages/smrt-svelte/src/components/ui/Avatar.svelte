<script lang="ts">
/**
 * Avatar — user/entity image with initials fallback and optional presence dot.
 *
 * Renders the image when `src` is set, otherwise initials derived from `name`.
 * `name` is always the accessible label (image alt / initials aria-label), so an
 * Avatar is never an unlabelled graphic.
 */
import type { HTMLAttributes } from 'svelte/elements';

export type AvatarSize = 'sm' | 'md' | 'lg' | 'xl';
export type AvatarStatus = 'online' | 'offline' | 'away' | 'busy';

export interface Props extends Omit<HTMLAttributes<HTMLSpanElement>, 'class'> {
  /** Image URL. When absent, initials from `name` are shown. */
  src?: string;
  /** Accessible name; also the image alt and initials fallback source. */
  name: string;
  /** Size variant. */
  size?: AvatarSize;
  /** Optional presence indicator. */
  status?: AvatarStatus;
  /** Extra class on the root. */
  class?: string;
}

const {
  src,
  name,
  size = 'md',
  status,
  class: className = '',
  ...rest
}: Props = $props();

/** First+last initial (or first two letters of a single word). */
function initialsOf(value: string): string {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

const statusLabels: Record<AvatarStatus, string> = {
  online: 'Online',
  offline: 'Offline',
  away: 'Away',
  busy: 'Busy',
};
</script>

<span class="avatar {size} {className}" {...rest}>
  {#if src}
    <img class="avatar__img" {src} alt={name} />
  {:else}
    <span class="avatar__initials" role="img" aria-label={name}>
      {initialsOf(name)}
    </span>
  {/if}
  {#if status}
    <span class="avatar__status {status}">
      <span class="avatar__sr-only">{statusLabels[status]}</span>
    </span>
  {/if}
</span>

<style>
  .avatar {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    border-radius: var(--smrt-radius-full, 9999px);
    background: var(--smrt-color-surface-container-high);
    color: var(--smrt-color-on-surface-variant);
    font-weight: var(--smrt-typography-weight-medium, 500);
    overflow: visible;
    user-select: none;
  }

  .avatar__img {
    width: 100%;
    height: 100%;
    border-radius: inherit;
    object-fit: cover;
  }

  .avatar__initials {
    line-height: 1;
  }

  /* Sizes */
  .sm {
    width: 24px;
    height: 24px;
    font-size: var(--smrt-typography-label-small-size, 0.6875rem);
  }
  .md {
    width: 36px;
    height: 36px;
    font-size: var(--smrt-typography-label-large-size, 0.875rem);
  }
  .lg {
    width: 48px;
    height: 48px;
    font-size: var(--smrt-typography-title-medium-size, 1rem);
  }
  .xl {
    width: 64px;
    height: 64px;
    font-size: var(--smrt-typography-title-large-size, 1.375rem);
  }

  /* Presence dot */
  .avatar__status {
    position: absolute;
    right: 0;
    bottom: 0;
    width: 28%;
    height: 28%;
    min-width: 8px;
    min-height: 8px;
    border-radius: var(--smrt-radius-full, 9999px);
    border: 2px solid var(--smrt-color-surface);
    box-sizing: border-box;
  }
  .avatar__status.online {
    background: var(--smrt-color-success, #2e7d32);
  }
  .avatar__status.offline {
    background: var(--smrt-color-outline, #79747e);
  }
  .avatar__status.away {
    background: var(--smrt-color-warning, #ed6c02);
  }
  .avatar__status.busy {
    background: var(--smrt-color-error, #ba1a1a);
  }

  .avatar__sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
</style>
