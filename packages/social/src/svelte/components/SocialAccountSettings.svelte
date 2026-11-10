<script lang="ts">
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
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

<section class="smrt-social-account-settings__root" data-smrt-component="SocialAccountSettings">
  <header class="smrt-social-account-settings__toolbar" data-smrt-part="header">
    <div>
      <h2>{t(M['social.account_settings.heading'])}</h2>
      <p>{accounts.length === 1 ? t(M['social.account_settings.configured_one'], { count: accounts.length }) : t(M['social.account_settings.configured_other'], { count: accounts.length })}</p>
    </div>
    {#if onRefresh}
      <Button variant="secondary" onclick={() => onRefresh?.()} disabled={loading}>Refresh</Button>
    {/if}
  </header>

  {#if !readonly}
    <div class="smrt-social-account-settings__connect" data-smrt-part="actions" aria-label={t(M['social.account_settings.connect_aria'])}>
      {#each platforms as item}
        {#if connectHrefs[item.platform]}
          <Button variant="primary" href={connectHrefs[item.platform]}>{item.label}</Button>
        {:else}
          <Button variant="primary" disabled>{item.label}</Button>
        {/if}
      {/each}
    </div>
  {/if}

  {#if loading}
    <div class="smrt-social-account-settings__empty" data-smrt-part="empty">{t(M['social.account_settings.loading'])}</div>
  {:else if accounts.length === 0}
    <div class="smrt-social-account-settings__empty" data-smrt-part="empty">{t(M['social.account_settings.empty'])}</div>
  {:else}
    <div class="smrt-social-account-settings__list" data-smrt-part="list">
      {#each accounts as account (account.id)}
        <article class="smrt-social-account-settings__row" data-smrt-part="row" data-status={account.status}>
          <div class="smrt-social-account-settings__main" data-smrt-part="body">
            <div class="smrt-social-account-settings__title" data-smrt-part="title">
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
              <p class="smrt-social-account-settings__warning" data-smrt-part="description">Missing: {account.missingPermissions.join(', ')}</p>
            {/if}
          </div>

          <div class="smrt-social-account-settings__actions" data-smrt-part="actions">
            <span class:smrt-social-account-settings__attention={account.needsAttention} class="smrt-social-account-settings__status" data-smrt-part="badge">{statusLabel(account)}</span>
            {#if account.platformUrl}
              <Button variant="secondary" href={account.platformUrl} target="_blank" rel="noreferrer">Open</Button>
            {/if}
            {#if onTest}
              <Button variant="secondary" onclick={() => onTest?.(account)}>Test</Button>
            {/if}
            {#if !readonly && onDeactivate && account.isActive}
              <Button variant="danger" onclick={() => onDeactivate?.(account)}>Deactivate</Button>
            {/if}
          </div>
        </article>
      {/each}
    </div>
  {/if}
</section>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-social-account-settings__root {
    display: grid;
    gap: 1rem;
  }
  .smrt-social-account-settings__toolbar,
  .smrt-social-account-settings__row {
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
  .smrt-social-account-settings__connect {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .smrt-social-account-settings__list {
    display: grid;
    gap: 0.75rem;
  }
  .smrt-social-account-settings__row {
    padding: 1rem;
  }
  .smrt-social-account-settings__title {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .smrt-social-account-settings__title span,
  .smrt-social-account-settings__status {
    padding: 0.15rem 0.5rem;
  }
  .smrt-social-account-settings__actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .smrt-social-account-settings__empty {
    padding: 1.25rem;
  }
  @media (max-width: 720px) {
    .smrt-social-account-settings__toolbar,
    .smrt-social-account-settings__row {
      display: grid;
    }
    .smrt-social-account-settings__actions {
      justify-content: flex-start;
    }
  }
}

@layer smrt.theme {
  h2 {
    font-size: var(--smrt-typography-title-medium-size, 1.1rem);
    color: var(--smrt-color-on-surface);
  }
  h3 {
    font-size: var(--smrt-typography-title-medium-size, 0.95rem);
    color: var(--smrt-color-on-surface);
  }
  p {
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-body-medium-size, 0.85rem);
  }
  .smrt-social-account-settings__row {
    border: var(--smrt-hairline);
    border-radius: var(--smrt-radius-md);
    background: var(--smrt-color-surface);
  }
  .smrt-social-account-settings__title span,
  .smrt-social-account-settings__status {
    border-radius: var(--smrt-radius-full);
    background: var(--smrt-color-surface-container);
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
    text-transform: capitalize;
  }
  .smrt-social-account-settings__status.smrt-social-account-settings__attention,
  .smrt-social-account-settings__warning {
    color: var(--smrt-color-error);
  }
  .smrt-social-account-settings__empty {
    border: 1px dashed var(--smrt-color-outline-variant);
    border-radius: var(--smrt-radius-md);
    color: var(--smrt-color-on-surface-variant);
    text-align: center;
  }
}

</style>
