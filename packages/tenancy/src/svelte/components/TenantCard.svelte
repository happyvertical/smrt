<script lang="ts">
/**
 * TenantCard - Tenant information and management
 * refactored for Material 3
 */

import type { Tenant } from '@happyvertical/smrt-types';
import { Icon, ripple } from '@happyvertical/smrt-ui';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import { M } from '../i18n.js';

export interface Props {
  /** The tenant to display. */
  tenant: Tenant;
  /** Number of members in the tenant. */
  memberCount?: number;
  /** Fired when the card is clicked. */
  onclick?: () => void;
  /** Highlights the card when true. */
  selected?: boolean;
  /** Shows edit and delete buttons when true. */
  actions?: boolean;
  /** Fired when the user clicks the edit button. */
  onedit?: () => void;
  /** Fired when the user clicks the delete button. */
  ondelete?: () => void;
}

const {
  tenant,
  memberCount,
  onclick,
  selected = false,
  actions = false,
  onedit,
  ondelete,
}: Props = $props();

const { t } = useI18n();

const statusClass = $derived.by(() => {
  switch (tenant.status) {
    case 'active':
      return 'smrt-tenant-card__status-active';
    case 'suspended':
      return 'smrt-tenant-card__status-error';
    case 'archived':
      return 'smrt-tenant-card__status-disabled';
    default:
      return '';
  }
});

