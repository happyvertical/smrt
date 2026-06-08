<script lang="ts">
/**
 * RoleBadge - Role label component
 * refactored for Material 3
 */
import type { Role } from '@happyvertical/smrt-users';

export interface Props {
  role: Role;
  size?: 'sm' | 'md' | 'lg';
}

const { role, size = 'md' }: Props = $props();

const variantClass = $derived.by(() => {
  switch (role.slug) {
    case 'owner':
      return 'variant-owner';
    case 'admin':
      return 'variant-admin';
    case 'member':
      return 'variant-member';
    default:
      return 'variant-default';
  }
});
</script>

<span
  class="role-badge {variantClass}"
  class:sm={size === 'sm'}
  class:lg={size === 'lg'}
>
  {role.name}
</span>

<style>
  .role-badge {
    display: inline-flex;
    align-items: center;
    padding: 0 var(--smrt-spacing-3, 12px);
    height: 24px;
    font: var(--smrt-typography-label-large-font);
    font-weight: 600;
    border-radius: 6px;
    white-space: nowrap;
    transition: all 200ms cubic-bezier(0.2, 0, 0, 1);
  }

  .role-badge.sm {
    padding: 0 var(--smrt-spacing-2, 8px);
    height: 20px;
    font: var(--smrt-typography-label-small-font);
    font-weight: 600;
  }

  .role-badge.lg {
    padding: 0 var(--smrt-spacing-4, 16px);
    height: 32px;
    font: var(--smrt-typography-title-small-font);
    font-weight: 600;
  }

  /* Variant Colors using M3 roles */
  .variant-owner {
    background-color: var(--smrt-color-tertiary-container);
    color: var(--smrt-color-on-tertiary-container);
  }

  .variant-admin {
    background-color: var(--smrt-color-primary-container);
    color: var(--smrt-color-on-primary-container);
  }

  .variant-member {
    background-color: var(--smrt-color-secondary-container);
    color: var(--smrt-color-on-secondary-container);
  }

  .variant-default {
    background-color: var(--smrt-color-surface-variant);
    color: var(--smrt-color-on-surface-variant);
  }
</style>