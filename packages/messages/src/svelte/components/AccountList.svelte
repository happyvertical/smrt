<script lang="ts">
/**
 * AccountList - Account management list
 */
import { useI18n } from '@happyvertical/smrt-svelte/i18n';
import { Grid } from '@happyvertical/smrt-svelte/layout';
import { M } from '../i18n.js';
import type { AccountData } from '../types.js';
import AccountCard from './AccountCard.svelte';

const { t } = useI18n();

export interface Props {
  accounts: AccountData[];
  loading?: boolean;
  onaccountclick?: (account: AccountData) => void;
  onsync?: (account: AccountData) => void;
  onremove?: (account: AccountData) => void;
}

const {
  accounts,
  loading = false,
  onaccountclick,
  onsync,
  onremove,
}: Props = $props();

function handleAccountClick(account: AccountData) {
  onaccountclick?.(account);
}

function handleAccountKeydown(event: KeyboardEvent, account: AccountData) {
  if (event.target !== event.currentTarget) {
    return;
  }

  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    handleAccountClick(account);
  }
}
</script>

<div class="account-list" role="list" aria-label={t(M['messages.account_list.accounts'])}>
  {#if loading}
    <div class="loading" role="status" aria-live="polite">
      <p>{t(M['messages.account_list.loading'])}</p>
    </div>
  {:else if accounts.length === 0}
    <div class="empty" role="status" aria-live="polite">
      <p>{t(M['messages.account_list.empty'])}</p>
    </div>
  {:else}
    <Grid columns="auto" role="list" aria-label={t(M['messages.account_list.accounts'])}>
      {#each accounts as account (account.id)}
        <div role="listitem">
          {#if onaccountclick}
            <div
              role="button"
              tabindex="0"
              onclick={() => handleAccountClick(account)}
              onkeydown={(event) => handleAccountKeydown(event, account)}
            >
              <AccountCard {account} {onsync} {onremove} />
            </div>
          {:else}
            <div>
              <AccountCard {account} {onsync} {onremove} />
            </div>
          {/if}
        </div>
      {/each}
    </Grid>
  {/if}
</div>

<style>
  .loading,
  .empty {
    text-align: center;
    padding: var(--smrt-spacing-3xl, 3rem);
    color: var(--smrt-color-on-surface-variant, #43474e);
  }

  .loading p,
  .empty p {
    font: var(--smrt-typography-body-large-font, 1.125rem / 1.5 sans-serif);
  }
</style>
