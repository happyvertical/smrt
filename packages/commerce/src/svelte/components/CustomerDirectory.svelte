<script lang="ts">
import { StatusBadge } from '@happyvertical/smrt-ui';
import { Alert } from '@happyvertical/smrt-ui/feedback';
import { Form, FormGroup, Input, Select } from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { EmptyState, PageHeader } from '@happyvertical/smrt-ui/layout';
import { Button, Card, Skeleton } from '@happyvertical/smrt-ui/ui';
import { M } from '../i18n.js';
import type {
  CustomerDisplayData,
  PartyDirectoryExtension,
  PartyDirectoryItem,
  PartySurfaceLabels,
} from '../party-types.js';

/** Props for the searchable, paginated customer directory. */
export interface Props {
  /** Customer rows and caller-owned detail links. */
  items?: PartyDirectoryItem<CustomerDisplayData>[];
  /** Total matching rows across every page. */
  total?: number;
  /** Current one-based page number. */
  page?: number;
  /** Number of rows requested per page. */
  pageSize?: number;
  /** Search text reflected from the caller's query state. */
  query?: string;
  /** Status filter reflected from the caller's query state. */
  status?: string;
  /** Caller-owned URL for the native search form. */
  searchAction?: string;
  /** HTML name used for the search query field. */
  queryName?: string;
  /** HTML name used for the status field. */
  statusName?: string;
  /** Caller-owned URL for the previous page. */
  previousHref?: string;
  /** Caller-owned URL for the next page. */
  nextHref?: string;
  /** Caller-owned URL for creating a customer. */
  addHref?: string;
  /** Controls whether the create affordance is presented. */
  canCreate?: boolean;
  /** Renders loading placeholders instead of current rows. */
  loading?: boolean;
  /** Server or upstream failure to present instead of current rows. */
  errorMessage?: string;
  /** Customer terminology and action-label overrides. */
  labels?: PartySurfaceLabels;
  /** Consumer content appended to every customer row. */
  extension?: PartyDirectoryExtension<CustomerDisplayData>;
}

const {
  items = [],
  total = items.length,
  page = 1,
  pageSize,
  query = '',
  status = '',
  searchAction,
  queryName = 'q',
  statusName = 'status',
  previousHref,
  nextHref,
  addHref,
  canCreate = false,
  loading = false,
  errorMessage,
  labels = {},
  extension,
}: Props = $props();

const { t } = useI18n();
const singular = $derived(
  labels.singular ?? t(M['commerce.customer.singular']),
);
const plural = $derived(labels.plural ?? t(M['commerce.customer.plural']));
const first = $derived(
  pageSize === undefined || total === 0 ? 0 : (page - 1) * pageSize + 1,
);
const last = $derived(
  pageSize === undefined ? 0 : Math.min(page * pageSize, total),
);

function statusLabel(value: string): string {
  if (value === 'active') return t(M['commerce.party.status_active']);
  if (value === 'inactive') return t(M['commerce.party.status_inactive']);
  if (value === 'suspended') return t(M['commerce.party.status_suspended']);
  return value;
}

function customerTypeLabel(value: string | undefined): string {
  if (value === 'dtc') return t(M['commerce.customer.type_dtc']);
  if (value === 'wholesale') return t(M['commerce.customer.type_wholesale']);
  if (value === 'retail') return t(M['commerce.customer.type_retail']);
  return value ?? singular;
}
</script>