function getInitials(name: string): string {
  return name
    .split(' ')
    .map((part) => part[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
}

function getColor(name: string): string {
  const colors = [
    '#3b82f6',
    '#8b5cf6',
    '#ec4899',
    '#f97316',
    '#22c55e',
    '#06b6d4',
    '#6366f1',
    '#14b8a6',
  ];
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
}
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
  class="smrt-tenant-card__root"
  class:smrt-tenant-card__clickable={!!onclick}
  class:smrt-tenant-card__selected={selected}
  role={onclick ? 'button' : undefined}
  tabindex={onclick ? 0 : undefined}
  onclick={onclick}
  onkeydown={(event: KeyboardEvent) => event.key === 'Enter' && onclick?.()}
  use:ripple data-smrt-component="TenantCard"
>
  <div class="smrt-tenant-card__avatar" data-smrt-part="avatar" style:background-color={getColor(tenant.name ?? '')}>
    {getInitials(tenant.name ?? 'T')}
  </div>

  <div class="smrt-tenant-card__info" data-smrt-part="body">
    <div class="smrt-tenant-card__header" data-smrt-part="header">
      <span class="smrt-tenant-card__name" data-smrt-part="title">{tenant.name}</span>
      <span class="smrt-tenant-card__status {statusClass}" data-smrt-part="badge">{tenant.status}</span>
    </div>

    {#if tenant.slug}
      <div class="smrt-tenant-card__slug" data-smrt-part="slug">{tenant.slug}</div>
    {/if}

    {#if memberCount !== undefined}
      <div class="smrt-tenant-card__meta" data-smrt-part="meta">
        <span class="smrt-tenant-card__members">{memberCount} member{memberCount === 1 ? '' : 's'}</span>
      </div>
    {/if}
  </div>

  {#if actions && (onedit || ondelete)}
    <div class="smrt-tenant-card__actions" data-smrt-part="actions">
      {#if onedit}
        <Button
          variant="ghost"
          class="smrt-tenant-card__action"
          onclick={(event: MouseEvent) => { event.stopPropagation(); onedit?.(); }}
          aria-label={t(M['tenancy.tenant_card.edit'])}
        >
          <Icon name="menu" size={18} />
        </Button>
      {/if}
      {#if ondelete}
        <Button
          variant="ghost"
          class="smrt-tenant-card__action smrt-tenant-card__action--danger"
          onclick={(event: MouseEvent) => { event.stopPropagation(); ondelete?.(); }}
          aria-label={t(M['tenancy.tenant_card.delete'])}
        >
          <Icon name="close" size={18} />
        </Button>
      {/if}
    </div>
  {/if}
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-tenant-card__root {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-4);
    padding: var(--smrt-spacing-4);
    position: relative;
    overflow: hidden;
  }
  .smrt-tenant-card__root.smrt-tenant-card__clickable {
    cursor: pointer;
  }
  .smrt-tenant-card__avatar {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 48px;
    height: 48px;
    flex-shrink: 0;
  }
  .smrt-tenant-card__info {
    flex: 1;
    min-width: 0;
  }
  .smrt-tenant-card__header {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-2);
  }
  .smrt-tenant-card__name {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .smrt-tenant-card__status {
    padding: 0 var(--smrt-spacing-2);
    height: 18px;
    display: inline-flex;
    align-items: center;
    flex-shrink: 0;
  }
  .smrt-tenant-card__slug {
    margin-top: var(--smrt-spacing-1);
  }
  .smrt-tenant-card__meta {
    margin-top: var(--smrt-spacing-1);
  }
  .smrt-tenant-card__actions {
    display: flex;
    gap: var(--smrt-spacing-1);
    flex-shrink: 0;
  }
  /*
  * The action buttons now render through smrt-ui's <Button variant="ghost">.
  * Svelte scopes `.smrt-tenant-card__action` to this component, but the <button> is emitted
  * inside the Button child, so a plain `.smrt-tenant-card__action {}` rule would not match —
  * `.smrt-tenant-card__actions :global(.smrt-tenant-card__action)` keeps the scope anchor on `.smrt-tenant-card__actions` (a real
  * element here) and pierces into the child (issue #1589). These override only
  * sizing/shape/color (higher specificity than Button's base rules); ghost owns
  * the transparent background + hover layer. The delete button's modifier class
  * is `smrt-tenant-card__action--danger`, NOT `danger`, so it never collides with Button's own
  * `.danger` variant class (which would otherwise apply the red-filled variant).
  */
  .smrt-tenant-card__actions :global(.smrt-tenant-card__action) {
    width: 32px;
    height: 32px;
    padding: 0;
  }
}

@layer smrt.theme {
  .smrt-tenant-card__root {
    background-color: var(--smrt-color-surface-container-low);
    border-radius: var(--smrt-radius-lg);
    color: var(--smrt-color-on-surface);
    transition: all 200ms cubic-bezier(0.2, 0, 0, 1);
    box-shadow: var(--smrt-elevation-1);
  }
  .smrt-tenant-card__root.smrt-tenant-card__clickable:hover {
    background-color: var(--smrt-color-surface-container-high);
    box-shadow: var(--smrt-elevation-2);
  }
  .smrt-tenant-card__root.smrt-tenant-card__selected {
    background-color: var(--smrt-color-secondary-container);
    color: var(--smrt-color-on-secondary-container);
  }
  .smrt-tenant-card__avatar {
    border-radius: var(--smrt-radius-lg);
    color: white;
    font: var(--smrt-typography-title-medium-font);
    font-weight: var(--smrt-typography-weight-semibold, 600);
  }
  .smrt-tenant-card__name {
    font: var(--smrt-typography-title-small-font);
    font-weight: var(--smrt-typography-weight-semibold, 600);
  }
  .smrt-tenant-card__status {
    font: var(--smrt-typography-label-small-font);
    border-radius: var(--smrt-radius-md);
    text-transform: uppercase;
    font-weight: var(--smrt-typography-weight-semibold, 600);
  }
  .smrt-tenant-card__status-active {
    background-color: var(--smrt-color-primary-container);
    color: var(--smrt-color-on-primary-container);
  }
  .smrt-tenant-card__status-error {
    background-color: var(--smrt-color-error-container);
    color: var(--smrt-color-on-error-container);
  }
  .smrt-tenant-card__status-disabled {
    background-color: var(--smrt-color-surface-variant);
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-tenant-card__slug {
    font: var(--smrt-typography-body-small-font);
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-tenant-card__selected .smrt-tenant-card__slug {
    color: var(--smrt-color-on-secondary-container);
    opacity: 0.8;
  }
  .smrt-tenant-card__members {
    font: var(--smrt-typography-label-small-font);
    color: var(--smrt-color-on-surface-variant);
  }
  /*
  * The action buttons now render through smrt-ui's <Button variant="ghost">.
  * Svelte scopes `.smrt-tenant-card__action` to this component, but the <button> is emitted
  * inside the Button child, so a plain `.smrt-tenant-card__action {}` rule would not match —
  * `.smrt-tenant-card__actions :global(.smrt-tenant-card__action)` keeps the scope anchor on `.smrt-tenant-card__actions` (a real
  * element here) and pierces into the child (issue #1589). These override only
  * sizing/shape/color (higher specificity than Button's base rules); ghost owns
  * the transparent background + hover layer. The delete button's modifier class
  * is `smrt-tenant-card__action--danger`, NOT `danger`, so it never collides with Button's own
  * `.danger` variant class (which would otherwise apply the red-filled variant).
  */
  .smrt-tenant-card__actions :global(.smrt-tenant-card__action) {
    border-radius: var(--smrt-radius-full);
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-tenant-card__actions :global(.smrt-tenant-card__action--danger):hover {
    color: var(--smrt-color-error);
  }
}

</style>
