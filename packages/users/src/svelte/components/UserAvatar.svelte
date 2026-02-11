<script lang="ts">
import type { Profile } from '@happyvertical/smrt-profiles';

export interface Props {
  profile: Profile;
  size?: 'sm' | 'md' | 'lg' | 'xl';
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

// Generate a consistent color based on name
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

<div class="user-avatar" class:sm={size === 'sm'} class:lg={size === 'lg'} class:xl={size === 'xl'}>
  <span class="avatar" style:background-color={getColor(profile.name ?? '')}>
    {getInitials(profile.name ?? 'U')}
  </span>
  {#if showName}
    <span class="name">{profile.name}</span>
  {/if}
</div>

<style>
  .user-avatar {
    display: inline-flex;
    align-items: center;
    gap: var(--md-sys-spacing-sm, 0.5rem);
  }

  .avatar {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 2.5rem;
    height: 2.5rem;
    border-radius: var(--md-sys-shape-corner-full, 9999px);
    color: var(--md-sys-color-on-primary, white);
    font: var(--md-sys-typescale-label-large-font, 600 0.875rem / 1.25 sans-serif);
  }

  .sm .avatar {
    width: 2rem;
    height: 2rem;
    font: var(--md-sys-typescale-label-medium-font, 0.75rem / 1 sans-serif);
  }

  .lg .avatar {
    width: 3rem;
    height: 3rem;
    font: var(--md-sys-typescale-title-medium-font, 1rem / 1.5 sans-serif);
  }

  .xl .avatar {
    width: 4rem;
    height: 4rem;
    font: var(--md-sys-typescale-title-large-font, 1.25rem / 1.25 sans-serif);
  }

  .name {
    font: var(--md-sys-typescale-body-medium-font, 500 0.875rem / 1.25 sans-serif);
  }

  .lg .name,
  .xl .name {
    font: var(--md-sys-typescale-body-large-font, 1rem / 1.5 sans-serif);
  }
</style>
