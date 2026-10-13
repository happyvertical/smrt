<script lang="ts">
import type { DropdownPlacement } from '@happyvertical/smrt-ui';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Avatar } from '@happyvertical/smrt-ui/ui';
import { tick } from 'svelte';
import { M } from '../../../i18n/strings.workspace.js';
import type { WorkspaceAccountTenant } from './types.js';

const SIGN_OUT_ID = 'workspace-account:sign-out';
const SETTINGS_ID = 'workspace-account:settings';
const TENANT_PREFIX = 'workspace-account:tenant:';

export interface Props {
  /** Username or identifier displayed in the account menu. */
  userName: string;
  /** Target density; omit to inherit the theme density. */
  density?: 'comfortable' | 'touch';
  /** Show only the avatar while preserving the full accessible account name. */
  compact?: boolean;
  /** Custom display name for the user, falls back to userName. */
  userLabel?: string;
  /** Email shown under the name at the top of the open menu. */
  email?: string;
  /** URL for the user's avatar image. */
  avatarUrl?: string;
  /** Custom display name for the current tenant. */
  tenantLabel?: string;
  /** User's role or permission level. */
  roleLabel?: string;
  /** List of available tenants to switch between. */
  tenants?: WorkspaceAccountTenant[];
  /** ID of the currently selected tenant. */
  currentTenantId?: string | null;
  /**
   * Where the menu appears relative to the trigger. `inline-end` opens beside
   * the trigger, bottom-aligned (a compact trigger in a narrow rail).
   */
  placement?: DropdownPlacement | 'inline-end';
  /** Disables the account menu button. */
  disabled?: boolean;
  /** Adds a Settings link to the menu. */
  settingsHref?: string;
  /**
   * Adds a Sign out link (a GET navigation) to the menu. Never point it at a
   * POST-only route such as the runtime's `/sign-out`; use `onSignOut` for
   * those. Use `onSignOut` for a callback.
   */
  signOutHref?: string;
  /** Called when the user selects a different tenant. */
  onTenantSelect?: (tenantId: string) => void;
  /**
   * Called when the user clicks sign out. May return a promise: the item shows
   * a busy state (`aria-busy`, disabled against double submit) while it is
   * pending, the menu closes on success, and stays open with an inline error
   * when it rejects.
   */
  onSignOut?: () => unknown;
}

let {
  userName,
  density,
  compact = false,
  userLabel = '',
  email = '',
  avatarUrl,
  tenantLabel = '',
  roleLabel = '',
  tenants = [],
  currentTenantId = null,
  placement = 'top-start',
  disabled = false,
  settingsHref,
  signOutHref,
  onTenantSelect,
  onSignOut,
}: Props = $props();

interface Entry {
  id: string;
  label: string;
  disabled?: boolean;
  href?: string;
}

