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

// Fall back to initials if the image fails to load (e.g. a dead avatar URL).
let imgFailed = $state(false);
// Reset the failure flag whenever the source changes.
$effect(() => {
  src;
  imgFailed = false;
});

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

<span class="smrt-avatar__root smrt-avatar__{size} {className}" {...rest} data-smrt-component="Avatar">
  {#if src && !imgFailed}
    <img
      class="smrt-avatar__img"
      data-smrt-part="body"
      {src}
      alt={name}
      onerror={() => {
        imgFailed = true;
      }}
    />
  {:else}
    <span class="smrt-avatar__initials" data-smrt-part="body" role="img" aria-label={name}>
      {initialsOf(name)}
    </span>
  {/if}
  {#if status}
    <span class="smrt-avatar__status smrt-avatar__{status}" data-smrt-part="indicator">
      <span class="smrt-avatar__sr-only" data-smrt-part="label">{statusLabels[status]}</span>
    </span>
  {/if}
</span>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-avatar__root {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    overflow: visible;
    user-select: none;
  }
  .smrt-avatar__img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  /* Sizes */
  .smrt-avatar__sm {
    width: 24px;
    height: 24px;
  }
  .smrt-avatar__md {
    width: 36px;
    height: 36px;
  }
  .smrt-avatar__lg {
    width: 48px;
    height: 48px;
  }
  .smrt-avatar__xl {
    width: 64px;
    height: 64px;
  }
  /* Presence dot */
  .smrt-avatar__status {
    position: absolute;
    right: 0;
    bottom: 0;
    width: 28%;
    height: 28%;
    min-width: 8px;
    min-height: 8px;
    box-sizing: border-box;
  }
  .smrt-avatar__sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
  }
}

@layer smrt.theme {
  .smrt-avatar__root {
    border-radius: var(--smrt-radius-full);
    background: var(--smrt-color-surface-container-high);
    color: var(--smrt-color-on-surface-variant);
    font-weight: var(--smrt-typography-weight-medium, 500);
  }
  .smrt-avatar__img {
    border-radius: inherit;
  }
  .smrt-avatar__initials {
    line-height: 1;
  }
  /* Sizes */
  .smrt-avatar__sm {
    font-size: var(--smrt-typography-label-small-size, 0.6875rem);
  }
  .smrt-avatar__md {
    font-size: var(--smrt-typography-label-large-size, 0.875rem);
  }
  .smrt-avatar__lg {
    font-size: var(--smrt-typography-title-medium-size, 1rem);
  }
  .smrt-avatar__xl {
    font-size: var(--smrt-typography-title-large-size, 1.375rem);
  }
  /* Presence dot */
  .smrt-avatar__status {
    border-radius: var(--smrt-radius-full);
    border: 2px solid var(--smrt-color-surface);
  }
  .smrt-avatar__status.smrt-avatar__online {
    background: var(--smrt-color-success);
  }
  .smrt-avatar__status.smrt-avatar__offline {
    background: var(--smrt-color-outline);
  }
  .smrt-avatar__status.smrt-avatar__away {
    background: var(--smrt-color-warning);
  }
  .smrt-avatar__status.smrt-avatar__busy {
    background: var(--smrt-color-error);
  }
  .smrt-avatar__sr-only {
    border: 0;
  }
}

</style>
