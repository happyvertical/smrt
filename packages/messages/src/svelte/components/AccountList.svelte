<script lang="ts">
/**
 * AccountList - Account management list
 */
import { Grid } from '@happyvertical/smrt-svelte/layout';
import type { AccountData } from '../types.js';
import AccountCard from './AccountCard.svelte';

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
</script>

<div class="account-list" role="list" aria-label="Accounts">
  {#if loading}
    <div class="loading" role="status" aria-live="polite">
      <p>Loading accounts...</p>
    </div>
  {:else if accounts.length === 0}
    <div class="empty" role="status" aria-live="polite">
      <p>No accounts configured.</p>
    </div>
  {:else}
    <Grid columns="auto" role="list" aria-label="Accounts">
      {#each accounts as account (account.id)}
        <div role="listitem">
          <AccountCard {account} {onsync} {onremove} />
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