<section class="party-directory">
  <PageHeader title={plural} subtitle={labels.plural ? t(M['commerce.party.manage_named'], { plural }) : t(M['commerce.customer.manage'])}>
    {#snippet actions()}
      {#if canCreate && addHref}<Button href={addHref}>{labels.add ?? (labels.singular ? t(M['commerce.party.add_named'], { singular }) : t(M['commerce.customer.add']))}</Button>{/if}
    {/snippet}
  </PageHeader>

  <Form class="directory-search" method="get" action={searchAction} preventDefault={false} stagedReview={false}>
    <FormGroup label={labels.search ?? (labels.plural ? t(M['commerce.party.search_named'], { plural }) : t(M['commerce.customer.search']))}>
      <Input type="search" name={queryName} value={query} maxlength={160} />
    </FormGroup>
    <FormGroup label={t(M['commerce.party.status'])}>
      <Select name={statusName} value={status}>
        <option value="">{t(M['commerce.party.status_all'])}</option>
        {#if status && !['active', 'inactive', 'suspended'].includes(status)}
          <option value={status}>{status}</option>
        {/if}
        <option value="active">{t(M['commerce.party.status_active'])}</option>
        <option value="inactive">{t(M['commerce.party.status_inactive'])}</option>
        <option value="suspended">{t(M['commerce.party.status_suspended'])}</option>
      </Select>
    </FormGroup>
    <Button type="submit" variant="secondary">{t(M['commerce.party.search'])}</Button>
  </Form>

  {#if errorMessage}
    <Alert variant="error" title={t(M['commerce.customer.unable_to_load'])}>{errorMessage}</Alert>
  {:else if loading}
    <div class="loading" role="status" aria-label={labels.loading ?? t(M['commerce.customer.loading'])}>
      <Skeleton height="6rem" /><Skeleton height="6rem" /><Skeleton height="6rem" />
    </div>
  {:else if items.length === 0}
    <EmptyState title={labels.empty ?? t(M['commerce.customer.no_results'])} description={t(M['commerce.party.try_filters'])} />
  {:else}
    <p class="result-count">
      {pageSize === undefined
        ? t(M['commerce.party.showing_count'], { count: items.length, total })
        : t(M['commerce.party.showing'], { first, last, total })}
    </p>
    <div class="party-list">
      {#each items as item (item.data.id)}
        <Card padding="md" hoverable data-party-id={item.data.id}>
          <div class="party-row">
            <div class="party-copy">
              <h2>{#if item.href}<a href={item.href}>{item.data.profile.name}</a>{:else}{item.data.profile.name}{/if}</h2>
              <p>{item.data.profile.email || t(M['commerce.party.no_contact_details'])}</p>
              <p class="meta">{customerTypeLabel(item.data.customerType)}{item.data.paymentTerms ? ` · ${item.data.paymentTerms}` : ''}</p>
            </div>
            <StatusBadge status={item.data.status} label={statusLabel(item.data.status)} />
          </div>
          {@render extension?.(item.data)}
        </Card>
      {/each}
    </div>
    <nav class="pagination" aria-label={t(M['commerce.party.pagination'], { singular })}>
      {#if previousHref}<Button href={previousHref} variant="secondary">{labels.previous ?? t(M['commerce.party.previous'])}</Button>{/if}
      <span>{t(M['commerce.party.page'], { page })}</span>
      {#if nextHref}<Button href={nextHref} variant="secondary">{labels.next ?? t(M['commerce.party.next'])}</Button>{/if}
    </nav>
  {/if}
</section>

<style>
  .party-directory { display: grid; gap: var(--smrt-spacing-5); max-inline-size: 64rem; min-inline-size: 0; }
  :global(.directory-search) { display: grid; grid-template-columns: minmax(12rem, 2fr) minmax(10rem, 1fr) auto; align-items: end; gap: var(--smrt-spacing-3); }
  :global(.directory-search .form-group) { margin: 0; min-inline-size: 0; }
  .loading, .party-list { display: grid; gap: var(--smrt-spacing-3); }
  .result-count { margin: 0; color: var(--smrt-color-on-surface-variant); }
  .party-row { display: flex; align-items: start; justify-content: space-between; gap: var(--smrt-spacing-4); }
  .party-copy { min-inline-size: 0; }
  h2, p { margin: 0; }
  h2 { font: var(--smrt-typography-title-medium-font); }
  h2 a { color: var(--smrt-color-primary); text-decoration-thickness: 1px; text-underline-offset: 0.15em; }
  .meta { margin-block-start: var(--smrt-spacing-2); color: var(--smrt-color-on-surface-variant); }
  .pagination { display: flex; align-items: center; justify-content: center; gap: var(--smrt-spacing-3); }
  @media (max-width: 42rem) { :global(.directory-search) { grid-template-columns: minmax(0, 1fr); } :global(.directory-search .button) { inline-size: 100%; } .party-row { align-items: start; } }
</style>
