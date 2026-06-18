<script lang="ts">
/**
 * MessageFilters - Filter/sort controls bar
 */
import { useI18n } from '@happyvertical/smrt-svelte/i18n';
import { M } from '../i18n.messages.js';
import type {
  AccountData,
  MessageFilterState,
  MessageSort,
  MessageType,
} from '../types.js';

const { t } = useI18n();

export interface Props {
  filters?: MessageFilterState;
  sort?: MessageSort;
  accounts?: AccountData[];
  availableTypes?: MessageType[];
  onfilterchange?: (filters: MessageFilterState) => void;
  onsearch?: (query: string) => void;
}

const {
  filters = {},
  sort = { field: 'date', direction: 'desc' },
  accounts = [],
  availableTypes = ['email', 'tweet', 'slack'],
  onfilterchange,
  onsearch,
}: Props = $props();

function getInitialFilterState() {
  return {
    searchValue: filters.search ?? '',
    filters,
  };
}

const initialFilterState = getInitialFilterState();
let searchValue = $state(initialFilterState.searchValue);
let appliedFilters: MessageFilterState | undefined = initialFilterState.filters;

$effect(() => {
  if (appliedFilters === filters) {
    return;
  }

  appliedFilters = filters;
  searchValue = filters.search ?? '';
});

function updateFilter(key: keyof MessageFilterState, value: any) {
  const updated = { ...filters, [key]: value || undefined };
  onfilterchange?.(updated);
}

function handleSearch() {
  onsearch?.(searchValue);
  updateFilter('search', searchValue);
}

function clearFilters() {
  searchValue = '';
  onfilterchange?.({});
}

const _hasActiveFilters = $derived(
  !!filters.type ||
    !!filters.accountId ||
    filters.isRead !== undefined ||
    filters.isFlagged !== undefined ||
    !!filters.search,
);
</script>

<div class="message-filters" role="search" aria-label={t(M['messages.message_filters.filters_label'])}>
  <div class="search-row">
    <input
      type="search"
      class="search-input"
      placeholder={t(M['messages.message_filters.search_placeholder'])}
      bind:value={searchValue}
      onkeydown={(e) => { if (e.key === 'Enter') handleSearch(); }}
      aria-label={t(M['messages.message_filters.search_label'])}
    />
    <button class="search-btn" type="button" onclick={handleSearch}>Search</button>
  </div>

  <div class="filter-row">
    <select
      class="filter-select"
      value={filters.type || ''}
      onchange={(e) => updateFilter('type', (e.target as HTMLSelectElement).value)}
      aria-label={t(M['messages.message_filters.filter_by_type'])}
    >
      <option value="">{t(M['messages.message_filters.all_types'])}</option>
      {#each availableTypes as type}
        <option value={type}>{type === 'email' ? 'Email' : type === 'tweet' ? 'Tweet' : type === 'slack' ? 'Slack' : type}</option>
      {/each}
    </select>

    {#if accounts.length > 0}
      <select
        class="filter-select"
        value={filters.accountId || ''}
        onchange={(e) => updateFilter('accountId', (e.target as HTMLSelectElement).value)}
        aria-label={t(M['messages.message_filters.filter_by_account'])}
      >
        <option value="">{t(M['messages.message_filters.all_accounts'])}</option>
        {#each accounts as account}
          <option value={account.id}>{account.name}</option>
        {/each}
      </select>
    {/if}

    <select
      class="filter-select"
      value={filters.isRead === undefined ? '' : filters.isRead ? 'read' : 'unread'}
      onchange={(e) => {
        const val = (e.target as HTMLSelectElement).value;
        updateFilter('isRead', val === '' ? undefined : val === 'read');
      }}
      aria-label={t(M['messages.message_filters.filter_by_read_status'])}
    >
      <option value="">Read & unread</option>
      <option value="unread">{t(M['messages.message_filters.unread_only'])}</option>
      <option value="read">{t(M['messages.message_filters.read_only'])}</option>
    </select>

    <label class="filter-checkbox">
      <input
        type="checkbox"
        checked={filters.isFlagged === true}
        onchange={(e) => updateFilter('isFlagged', (e.target as HTMLInputElement).checked ? true : undefined)}
      />
      Flagged
    </label>

    {#if _hasActiveFilters}
      <button class="clear-btn" type="button" onclick={clearFilters}>
        {t(M['messages.message_filters.clear_filters'])}
      </button>
    {/if}
  </div>
</div>

<style>
  .message-filters {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.75rem;
    background: var(--smrt-color-surface, #fefbff);
    border: 1px solid var(--smrt-color-outline-variant, #c4c6d0);
    border-radius: var(--smrt-radius-medium, 0.5rem);
  }

  .search-row {
    display: flex;
    gap: 0.5rem;
  }

  .search-input {
    flex: 1;
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--smrt-color-outline, #72787e);
    border-radius: var(--smrt-radius-small, 0.25rem);
    font: var(--smrt-typography-body-medium-font, 0.875rem / 1.25 sans-serif);
    background: var(--smrt-color-surface, #fefbff);
    color: var(--smrt-color-on-surface, #1a1c1e);
  }

  .search-input:focus {
    outline: 2px solid var(--smrt-color-primary, #005ac1);
    outline-offset: -1px;
  }

  .search-btn {
    padding: 0.5rem 1rem;
    border: none;
    border-radius: var(--smrt-radius-small, 0.25rem);
    background: var(--smrt-color-primary, #005ac1);
    color: var(--smrt-color-on-primary, #fff);
    font: var(--smrt-typography-label-large-font, 500 0.875rem / 1.25 sans-serif);
    cursor: pointer;
  }

  .search-btn:hover {
    opacity: 0.9;
  }

  .filter-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
  }

  .filter-select {
    padding: 0.375rem 0.5rem;
    border: 1px solid var(--smrt-color-outline, #72787e);
    border-radius: var(--smrt-radius-small, 0.25rem);
    font: var(--smrt-typography-body-small-font, 0.75rem / 1.33 sans-serif);
    background: var(--smrt-color-surface, #fefbff);
    color: var(--smrt-color-on-surface, #1a1c1e);
  }

  .filter-checkbox {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    font: var(--smrt-typography-body-small-font, 0.75rem / 1.33 sans-serif);
    color: var(--smrt-color-on-surface, #1a1c1e);
    cursor: pointer;
  }

  .clear-btn {
    padding: 0.25rem 0.5rem;
    border: none;
    background: none;
    font: var(--smrt-typography-label-medium-font, 500 0.75rem / 1.33 sans-serif);
    color: var(--smrt-color-primary, #005ac1);
    cursor: pointer;
    text-decoration: underline;
  }
</style>
