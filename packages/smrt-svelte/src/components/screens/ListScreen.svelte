<script lang="ts">
/**
 * ListScreen - a searchable, sortable, paged table for any model, derived from
 * its manifest definition and resolved field policy (#3718).
 *
 * Columns are the policy's basic-tier scalar fields in policy order (override
 * with `columns`). Hidden fields, fields outside the policy, and long text /
 * JSON / raw reference columns never appear by default. The screen is
 * transport-neutral: the caller supplies `rows` and handles `onselect`,
 * `oncreate` and `onretry`.
 */
import { DataTable, type DataTableColumn } from '@happyvertical/smrt-ui/data';
import { Alert } from '@happyvertical/smrt-ui/feedback';
import { SearchInput } from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { EmptyState, PageHeader } from '@happyvertical/smrt-ui/layout';
import { Button } from '@happyvertical/smrt-ui/ui';
import { M } from '../../i18n/strings.screens.js';
import {
  deriveScreenFields,
  screenSourceError,
  screenTitles,
} from './fields.js';
import type {
  ListScreenProps,
  ScreenCollectionDefinition,
  ScreenPolicy,
  ScreenRecord,
} from './types.js';
import { compareScreenValues, formatScreenValue } from './values.js';

let {
  definition,
  policy = null,
  rows,
  title,
  description,
  columns,
  maxColumns,
  pageSize = 25,
  searchable = true,
  loading = false,
  error = null,
  currency,
  locale,
  showHeader = true,
  onselect,
  oncreate,
  onretry,
  extraActions,
}: ListScreenProps = $props();

const { t } = useI18n();

const titles = $derived(screenTitles(definition));
const heading = $derived(title ?? titles.plural);
const sourceError = $derived(screenSourceError(definition, policy));
const idField = $derived(definition.idField ?? 'id');

const fields = $derived(
  sourceError
    ? []
    : deriveScreenFields(definition, policy, {
        mode: 'list',
        include: columns,
        maxListColumns: maxColumns,
      }),
);

type DisplayRow = Record<string, unknown> & { __raw: ScreenRecord };

const formatContext = $derived({
  currency,
  locale,
  yes: t(M['ui.screens.yes']),
  no: t(M['ui.screens.no']),
});

const displayRows = $derived<DisplayRow[]>(
  rows.map((row) => {
    const display: DisplayRow = { __raw: row };
    for (const field of fields) {
      display[field.name] = formatScreenValue(
        field,
        row[field.name],
        formatContext,
      );
    }
    return display;
  }),
);

const tableColumns = $derived<DataTableColumn<DisplayRow>[]>(
  fields.map((field) => ({
    id: field.name,
    label: field.label,
    accessor: field.name,
    sortable: true,
    align:
      field.kind === 'integer' ||
      field.kind === 'decimal' ||
      field.kind === 'money'
        ? ('right' as const)
        : ('left' as const),
    sortFn: (a, b, direction) =>
      compareScreenValues(a.__raw[field.name], b.__raw[field.name], direction),
  })),
);

let query = $state('');
const needle = $derived(query.trim().toLowerCase());
function matches(row: DisplayRow): boolean {
  if (!needle) return true;
  return fields.some((field) =>
    String(row[field.name] ?? '')
      .toLowerCase()
      .includes(needle),
  );
}
</script>

{#if showHeader}
  <PageHeader title={heading} subtitle={description}>
    {#snippet actions()}
      {#if extraActions}{@render extraActions()}{/if}
      {#if oncreate}
        <Button variant="primary" onclick={oncreate}>
          {t(M['ui.screens.create_action'], { name: titles.singular.toLowerCase() })}
        </Button>
      {/if}
    {/snippet}
  </PageHeader>
{/if}

<section class="smrt-list-screen" aria-label={heading}>
  {#if sourceError}
    <Alert variant="error">{sourceError}</Alert>
  {:else}
    {#if searchable}
      <div class="smrt-list-screen__search">
        <SearchInput
          value={query}
          onsearch={(next) => {
            query = next;
          }}
          label={t(M['ui.screens.search'], { name: heading.toLowerCase() })}
          placeholder={t(M['ui.screens.search'], { name: heading.toLowerCase() })}
        />
      </div>
    {/if}

    <DataTable
      data={displayRows}
      columns={tableColumns}
      rowKey={(row: DisplayRow) => String(row.__raw[idField])}
      sortable
      {pageSize}
      {loading}
      error={error ?? undefined}
      onRetry={onretry}
      filterFn={matches}
      caption={heading}
      phoneLayout="cards"
      hoverable
      onRowClick={onselect ? (row: DisplayRow) => onselect(row.__raw) : undefined}
    >
      {#snippet empty()}
        <EmptyState
          title={needle
            ? t(M['ui.screens.empty_search'])
            : t(M['ui.screens.empty_title'], { name: heading.toLowerCase() })}
          actionLabel={!needle && oncreate
            ? t(M['ui.screens.create_action'], { name: titles.singular.toLowerCase() })
            : undefined}
          onaction={!needle ? oncreate : undefined}
        />
      {/snippet}
    </DataTable>
  {/if}
</section>

<style>
  .smrt-list-screen {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-md, 1rem);
  }
  .smrt-list-screen__search {
    max-width: 24rem;
  }
</style>
