<script lang="ts">
import { useI18n } from '@happyvertical/smrt-svelte/i18n';
import type { SocialPlatformType } from '../../social-account.js';
import { M } from '../i18n.js';
import type { SocialAccountSettingsItem } from '../types.js';

const { t } = useI18n();

let {
  accounts = [],
  loading = false,
  readonly = false,
  connectHrefs = {},
  onRefresh,
  onTest,
  onDeactivate,
}: {
  accounts?: SocialAccountSettingsItem[];
  loading?: boolean;
  readonly?: boolean;
  connectHrefs?: Partial<Record<SocialPlatformType, string>>;
  onRefresh?: () => void | Promise<void>;
  onTest?: (account: SocialAccountSettingsItem) => void | Promise<void>;
  onDeactivate?: (account: SocialAccountSettingsItem) => void | Promise<void>;
} = $props();

const platforms: Array<{ platform: SocialPlatformType; label: string }> = [
  { platform: 'youtube', label: 'YouTube' },
  { platform: 'facebook', label: 'Facebook Page' },
  { platform: 'threads', label: 'Threads' },
  { platform: 'x', label: 'X' },
  { platform: 'bluesky', label: 'Bluesky' },
];

function statusLabel(account: SocialAccountSettingsItem): string {
  if (!account.isActive) return 'inactive';
  if (account.needsAttention) return 'needs attention';
  return account.status.replaceAll('_', ' ');
}
</script>

<section class="social-settings">
  <header class="toolbar">
    <div>
      <h2>{t(M['social.account_settings.heading'])}</h2>
      <p>{accounts.length === 1 ? t(M['social.account_settings.configured_one'], { count: accounts.length }) : t(M['social.account_settings.configured_other'], { count: accounts.length })}</p>
    </div>
    {#if onRefresh}
      <button type="button" class="secondary" onclick={() => onRefresh?.()} disabled={loading}>Refresh</button>
    {/if}
  </header>

  {#if !readonly}
    <div class="connect-row" aria-label={t(M['social.account_settings.connect_aria'])}>
      {#each platforms as item}
        {#if connectHrefs[item.platform]}
          <a class="connect-button" href={connectHrefs[item.platform]}>{item.label}</a>
        {:else}
          <button type="button" class="connect-button" disabled>{item.label}</button>
        {/if}
      {/each}
    </div>
  {/if}

  {#if loading}
    <div class="empty">{t(M['social.account_settings.loading'])}</div>
  {:else if accounts.length === 0}
    <div class="empty">{t(M['social.account_settings.empty'])}</div>
  {:else}
    <div class="account-list">
      {#each accounts as account (account.id)}
        <article class="account-row" data-status={account.status}>
          <div class="account-main">
            <div class="account-title">
              <h3>{account.name}</h3>
              <span>{account.platform}</span>
            </div>
            {#if account.platformUsername}
              <p>@{account.platformUsername}</p>
            {/if}
            {#if account.publishMode}
              <p>
                Mode: {account.publishMode.replaceAll('_', ' ')}
                {account.publishMode === 'public' && !account.publicPublishingAllowed ? ' (blocked)' : ''}
              </p>
            {/if}
            {#if account.missingPermissions?.length}
              <p class="warning">Missing: {account.missingPermissions.join(', ')}</p>
            {/if}
          </div>

          <div class="account-actions">
            <span class:attention={account.needsAttention} class="status">{statusLabel(account)}</span>
            {#if account.platformUrl}
              <a class="secondary" href={account.platformUrl} target="_blank" rel="noreferrer">Open</a>
            {/if}
            {#if onTest}
              <button type="button" class="secondary" onclick={() => onTest?.(account)}>Test</button>
            {/if}
            {#if !readonly && onDeactivate && account.isActive}
              <button type="button" class="danger" onclick={() => onDeactivate?.(account)}>Deactivate</button>
            {/if}
          </div>
        </article>
      {/each}
    </div>
  {/if}
</section>

<style>
  .social-settings {
    display: grid;
    gap: 1rem;
  }

  .toolbar,
  .account-row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1rem;
  }

  h2,
  h3,
  p {
    margin: 0;
  }

  h2 {
    font-size: var(--smrt-typography-title-medium-size, 1.1rem);
    color: var(--smrt-color-on-surface, #111827);
  }

  h3 {
    font-size: var(--smrt-typography-title-medium-size, 0.95rem);
    color: var(--smrt-color-on-surface, #111827);
  }

  p {
    color: var(--smrt-color-on-surface-variant, #6b7280);
    font-size: var(--smrt-typography-body-medium-size, 0.85rem);
  }

  .connect-row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  .account-list {
    display: grid;
    gap: 0.75rem;
  }

  .account-row {
    border: 1px solid var(--smrt-color-outline-variant, #d1d5db);
    border-radius: var(--smrt-radius-md, 8px);
    background: var(--smrt-color-surface, #fff);
    padding: 1rem;
  }

  .account-title {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .account-title span,
  .status {
    border-radius: var(--smrt-radius-full, 9999px);
    background: var(--smrt-color-surface-container, #f3f4f6);
    color: var(--smrt-color-on-surface-variant, #4b5563);
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
    padding: 0.15rem 0.5rem;
    text-transform: capitalize;
  }

  .status.attention,
  .warning {
    color: var(--smrt-color-error, #b91c1c);
  }

  .account-actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  button,
  a {
    border: 1px solid var(--smrt-color-outline-variant, #d1d5db);
    border-radius: var(--smrt-radius-md, 8px);
    background: var(--smrt-color-surface, #fff);
    color: var(--smrt-color-on-surface, #111827);
    cursor: pointer;
    font: inherit;
    font-size: var(--smrt-typography-label-large-size, 0.82rem);
    line-height: 1;
    padding: 0.55rem 0.7rem;
    text-decoration: none;
  }

  button:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }

  .connect-button {
    background: var(--smrt-color-primary, #2563eb);
    border-color: var(--smrt-color-primary, #2563eb);
    color: var(--smrt-color-on-primary, #fff);
  }

  .secondary {
    background: var(--smrt-color-surface-container, #f3f4f6);
  }

  .danger {
    color: var(--smrt-color-error, #b91c1c);
  }

  .empty {
    border: 1px dashed var(--smrt-color-outline-variant, #d1d5db);
    border-radius: var(--smrt-radius-md, 8px);
    color: var(--smrt-color-on-surface-variant, #6b7280);
    padding: 1.25rem;
    text-align: center;
  }

  @media (max-width: 720px) {
    .toolbar,
    .account-row {
      display: grid;
    }

    .account-actions {
      justify-content: flex-start;
    }
  }
</style>
