<script lang="ts">
import type { Profile } from '@happyvertical/smrt-profiles';

export interface Props {
  /** User profile containing name and avatar details. */
  profile: Profile;
  /** Avatar size: sm, md, lg, or xl. */
  size?: 'sm' | 'md' | 'lg' | 'xl';
  /** Displays the user's name next to the avatar. */
  showName?: boolean;
}

const { profile, size = 'md', showName = false }: Props = $props();

function getInitials(name: string): string {
  return name
    .split(' ')
    .map((part) => part[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
}

// Deterministic per-name avatar color (identicon-style): a fixed decorative
// palette hashed by name for at-a-glance user differentiation. These are
// intentionally NOT --smrt-color-* tokens — a variety palette, not themeable
// semantic roles (cf. the channel-brand avatars in smrt-messages). Applied via
// an inline style binding, so the color-literal ratchet does not scan them.
function getColor(name: string): string {
  const colors = [
    '#ef4444',
    '#f97316',
    '#f59e0b',
    '#84cc16',
    '#22c55e',
    '#14b8a6',
    '#06b6d4',
    '#0ea5e9',
    '#3b82f6',
    '#6366f1',
    '#8b5cf6',
    '#a855f7',
    '#d946ef',
    '#ec4899',
    '#f43f5e',
  ];
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
}
</script>

<div class="smrt-user-avatar__root" class:smrt-user-avatar__sm={size === 'sm'} class:smrt-user-avatar__lg={size === 'lg'} class:smrt-user-avatar__xl={size === 'xl'} data-smrt-component="UserAvatar">
  <span class="smrt-user-avatar__avatar" data-smrt-part="icon" style:background-color={getColor(profile.name ?? '')}>
    {getInitials(profile.name ?? 'U')}
  </span>
  {#if showName}
    <span class="smrt-user-avatar__name" data-smrt-part="title">{profile.name}</span>
  {/if}
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-user-avatar__root {
    display: inline-flex;
    align-items: center;
    gap: var(--smrt-spacing-sm, 0.5rem);
  }
  .smrt-user-avatar__avatar {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 2.5rem;
    height: 2.5rem;
  }
  .smrt-user-avatar__sm .smrt-user-avatar__avatar {
    width: 2rem;
    height: 2rem;
  }
  .smrt-user-avatar__lg .smrt-user-avatar__avatar {
    width: 3rem;
    height: 3rem;
  }
  .smrt-user-avatar__xl .smrt-user-avatar__avatar {
    width: 4rem;
    height: 4rem;
  }
}

@layer smrt.theme {
  .smrt-user-avatar__avatar {
    border-radius: var(--smrt-radius-full);
    color: var(--smrt-color-on-primary, white);
    font: var(--smrt-typography-label-large-font, 600 0.875rem / 1.25 sans-serif);
  }
  .smrt-user-avatar__sm .smrt-user-avatar__avatar {
    font: var(--smrt-typography-label-medium-font, 0.75rem / 1 sans-serif);
  }
  .smrt-user-avatar__lg .smrt-user-avatar__avatar {
    font: var(--smrt-typography-title-medium-font, 1rem / 1.5 sans-serif);
  }
  .smrt-user-avatar__xl .smrt-user-avatar__avatar {
    font: var(--smrt-typography-title-large-font, 1.25rem / 1.25 sans-serif);
  }
  .smrt-user-avatar__name {
    font: var(--smrt-typography-body-medium-font, 500 0.875rem / 1.25 sans-serif);
  }
  .smrt-user-avatar__lg .smrt-user-avatar__name,
  .smrt-user-avatar__xl .smrt-user-avatar__name {
    font: var(--smrt-typography-body-large-font, 1rem / 1.5 sans-serif);
  }
}

</style>
