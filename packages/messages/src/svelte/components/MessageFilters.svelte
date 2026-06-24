<script lang="ts">
/**
 * MessageFilters - Filter/sort controls bar
 */
import { Input, Select } from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
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
    <Input
      type="search"
      class="search-input"
      placeholder={t(M['messages.message_filters.search_placeholder'])}
      bind:value={searchValue}
      onkeydown={(e) => { if (e.key === 'Enter') handleSearch(); }}
      aria-label={t(M['messages.message_filters.search_label'])}
    />
    <Button variant="primary" class="search-btn" onclick={handleSearch}>Search</Button>
  </div>

  <div class="filter-row">
    <Select
      class="filter-select"
      value={filters.type || ''}
      onchange={(e) => updateFilter('type', (e.currentTarget as HTMLSelectElement).value)}
      aria-label={t(M['messages.message_filters.filter_by_type'])}
    >
      <option value="">{t(M['messages.message_filters.all_types'])}</option>
      {#each availableTypes as type}
        <option value={type}>{type === 'email' ? 'Email' : type === 'tweet' ? 'Tweet' : type === 'slack' ? 'Slack' : type}</option>
      {/each}
    </Select>

    {#if accounts.length > 0}
      <Select
        class="filter-select"
        value={filters.accountId || ''}
        onchange={(e) => updateFilter('accountId', (e.currentTarget as HTMLSelectElement).value)}
        aria-label={t(M['messages.message_filters.filter_by_account'])}
      >
        <option value="">{t(M['messages.message_filters.all_accounts'])}</option>
        {#each accounts as account}
          <option value={account.id}>{account.name}</option>
        {/each}
      </Select>
    {/if}

    <Select
      class="filter-select"
      value={filters.isRead === undefined ? '' : filters.isRead ? 'read' : 'unread'}
      onchange={(e) => {
        const val = (e.currentTarget as HTMLSelectElement).value;
        updateFilter('isRead', val === '' ? undefined : val === 'read');
      }}
      aria-label={t(M['messages.message_filters.filter_by_read_status'])}
    >
      <option value="">Read & unread</option>
      <option value="unread">{t(M['messages.message_filters.unread_only'])}</option>
      <option value="read">{t(M['messages.message_filters.read_only'])}</option>
    </Select>

    <label class="filter-checkbox">
      <!-- raw-primitive-allow: native checkbox; no Provider-free checkbox primitive (Toggle is a switch with different semantics, CheckboxInput requires a Provider) -->
      <input
        type="checkbox"
        checked={filters.isFlagged === true}
        onchange={(e) => updateFilter('isFlagged', (e.currentTarget as HTMLInputElement).checked ? true : undefined)}
      />
      Flagged
    </label>

    {#if _hasActiveFilters}
      <Button variant="ghost" size="sm" class="clear-btn" onclick={clearFilters}>
        {t(M['messages.message_filters.clear_filters'])}
      </Button>
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

  /*
   * The search field now renders through smrt-ui's <Input>. The primitive owns
   * border / background / focus; `.search-row :global(.search-input)` only
   * re-asserts `flex: 1` so it shares the row with the Search button, piercing
   * the Input child scope (issue #1589).
   */
  .search-row :global(.search-input) {
    flex: 1;
  }

  /*
   * Search now renders through smrt-ui's <Button variant="primary">. The variant
   * owns the filled-primary background + hover; `.search-row :global(.search-btn)`
   * only re-asserts the original small radius and label font/padding by piercing
   * the Button child scope (issue #1589).
   */
  .search-row :global(.search-btn) {
    padding: 0.5rem 1rem;
    border-radius: var(--smrt-radius-small, 0.25rem);
    font: var(--smrt-typography-label-large-font, 500 0.875rem / 1.25 sans-serif);
  }

  .filter-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
  }

  /*
   * The filter dropdowns now render through smrt-ui's <Select>. The primitive
   * owns border / background / focus / chevron; `.filter-row :global(.filter-select)`
   * re-asserts the compact filter-bar sizing (auto width, tighter padding, small
   * font) by piercing the Select child scope (issue #1589).
   */
  .filter-row :global(.filter-select) {
    width: auto;
    padding: 0.375rem 2rem 0.375rem 0.5rem;
    font: var(--smrt-typography-body-small-font, 0.75rem / 1.33 sans-serif);
  }

  .filter-checkbox {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    font: var(--smrt-typography-body-small-font, 0.75rem / 1.33 sans-serif);
    color: var(--smrt-color-on-surface, #1a1c1e);
    cursor: pointer;
  }

  /*
   * Clear filters now renders through smrt-ui's <Button variant="ghost">.
   * `.filter-row :global(.clear-btn)` anchors on the real `.filter-row` element
   * and pierces the Button child scope to keep the underlined text-link look
   * (issue #1589).
   */
  .filter-row :global(.clear-btn) {
    padding: 0.25rem 0.5rem;
    border: none;
    background: none;
    font: var(--smrt-typography-label-medium-font, 500 0.75rem / 1.33 sans-serif);
    color: var(--smrt-color-primary, #005ac1);
    text-decoration: underline;
  }
</style>
