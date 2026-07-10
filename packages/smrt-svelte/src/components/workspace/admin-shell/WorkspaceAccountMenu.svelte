<script lang="ts">
import type { DropdownPlacement, MenuItem } from '@happyvertical/smrt-ui';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Avatar, Dropdown } from '@happyvertical/smrt-ui/ui';
import { M } from '../../../i18n/strings.workspace.js';
import type { WorkspaceAccountTenant } from './types.js';

const SIGN_OUT_ID = 'workspace-account:sign-out';
const TENANT_PREFIX = 'workspace-account:tenant:';

export interface Props {
  userName: string;
  userLabel?: string;
  avatarUrl?: string;
  tenantLabel?: string;
  roleLabel?: string;
  tenants?: WorkspaceAccountTenant[];
  currentTenantId?: string | null;
  placement?: DropdownPlacement;
  disabled?: boolean;
  onTenantSelect?: (tenantId: string) => void;
  onSignOut?: () => void;
}

let {
  userName,
  userLabel = '',
  avatarUrl,
  tenantLabel = '',
  roleLabel = '',
  tenants = [],
  currentTenantId = null,
  placement = 'top-start',
  disabled = false,
  onTenantSelect,
  onSignOut,
}: Props = $props();

const { t } = useI18n();
const identityLabel = $derived(userLabel || userName);
const activeTenantLabel = $derived(
  tenantLabel ||
    tenants.find((tenant) => tenant.id === currentTenantId)?.label ||
    '',
);
const summary = $derived(
  activeTenantLabel ? `${activeTenantLabel} · ${identityLabel}` : identityLabel,
);
const summaryTitle = $derived(
  [activeTenantLabel, roleLabel, identityLabel].filter(Boolean).join(' · '),
);
const items = $derived.by(() => {
  const menuItems: MenuItem[] = [];

  if (tenants.length > 1 && onTenantSelect) {
    for (const tenant of tenants) {
      const isCurrent = tenant.id === currentTenantId;
      const detail = tenant.roleLabel ? ` — ${tenant.roleLabel}` : '';
      menuItems.push({
        id: `${TENANT_PREFIX}${tenant.id}`,
        label: isCurrent
          ? `${t(M['ui.workspace_account_menu.current_tenant'], {
              tenant: tenant.label,
            })}${detail}`
          : `${tenant.label}${detail}`,
        disabled: tenant.disabled || isCurrent,
      });
    }
  }

  if (onSignOut) {
    menuItems.push({
      id: SIGN_OUT_ID,
      label: t(M['ui.workspace_account_menu.sign_out']),
    });
  }

  return menuItems;
});

function handleSelect(id: string): void {
  if (id === SIGN_OUT_ID) {
    onSignOut?.();
    return;
  }
  if (id.startsWith(TENANT_PREFIX)) {
    onTenantSelect?.(id.slice(TENANT_PREFIX.length));
  }
}
</script>

<div class="smrt-workspace-account-menu" title={summaryTitle}>
  <Dropdown
    {items}
    {placement}
    onselect={handleSelect}
    disabled={disabled || items.length === 0}
  >
    {#snippet trigger()}
      <span class="smrt-workspace-account-menu__open">
        {t(M['ui.workspace_account_menu.open'])}
      </span>
      <Avatar src={avatarUrl} name={userName} size="sm" aria-hidden="true" />
      <span class="smrt-workspace-account-menu__summary">{summary}</span>
      <span class="smrt-workspace-account-menu__indicator" aria-hidden="true">•••</span>
    {/snippet}
  </Dropdown>
</div>

<style>
  .smrt-workspace-account-menu {
    min-width: 0;
    width: 100%;
  }

  .smrt-workspace-account-menu :global(.dropdown) {
    display: flex;
    width: 100%;
  }

  .smrt-workspace-account-menu :global(.dropdown__trigger) {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: var(--smrt-spacing-2);
    width: 100%;
    min-width: 0;
    min-height: 2.75rem;
    padding: var(--smrt-spacing-2);
    border-radius: var(--smrt-radius-large);
    text-align: start;
  }

  .smrt-workspace-account-menu :global(.dropdown__menu) {
    box-sizing: border-box;
    width: 100%;
    min-width: 12rem;
    max-height: min(24rem, 70vh);
    overflow-y: auto;
  }

  .smrt-workspace-account-menu__summary {
    min-width: 0;
    overflow: hidden;
    color: var(--smrt-color-on-surface);
    font-size: var(--smrt-typography-body-small-size);
    font-weight: var(--smrt-typography-weight-medium);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .smrt-workspace-account-menu__indicator {
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-label-small-size);
    letter-spacing: 0.08em;
  }

  .smrt-workspace-account-menu__open {
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