const { t } = useI18n();
const instanceId = $props.id();
const menuId = `smrt-account-menu-${instanceId}`;
const identityLabel = $derived(userLabel || userName);
const activeTenantLabel = $derived(
  tenantLabel ||
    tenants.find((tenant) => tenant.id === currentTenantId)?.label ||
    '',
);
const accountContext = $derived(
  [activeTenantLabel, roleLabel].filter(Boolean).join(' · '),
);
const summaryTitle = $derived(
  [identityLabel, activeTenantLabel, roleLabel].filter(Boolean).join(' · '),
);
const showEmail = $derived(Boolean(email) && email !== identityLabel);
const entries = $derived.by(() => {
  const out: Entry[] = [];

  if (tenants.length > 1 && onTenantSelect) {
    for (const tenant of tenants) {
      const isCurrent = tenant.id === currentTenantId;
      const detail = tenant.roleLabel ? ` — ${tenant.roleLabel}` : '';
      out.push({
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

  if (settingsHref) {
    out.push({
      id: SETTINGS_ID,
      label: t(M['ui.app_shell.account_settings']),
      href: settingsHref,
    });
  }

  if (onSignOut || signOutHref) {
    out.push({
      id: SIGN_OUT_ID,
      label: t(M['ui.workspace_account_menu.sign_out']),
      href: onSignOut ? undefined : signOutHref,
    });
  }

  return out;
});

let open = $state(false);
let signingOut = $state(false);
let signOutFailed = $state(false);
let wrapEl = $state<HTMLElement | null>(null);
let triggerEl = $state<HTMLButtonElement | null>(null);
let itemEls = $state<Array<HTMLElement | null>>([]);
const enabled = $derived(
  entries.map((entry, i) => (entry.disabled ? -1 : i)).filter((i) => i >= 0),
);

async function openMenu(focusLast = false) {
  open = true;
  await tick();
  const target = focusLast ? enabled[enabled.length - 1] : enabled[0];
  if (target != null) itemEls[target]?.focus();
}

function closeMenu(refocus = true) {
  open = false;
  if (refocus) triggerEl?.focus();
}

async function runSignOut() {
  if (signingOut || !onSignOut) return;
  signingOut = true;
  signOutFailed = false;
  try {
    // A synchronous callback closes the menu in the same turn.
    const pending = onSignOut();
    // Any return value is accepted (a plain `() => void` callback may return
    // something); only a thenable is awaited.
    if (
      typeof pending === 'object' &&
      pending !== null &&
      typeof (pending as PromiseLike<unknown>).then === 'function'
    ) {
      await pending;
    }
  } catch {
    signOutFailed = true;
    signingOut = false;
    return;
  }
  signingOut = false;
  closeMenu();
}

function select(entry: Entry) {
  if (entry.disabled) return;
  if (entry.id === SIGN_OUT_ID && onSignOut) {
    // The callback owns the menu: it closes on success only.
    void runSignOut();
    return;
  }
  if (entry.id.startsWith(TENANT_PREFIX)) {
    onTenantSelect?.(entry.id.slice(TENANT_PREFIX.length));
  }
  // A link navigates on its own: leave focus to the destination.
  closeMenu(!entry.href);
}

function focusByOffset(offset: number) {
  if (enabled.length === 0) return;
  const current = itemEls.indexOf(document.activeElement as HTMLElement);
  const pos = enabled.indexOf(current);
  itemEls[enabled[(pos + offset + enabled.length) % enabled.length]]?.focus();
}

function onTriggerKeydown(event: KeyboardEvent) {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    openMenu(event.key === 'ArrowUp');
  }
}

function onMenuKeydown(event: KeyboardEvent) {
  switch (event.key) {
    case 'ArrowDown':
      event.preventDefault();
      focusByOffset(1);
      break;
    case 'ArrowUp':
      event.preventDefault();
      focusByOffset(-1);
      break;
    case 'Home':
      event.preventDefault();
      itemEls[enabled[0]]?.focus();
      break;
    case 'End':
      event.preventDefault();
      itemEls[enabled[enabled.length - 1]]?.focus();
      break;
    case 'Escape':
      event.preventDefault();
      event.stopPropagation();
      closeMenu();
      break;
    case 'Tab':
      closeMenu(false);
      break;
  }
}

// Dismiss on an outside click while open.
$effect(() => {
  if (!open) return;
  const onDocPointer = (event: MouseEvent) => {
    if (wrapEl && !wrapEl.contains(event.target as Node)) closeMenu(false);
  };
  document.addEventListener('click', onDocPointer, true);
  return () => document.removeEventListener('click', onDocPointer, true);
});
</script>

<div
  bind:this={wrapEl}
  data-density={density}
  data-compact={compact ? '' : undefined}
  class="smrt-workspace-account-menu"
  title={summaryTitle}
  data-smrt-component="WorkspaceAccountMenu"
>
  <!-- raw-primitive-allow: menu trigger owns aria-haspopup/aria-expanded/aria-controls and an avatar + identity layout the Button primitive does not model -->
  <button
    bind:this={triggerEl}
    type="button"
    class="smrt-workspace-account-menu__trigger"
    data-smrt-part="trigger"
    aria-label={compact ? `${t(M['ui.workspace_account_menu.open'])} ${summaryTitle}` : undefined}
    aria-haspopup="menu"
    aria-expanded={open}
    aria-controls={open ? menuId : undefined}
    disabled={disabled || entries.length === 0}
    onclick={() => (open ? closeMenu(false) : openMenu())}
    onkeydown={onTriggerKeydown}
  >
    <span class="smrt-workspace-account-menu__open">
      {t(M['ui.workspace_account_menu.open'])}
    </span>
    <Avatar src={avatarUrl} name={userName} size="sm" aria-hidden="true" />
    <span class="smrt-workspace-account-menu__identity">
      <span class="smrt-workspace-account-menu__summary">{identityLabel}</span>
      {#if accountContext}
        <span class="smrt-workspace-account-menu__context">{accountContext}</span>
      {/if}
    </span>
    <span class="smrt-workspace-account-menu__indicator" aria-hidden="true">•••</span>
  </button>

  {#if open}
    <div class="smrt-workspace-account-menu__popover smrt-workspace-account-menu__popover--{placement}" data-smrt-part="panel">
      {#if identityLabel || showEmail}
        <div class="smrt-workspace-account-menu__header">
          <span class="smrt-workspace-account-menu__name">{identityLabel}</span>
          {#if showEmail}<span class="smrt-workspace-account-menu__email">{email}</span>{/if}
        </div>
      {/if}
      <!-- svelte-ignore a11y_interactive_supports_focus -->
      <div id={menuId} role="menu" tabindex="-1" class="smrt-workspace-account-menu__menu" aria-label={t(M['ui.app_shell.account_item'])} onkeydown={onMenuKeydown}>
        {#each entries as entry, i (entry.id)}
          {#if entry.href}
            <a
              bind:this={itemEls[i]}
              role="menuitem"
              class="smrt-workspace-account-menu__item"
              href={entry.href}
              tabindex="-1"
              onclick={() => select(entry)}
            >{entry.label}</a>
          {:else}
            <!-- raw-primitive-allow: role="menuitem" with roving tabindex inside a role="menu"; not a content button -->
            <button
              bind:this={itemEls[i]}
              type="button"
              role="menuitem"
              class="smrt-workspace-account-menu__item"
              disabled={entry.disabled || (entry.id === SIGN_OUT_ID && signingOut)}
              aria-busy={entry.id === SIGN_OUT_ID && signingOut ? 'true' : undefined}
              tabindex="-1"
              onclick={() => select(entry)}
            >{entry.label}</button>
          {/if}
        {/each}
        {#if signOutFailed}
          <p class="smrt-workspace-account-menu__error" role="alert" data-smrt-part="error">
            {t(M['ui.shell_settings.sign_out_failed'])}
          </p>
        {/if}
      </div>
    </div>
  {/if}
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.theme {
  .smrt-workspace-account-menu {
    position: relative;
    display: flex;
    min-width: 0;
    width: 100%;
  }

  .smrt-workspace-account-menu[data-density='touch'] {
    --smrt-control-target-min: var(--smrt-touch-target-min);
  }
  .smrt-workspace-account-menu[data-density='comfortable'] {
    --smrt-control-target-min: 0px;
  }

  .smrt-workspace-account-menu__trigger {
    appearance: none;
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: var(--smrt-spacing-2);
    box-sizing: border-box;
    width: 100%;
    min-width: 0;
    min-height: max(2.75rem, var(--smrt-control-target-min, 0px));
    padding: var(--smrt-spacing-2);
    position: relative;
    border: var(--smrt-hairline);
    border-radius: var(--smrt-control-radius);
    background: var(--smrt-surface-control);
    color: var(--smrt-color-on-surface);
    font: inherit;
    text-align: start;
    cursor: pointer;
  }
  /* State layer: a currentColor veil over the trigger. */
  .smrt-workspace-account-menu__trigger::after {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: inherit;
    background: currentColor;
    opacity: 0;
    pointer-events: none;
  }
  .smrt-workspace-account-menu__trigger:hover:not(:disabled)::after {
    opacity: var(--smrt-state-hover);
  }
  .smrt-workspace-account-menu__trigger[aria-expanded='true']::after {
    opacity: var(--smrt-state-selected);
  }
  .smrt-workspace-account-menu__trigger:active:not(:disabled)::after {
    opacity: var(--smrt-state-pressed);
  }
  .smrt-workspace-account-menu__trigger:focus-visible {
    outline: var(--smrt-focus-ring-width) solid var(--smrt-focus-ring-color);
    outline-offset: var(--smrt-focus-ring-offset);
  }
  .smrt-workspace-account-menu__trigger:disabled {
    opacity: var(--smrt-state-disabled);
    cursor: default;
  }

  .smrt-workspace-account-menu[data-compact] {
    width: auto;
  }
  .smrt-workspace-account-menu[data-compact] .smrt-workspace-account-menu__trigger {
    display: grid;
    place-items: center;
    grid-template-columns: minmax(0, 1fr);
    min-width: max(2.75rem, var(--smrt-control-target-min, 0px));
    padding: var(--smrt-spacing-1);
    border-color: transparent;
    border-radius: var(--smrt-radius-full);
    background: transparent;
  }
  .smrt-workspace-account-menu[data-compact] .smrt-workspace-account-menu__identity,
  .smrt-workspace-account-menu[data-compact] .smrt-workspace-account-menu__indicator {
    display: none;
  }

  .smrt-workspace-account-menu__popover {
    position: absolute;
    z-index: var(--smrt-z-index-dropdown);
    box-sizing: border-box;
    min-width: 12rem;
    max-height: min(24rem, 70vh);
    overflow-y: auto;
    margin: var(--smrt-spacing-1) 0;
    padding: var(--smrt-spacing-1);
    border: var(--smrt-hairline);
    border-radius: var(--smrt-radius-medium);
    background: var(--smrt-surface-raised);
    box-shadow: var(--smrt-elevation-3), var(--smrt-inset-highlight);
  }
  .smrt-workspace-account-menu__popover--bottom-start { inset-block-start: 100%; inset-inline-start: 0; }
  .smrt-workspace-account-menu__popover--bottom-end { inset-block-start: 100%; inset-inline-end: 0; }
  .smrt-workspace-account-menu__popover--top-start { inset-block-end: 100%; inset-inline-start: 0; }
  .smrt-workspace-account-menu__popover--top-end { inset-block-end: 100%; inset-inline-end: 0; }
  .smrt-workspace-account-menu__popover--inline-end {
    inset-block-end: 0;
    inset-inline-start: 100%;
    margin: 0 var(--smrt-spacing-2);
  }

  .smrt-workspace-account-menu__header {
    display: grid;
    gap: var(--smrt-spacing-1);
    padding: var(--smrt-spacing-2) var(--smrt-spacing-3);
    border-block-end: var(--smrt-hairline);
    margin-block-end: var(--smrt-spacing-1);
  }
  .smrt-workspace-account-menu__name {
    color: var(--smrt-color-on-surface);
    font-size: var(--smrt-typography-body-small-size);
    font-weight: var(--smrt-typography-weight-medium);
    overflow-wrap: anywhere;
  }
  .smrt-workspace-account-menu__email {
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-label-small-size);
    overflow-wrap: anywhere;
  }

  .smrt-workspace-account-menu__menu {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-1);
  }
  .smrt-workspace-account-menu__item {
    appearance: none;
    display: flex;
    align-items: center;
    box-sizing: border-box;
    min-block-size: max(2.75rem, var(--smrt-control-target-min, 0px));
    padding: var(--smrt-spacing-2) var(--smrt-spacing-3);
    border: none;
    border-radius: var(--smrt-control-radius-small);
    background: none;
    color: var(--smrt-color-on-surface);
    font: inherit;
    text-align: start;
    text-decoration: none;
    white-space: nowrap;
    cursor: pointer;
  }
  .smrt-workspace-account-menu__item:hover:not(:disabled) {
    background: color-mix(in srgb, currentColor calc(var(--smrt-state-hover) * 100%), transparent);
  }
  .smrt-workspace-account-menu__item:active:not(:disabled) {
    background: color-mix(in srgb, currentColor calc(var(--smrt-state-pressed) * 100%), transparent);
  }
  .smrt-workspace-account-menu__item:focus-visible {
    outline: var(--smrt-focus-ring-width) solid var(--smrt-focus-ring-color);
    outline-offset: calc(-1 * var(--smrt-focus-ring-width));
  }
  .smrt-workspace-account-menu__item:disabled {
    opacity: var(--smrt-state-disabled);
    cursor: default;
  }

  .smrt-workspace-account-menu__error {
    margin: 0;
    padding: var(--smrt-spacing-2) var(--smrt-spacing-3);
    color: var(--smrt-color-error);
    font-size: var(--smrt-typography-label-small-size);
  }

  .smrt-workspace-account-menu__identity {
    display: grid;
    gap: var(--smrt-spacing-1);
    min-width: 0;
  }

  .smrt-workspace-account-menu__summary,
  .smrt-workspace-account-menu__context {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .smrt-workspace-account-menu__summary {
    color: var(--smrt-color-on-surface);
    font-size: var(--smrt-typography-body-small-size);
    font-weight: var(--smrt-typography-weight-medium);
  }

  .smrt-workspace-account-menu__context {
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-label-small-size);
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
  /* Forced colors (#3908): selected and open states keep a non-colour indicator. */
  @media (forced-colors: active) {
    .smrt-workspace-account-menu__trigger[aria-expanded='true']:not(:focus-visible) { outline: var(--smrt-focus-ring-width) solid Highlight; outline-offset: calc(-1 * var(--smrt-focus-ring-width)); }
    .smrt-workspace-account-menu__trigger:disabled { opacity: 1; color: GrayText; }
  }
}
</style>
