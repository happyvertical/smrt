<script lang="ts">
/**
 * RoleBadge - Role label component
 * refactored for Material 3
 */
import type { Role } from '@happyvertical/smrt-types';

export interface Props {
  /** The role object whose name is displayed. */
  role: Role;
  /** Visual size of the badge. */
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
  class="smrt-role-badge__root smrt-role-badge__{variantClass}"
  class:smrt-role-badge__sm={size === 'sm'}
  class:smrt-role-badge__lg={size === 'lg'} data-smrt-component="RoleBadge"
>
  {role.name}
</span>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-role-badge__root {
    display: inline-flex;
    align-items: center;
    padding: 0 var(--smrt-spacing-3);
    height: 24px;
    white-space: nowrap;
  }
  .smrt-role-badge__root.smrt-role-badge__sm {
    padding: 0 var(--smrt-spacing-2);
    height: 20px;
  }
  .smrt-role-badge__root.smrt-role-badge__lg {
    padding: 0 var(--smrt-spacing-4);
    height: 32px;
  }
}

@layer smrt.theme {
  .smrt-role-badge__root {
    font: var(--smrt-typography-label-large-font);
    font-weight: var(--smrt-typography-weight-semibold, 600);
    border-radius: var(--smrt-radius-md);
    transition: all 200ms cubic-bezier(0.2, 0, 0, 1);
  }
  .smrt-role-badge__root.smrt-role-badge__sm {
    font: var(--smrt-typography-label-small-font);
    font-weight: var(--smrt-typography-weight-semibold, 600);
  }
  .smrt-role-badge__root.smrt-role-badge__lg {
    font: var(--smrt-typography-title-small-font);
    font-weight: var(--smrt-typography-weight-semibold, 600);
  }
  /* Variant Colors using M3 roles */
  .smrt-role-badge__variant-owner {
    background-color: var(--smrt-color-tertiary-container);
    color: var(--smrt-color-on-tertiary-container);
  }
  .smrt-role-badge__variant-admin {
    background-color: var(--smrt-color-primary-container);
    color: var(--smrt-color-on-primary-container);
  }
  .smrt-role-badge__variant-member {
    background-color: var(--smrt-color-secondary-container);
    color: var(--smrt-color-on-secondary-container);
  }
  .smrt-role-badge__variant-default {
    background-color: var(--smrt-color-surface-variant);
    color: var(--smrt-color-on-surface-variant);
  }
}

</style>