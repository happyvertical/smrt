<script module lang="ts">
import type { DataTableViewState as ContentListDataTableViewState } from '@happyvertical/smrt-ui/data';
import type { ContentListUrlStateOptions } from '../content-list-url-state.js';

/**
 * Optional, router-agnostic URL state (#2452).
 *
 * `ContentList` never imports a router: it reads `params` once during
 * initialization and hands the merged parameters back through `onChange`, so a
 * SvelteKit host calls `replaceState`, a hash router rewrites the fragment, and
 * a test passes a plain `URLSearchParams`.
 */
export interface ContentListUrlStateBinding {
  /**
   * Query parameters to restore the view from. Read once, at initialization —
   * later navigation is the host's to drive (re-key the component to re-read).
   */
  params?: URLSearchParams | string | null;
  /**
   * Receives the full merged parameter set — every foreign parameter
   * preserved — whenever the query-affecting state changes. Never called for
   * the initial restore.
   */
  onChange?: (
    params: URLSearchParams,
    state: ContentListDataTableViewState,
  ) => void;
  /** Prefix and default page size, forwarded to the URL-state module. */
  options?: ContentListUrlStateOptions;
}
</script>

<script lang="ts">
import {
  DataTable,
  type DataTableColumn,
  type DataTableViewState,
} from '@happyvertical/smrt-ui/data';
import { ConfirmDialog } from '@happyvertical/smrt-ui/feedback';
import { Checkbox, Input, Select } from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button, Pagination } from '@happyvertical/smrt-ui/ui';
import type { Snippet } from 'svelte';
import { untrack } from 'svelte';
import type { ContentData } from '../../mock-smrt-client.js';
import {
  applyContentListFilter,
  buildContentListColumns,
  buildContentListSurfaceDescriptor,
  CONTENT_LIST_ACTIONS_COLUMN_ID,
  CONTENT_LIST_ROW_KEY,
  CONTENT_LIST_SELECTION_COLUMN_ID,
  CONTENT_LIST_STATUS_FILTER_ID,
  CONTENT_LIST_TYPE_FILTER_ID,
  type ContentListDataSurface,
  type ContentListRow,
  type ContentListViewMode,
  contentListRowActions,
  contentStateVariant,
  contentStatusVariant,
  createContentListController,
  CONTENT_LIST_STATUS_OPTIONS,
  CONTENT_LIST_TYPE_OPTIONS,
  isContentListFilterExactly,
  normalizeContentListTypeLock,
  paginateContentListRows,
  readContentListFilter,
  resolveContentHref,
  selectableContentListRowIds,
  selectContentListRows,
  toContentListRows,
} from '../content-list-controller.js';
import {
  CONTENT_LIST_QUERY_DEFAULT_PAGE_SIZE,
  type ContentListQueryDrop,
  type ContentListQueryDropReason,
  type ContentListQueryNotices,
  type ContentListQueryRequestOptions,
  type ContentListQuerySource,
  contentListQueryErrorMessage,
  contentListQueryRowsToContents,
  contentListQueryTotalValue,
  CONTENT_LIST_QUERY_MAX_OFFSET,
  contentListViewStateToDataQueryRequest,
  readContentListQueryNotices,
  resolveContentListMaxPageSize,
} from '../content-list-query.js';
import {
  type ContentListSavedView,
  type ContentListSavedViewStore,
  restoreContentListSavedView,
  toContentListSavedViewInput,
} from '../content-list-saved-views.js';
import {
  applyContentListViewState,
  type ContentListStateDrop,
  type ContentListStateDropReason,
  type ContentListStateValidationOptions,
  mergeContentListViewStateIntoSearchParams,
  readContentListViewStateFromSearchParams,
} from '../content-list-url-state.js';
import { M } from '../i18n.contribution.js';
import ImageThumbnail from './ImageThumbnail.svelte';

const { t } = useI18n();

/** One reported refusal, from a restore or from the query translation. */
type ContentListDropNotice = ContentListStateDrop | ContentListQueryDrop;

interface Props {
  apiBaseUrl?: string;
  /**
   * Client-side rows. Ignored when `query` is supplied — the server then owns
   * filtering, sorting, and paging, and these rows would be a second, disagreeing
   * source of truth.
   */
  contents?: ContentData[];
  type?: string;
  defaultViewMode?: ContentListViewMode;
  onEdit: (content: ContentData) => void;
  onDelete: (content: ContentData) => void;
  onAdd: () => void;
  controls?: Snippet;
  getViewHref?: (content: ContentData) => string | null;
  /** Announced uniformly by every presentation; #2455 extends it. */
  loading?: boolean;
  /** Load failure announced instead of the list. */
  error?: string | null;
  /** Retry affordance rendered with an error. */
  onRetry?: () => void;
  /** Opt-in agent addressability. Non-table presentations land with #2456. */
  dataSurface?: ContentListDataSurface;
  /**
   * Opt-in server-backed rows (#2452). `bind()` is called exactly once, during
   * initialization, so a `remoteQuery(...)` binding is disposed with this
   * component. Supplying it switches the list into server mode: `contents` is
   * ignored and the local select/paginate transform never runs.
   */
  query?: ContentListQuerySource;
  /** Opt-in shareable URL state. The host owns navigation. */
  urlState?: ContentListUrlStateBinding;
  /** Opt-in saved views. `createContentListSavedViewStore()` is the default store. */
  savedViews?: ContentListSavedViewStore;
}

let {
  apiBaseUrl = '/api/v1',
  contents = [],
  type = undefined,
  defaultViewMode = 'grid',
  onEdit,
  onDelete,
  onAdd,
  controls,
  getViewHref = undefined,
  loading = false,
  error = null,
  onRetry = undefined,
  dataSurface = undefined,
  query = undefined,
  urlState = undefined,
  savedViews = undefined,
}: Props = $props();

const initialQuery = untrack(() => query);

// One controller owns search, filters, sorting, paging, and selection for
// every presentation. The view mode lives beside it, so switching presentation
// never touches query or selection state.
// The seed is intentionally the initial `type`; the effect below keeps the
// locked filter in sync afterwards.
const initialUrlState = untrack(() => urlState);

/**
 * THE page-size ceiling. Resolved once, from every configured limit, and used
 * by the controller seed, the URL sanitizer, the saved-view sanitizer and the
 * translator — so the size the UI pages by and the size the server applies are
 * the same number by construction rather than by coincidence.
 *
 * Every candidate narrows (`Math.min`, inside `resolveContentListMaxPageSize`):
 * a host that sets `query.request.maxPageSize` as a server row budget must not
 * have it discarded because a looser `urlState.options.maxPageSize` also exists.
 */
const maxPageSize = resolveContentListMaxPageSize(
  initialUrlState?.options?.maxPageSize,
  initialQuery?.request?.maxPageSize,
);

/**
 * The page size a server-backed list runs at, clamped to that ceiling.
 *
 * `null` (unpaginated) is only expressible locally: the query endpoint always
 * applies a limit, so an unpaginated server list would render one silent page
 * with no controls. This value is the seed, the URL layer's notion of the
 * default (so a link without `size` restores it rather than wiping it), and the
 * translator's fallback — one number in all three places. Clamping the seed
 * matters on its own: a `defaultPageSize` above the ceiling would seed a page
 * size the request then silently reduces, and `totalPages` would compute 1.
 */
const serverPageSize = initialQuery
  ? Math.min(
      Math.max(
        1,
        Math.floor(
          initialQuery.request?.defaultPageSize ??
            CONTENT_LIST_QUERY_DEFAULT_PAGE_SIZE,
        ),
      ),
      maxPageSize,
    )
  : null;

/** Validation options shared by the URL and saved-view restore paths. */
const restoreOptions: ContentListStateValidationOptions = { maxPageSize };

/**
 * URL options with the server page size filled in as the default, so a link
 * that omits `size` restores the seed instead of the local `null`, and a link
 * this list writes omits `size` while the list is at its default.
 */
const urlStateOptions: ContentListUrlStateOptions = {
  ...initialUrlState?.options,
  maxPageSize,
  ...(serverPageSize !== null &&
  initialUrlState?.options?.defaultPageSize === undefined
    ? { defaultPageSize: serverPageSize }
    : {}),
};

const controller = createContentListController({
  type: untrack(() => type),
  // Local mode keeps the historical unpaginated list.
  ...(serverPageSize === null ? {} : { pageSize: serverPageSize }),
});

/** Everything a restore or a translation refused, surfaced as one notice. */
let restoreDrops = $state<ContentListDropNotice[]>([]);
let queryDrops = $state<ContentListQueryDrop[]>([]);
/**
 * A capped-offset redirect, held apart from `queryDrops` so it survives the
 * corrective re-translation that immediately follows it.
 */
let pageCapDrop = $state<ContentListQueryDrop | null>(null);
/** Which page the last offset cap redirected to. Named in the notice. */
let pageCapCorrectedTo = $state<number | undefined>(undefined);
let dismissedDropKey = $state('');
let resultNotices = $state<ContentListQueryNotices>({
  truncated: false,
  warnings: [],
});

function toSearchParams(
  input: URLSearchParams | string | null | undefined,
): URLSearchParams {
  if (!input) return new URLSearchParams();
  return new URLSearchParams(input);
}

// The URL restore runs before the first snapshot is taken, so the initial
// render is already the restored view rather than a flash of the default one.
// `applyContentListViewState` merges over current state instead of dispatching
// `setSearch`/`setFilters`, which would reset the restored page.
if (initialUrlState?.params) {
  const reading = readContentListViewStateFromSearchParams(
    toSearchParams(initialUrlState.params),
    urlStateOptions,
  );
  // A restore REPLACES the filter set, including the type filter the controller
  // was seeded with. On a locked list the lock effect would then re-apply it
  // through `setFilters`, which resets paging — silently discarding a `?page=`
  // the same link just restored. Folding the lock into the restored patch keeps
  // it to one `replaceState`, and leaves the effect's first run a no-op.
  const initialLockedType = normalizeContentListTypeLock(untrack(() => type));
  const patch =
    initialLockedType === null
      ? reading.state
      : {
          ...reading.state,
          filters: [
            ...(reading.state.filters ?? []).filter(
              (filter) => filter.columnId !== CONTENT_LIST_TYPE_FILTER_ID,
            ),
            {
              columnId: CONTENT_LIST_TYPE_FILTER_ID,
              operator: 'equals' as const,
              value: initialLockedType,
            },
          ],
        };
  applyContentListViewState(controller, patch, restoreOptions);
  restoreDrops = reading.dropped;
}

/**
 * The server-query binding, created once. `bind()` runs inside this
 * component's initialization, so a binding that registers an `$effect` teardown
 * (as `remoteQuery` does) is disposed when this component is.
 */
const queryBinding = initialQuery?.bind();
const queryRequestOptions: ContentListQueryRequestOptions | undefined =
  initialQuery
    ? {
        ...initialQuery.request,
        maxPageSize,
        ...(serverPageSize === null ? {} : { defaultPageSize: serverPageSize }),
      }
    : undefined;
const serverBacked = queryBinding !== undefined;

let snapshot = $state(controller.snapshot());
let viewMode: ContentListViewMode = $state(untrack(() => defaultViewMode));
let pendingDelete = $state<ContentListRow | null>(null);
let savedViewList = $state<ContentListSavedView[]>([]);
let selectedSavedViewId = $state('');
let savedViewName = $state('');

$effect(() =>
  controller.subscribe((transition) => {
    snapshot = transition.next;
  }),
);

const tableState = $derived(snapshot.state);

// In server mode the controller's page size must be a number the request can
// actually carry, or `totalPages` and `showPagination` describe a page the
// server never returned and rows are stranded behind a plausible-looking single
// page. Two ways in, both enforced against LIVE state because a saved view, a
// link, and a data-surface `set-page-size` all arrive after mount:
//
//   null          → unpaginated, which the endpoint cannot express;
//   > maxPageSize → the translator clamps the request, so leaving the
//                   controller above the ceiling makes the two disagree.
//
// `setPageSize` also resets the page, which is correct: a different page size
// means the old page number addresses different rows.
$effect(() => {
  if (serverPageSize === null) return;
  const current = tableState.pageSize;
  if (current !== null && current <= maxPageSize) return;
  const next = current === null ? serverPageSize : maxPageSize;
  const reason: ContentListQueryDropReason =
    current === null ? 'unpaginated-unsupported' : 'out-of-range';
  untrack(() => {
    controller.dispatch({ type: 'setPageSize', pageSize: next });
    restoreDrops = [
      ...restoreDrops.filter(
        (drop) =>
          drop.scope !== 'pageSize' ||
          (drop.reason !== 'unpaginated-unsupported' &&
            drop.reason !== 'out-of-range'),
      ),
      {
        scope: 'pageSize',
        reason,
        ...(current === null ? {} : { detail: String(current) }),
      },
    ];
  });
});

/** The normalized type the `type` prop locks the list to, if any. */
const lockedType = $derived(normalizeContentListTypeLock(type));

// A `type` prop locks the type filter, exactly as the legacy select did. The
// lock is enforced against the live state, not only against the prop, because a
// data-surface `set-filters` or `reset` command can otherwise replace or clear
// it. The equality guard keeps the effect from dispatching in a loop.
// Tracks the previous prop so an unlocked list can tell "the lock was just
// removed" from "there was never a lock". A plain binding, so writing it here
// cannot re-trigger the effect.
let previousLockedType: string | null = untrack(() => lockedType);

$effect(() => {
  const locked = lockedType;
  if (locked === null) {
    const lockWasRemoved = previousLockedType !== null;
    previousLockedType = null;
    // Unlocked: the toolbar select owns the filter. Clear it only when the prop
    // actually went away, because clearing on every run would also discard a
    // type filter restored from a link or a saved view.
    if (!lockWasRemoved) return;
    untrack(() =>
      applyContentListFilter(controller, CONTENT_LIST_TYPE_FILTER_ID, null),
    );
    return;
  }
  previousLockedType = locked;
  if (
    isContentListFilterExactly(tableState, CONTENT_LIST_TYPE_FILTER_ID, locked)
  )
    return;
  untrack(() =>
    applyContentListFilter(controller, CONTENT_LIST_TYPE_FILTER_ID, locked),
  );
});

const columnLabels = $derived({
  type: t(M['content.content_list.column_type']),
  title: t(M['content.content_list.column_title']),
  author: t(M['content.content_list.column_author']),
  status: t(M['content.content_list.column_status']),
  state: t(M['content.content_list.column_state']),
  publish: t(M['content.content_list.column_publish']),
  updated: t(M['content.content_list.column_updated']),
  site: t(M['content.content_list.column_site']),
});

const queryColumns = $derived(buildContentListColumns(columnLabels));
const sourceContents = $derived(
  queryBinding ? contentListQueryRowsToContents(queryBinding.rows) : contents,
);
const rows = $derived(toContentListRows(sourceContents));
// In server mode the returned rows ARE the answer: the server already applied
// the search, the filters, the sort, and the page. Running the local transform
// over them again would re-filter with subtly different semantics (untrimmed
// search, case-insensitive comparison, a `site` predicate the server never saw)
// and could hide rows the server deliberately returned.
const queryRows = $derived(
  serverBacked ? rows : selectContentListRows(rows, tableState, queryColumns),
);
const pageRows = $derived(
  serverBacked ? rows : paginateContentListRows(queryRows, tableState),
);
/** Server row count for the whole query, not just the rendered page. */
const serverTotal = $derived(
  queryBinding ? contentListQueryTotalValue(queryBinding.total) : undefined,
);
const totalRowCount = $derived(
  serverBacked ? (serverTotal ?? rows.length) : queryRows.length,
);

// The adapter owns filtering, sorting, and paging, so the controller's page has
// to be clamped against the result count rather than DataTable's. In server
// mode that count is the server's total — clamping against the page length
// would collapse every list to a single page.
$effect(() => {
  const totalRows = totalRowCount;
  // Before the first response there is no authoritative total; clamping to zero
  // would reset a page restored from a link before it was ever queried.
  if (serverBacked && serverTotal === undefined) return;
  // Deliberately the TRUE total, not `pageableRowCount`: clamping to the
  // reachable ceiling here would silently move a crafted `?page=9000` before
  // the query effect ever sees it, and the operator would never be told why
  // they landed somewhere else.
  untrack(() => controller.clampPage(totalRows));
});

/**
 * The last page a server query can actually fetch.
 *
 * Offset paging stops at `CONTENT_LIST_QUERY_MAX_OFFSET`, so on a very large
 * list the arithmetic total implies pages the endpoint will never return.
 * Advertising them is worse than not offering them: every click past the
 * boundary silently lands back on the same page.
 */
const maxReachablePage = $derived(
  serverBacked && tableState.pageSize
    ? Math.floor(CONTENT_LIST_QUERY_MAX_OFFSET / tableState.pageSize) + 1
    : Number.POSITIVE_INFINITY,
);
/**
 * The row count the pagers may page over. DataTable derives its own page count
 * from `totalRows` and takes no ceiling, so the ceiling has to be applied to
 * the number handed to it. `clampPage` deliberately keeps using the true total
 * (see below).
 */
const pageableRowCount = $derived(
  tableState.pageSize
    ? Math.min(totalRowCount, maxReachablePage * tableState.pageSize)
    : totalRowCount,
);
/**
 * What DataTable is told, which is `undefined` until the first authoritative
 * total arrives.
 *
 * DataTable clamps the controller's page against `totalRows`, so handing it the
 * pre-response zero resets a page restored from a link the moment the compact
 * table mounts — a `?page=3` link silently opens on page 1. `undefined` is the
 * documented "not known yet" value: DataTable renders no pager and clamps
 * nothing until a real count exists.
 */
const dataTableTotalRows = $derived(
  serverBacked && serverTotal === undefined ? undefined : pageableRowCount,
);
// The card presentations have to render their own page controls: DataTable —
// and with it the page navigation — is only mounted in compact mode, so a page
// size set from a saved view or a surface command would otherwise strand the
// operator on page one.
const totalPages = $derived(
  tableState.pageSize
    ? Math.max(1, Math.ceil(pageableRowCount / tableState.pageSize))
    : 1,
);
const showPagination = $derived(Boolean(tableState.pageSize) && totalPages > 1);
const queryErrorMessage = $derived(
  queryBinding ? contentListQueryErrorMessage(queryBinding.error) : null,
);
/** A host-supplied error still wins: it describes the surrounding page load. */
const activeError = $derived(error ?? queryErrorMessage);
const isLoading = $derived(loading || (queryBinding?.loading ?? false));
/** Rows are already rendered, so a load is a refresh rather than a first fill. */
const refreshing = $derived(
  (queryBinding?.refreshing ?? false) || (isLoading && pageRows.length > 0),
);
/**
 * A retry re-reads the same query, so its answer replaces the rendered rows —
 * and therefore has to replace the completeness flags that describe them too.
 * Discarding the envelope here is what left a "rows are missing" notice
 * standing over a page that came back complete (and the inverse after a
 * transient error). The signature does not change on a retry, so the query
 * effect never re-runs and this is the only place that can refresh them.
 */
function retryQuery(): void {
  if (!queryBinding) return;
  const signature = executedSignature;
  void queryBinding
    .retry()
    .then((result) => {
      // `retry()` resolves undefined when there is no request to repeat, and a
      // newer query may have superseded this one while it was in flight.
      if (result === undefined || executedSignature !== signature) return;
      resultNotices = readContentListQueryNotices(result);
    })
    .catch(() => undefined);
}

const retryHandler = $derived(
  onRetry ?? (queryBinding ? retryQuery : undefined),
);

/**
 * A signature of exactly the query-affecting state. Selection and expansion are
 * excluded on purpose: checking a row must not re-run the server query. The
 * value is a primitive, so an unrelated transition that leaves the query
 * unchanged does not propagate.
 */
const querySignature = $derived(
  JSON.stringify([
    tableState.search,
    tableState.filters,
    tableState.sorting,
    tableState.page,
    tableState.pageSize,
  ]),
);

let executedSignature: string | undefined;
let publishedUrlSignature: string | undefined;


$effect(() => {
  const signature = querySignature;
  untrack(() => {
    const state = controller.getState();
    if (queryBinding && signature !== executedSignature) {
      executedSignature = signature;
      const translated = contentListViewStateToDataQueryRequest(
        state,
        queryRequestOptions,
      );
      // The page-cap drop is held separately because it must OUTLIVE this
      // translation: the corrective dispatch below re-enters this effect, and
      // the second translation caps nothing, so a drop stored here would be
      // overwritten in the same flush and the redirect would be silent.
      queryDrops = translated.dropped.filter((drop) => drop.scope !== 'page');
      if (translated.effectivePage !== state.page) {
        // The offset had to be capped. Move the controller's page marker to the
        // page the request actually reads, or the UI labels this answer with a
        // page number the server never saw. The dispatch re-enters this effect
        // with the corrected signature, which then executes.
        pageCapDrop = {
          scope: 'page',
          reason: 'out-of-range',
          detail: String(state.page),
        };
        pageCapCorrectedTo = translated.effectivePage;
        controller.dispatch({
          type: 'setPage',
          page: translated.effectivePage,
        });
        return;
      }
      // The redirect notice stands until the operator moves off the page they
      // were redirected to; clearing it on the corrective re-run would be the
      // same silence by a different route.
      if (pageCapDrop !== null && state.page !== pageCapCorrectedTo) {
        pageCapDrop = null;
        pageCapCorrectedTo = undefined;
      }
      // The binding owns cancellation of a superseded run and already reflects
      // a failure in its error state, so a rejection here is not also an
      // unhandled one. The resolved envelope carries the server's completeness
      // flags, which the binding itself does not expose.
      void queryBinding
        .execute(translated.request)
        .then((result) => {
          // A newer query may have superseded this one while it was in flight.
          if (executedSignature !== signature) return;
          resultNotices = readContentListQueryNotices(result);
        })
        .catch(() => undefined);
    }
    if (publishedUrlSignature === undefined) {
      // The first pass adopts whatever the restore produced without pushing it
      // back at the host as a navigation.
      publishedUrlSignature = signature;
      return;
    }
    if (signature === publishedUrlSignature) return;
    publishedUrlSignature = signature;
    const binding = urlState;
    if (!binding?.onChange) return;
    binding.onChange(
      mergeContentListViewStateIntoSearchParams(
        toSearchParams(binding.params),
        state,
        urlStateOptions,
      ),
      state as DataTableViewState,
    );
  });
});

const selectedRowKeys = $derived(
  new Set(tableState.selectedRowIds.map((rowId) => String(rowId))),
);
// Only durable rows may be addressed by a selection.
const identifiedRowKeys = $derived(
  new Set(selectableContentListRowIds(rows).map((rowId) => String(rowId))),
);
const selectablePageRowIds = $derived(selectableContentListRowIds(pageRows));
const allPageSelected = $derived(
  selectablePageRowIds.length > 0 &&
    selectablePageRowIds.every((rowId) => selectedRowKeys.has(String(rowId))),
);
const somePageSelected = $derived(
  !allPageSelected &&
    selectablePageRowIds.some((rowId) => selectedRowKeys.has(String(rowId))),
);
const selectedCount = $derived(tableState.selectedRowIds.length);

/** Synthetic ids the adapter minted for rows that carry no durable identity. */
const unidentifiedRowKeys = $derived(
  new Set(
    rows.filter((row) => !row.identified).map((row) => String(row.id)),
  ),
);

// DataTable's own selection column and data-surface commands can both introduce
// ids for rows that carry no durable identity. Normalizing here covers every
// path at once; re-dispatching only on a real difference keeps it settling.
//
// In server mode `rows` is only the current page, so membership cannot be the
// test: it would silently clear the whole selection on every page change. Only
// the synthetic ids are stripped there, which keeps a selection addressable
// across pages while still refusing an unaddressable row.
$effect(() => {
  const selected = tableState.selectedRowIds;
  const durable = selected.filter((rowId) =>
    serverBacked
      ? !unidentifiedRowKeys.has(String(rowId))
      : identifiedRowKeys.has(String(rowId)),
  );
  if (durable.length === selected.length) return;
  untrack(() =>
    controller.dispatch({ type: 'setSelectedRows', rowIds: durable }),
  );
});

const selectedType = $derived(
  readContentListFilter(tableState, CONTENT_LIST_TYPE_FILTER_ID) ?? '',
);
const selectedStatus = $derived(
  readContentListFilter(tableState, CONTENT_LIST_STATUS_FILTER_ID) ?? '',
);

/**
 * A live filter value the select cannot show, because it is outside the
 * published vocabulary — a real-but-unlisted token, or a typo in a link.
 *
 * Both selects handle it the same way, and handle it twice over: the value is
 * rendered as an extra option so the toolbar tells the truth about what is
 * constraining the list, AND it is reported in the notice so the operator knows
 * why the result may be empty. Silently showing an unfiltered-looking toolbar
 * over zero rows is the one outcome that must not happen.
 */
const unlistedType = $derived(
  selectedType &&
    !(CONTENT_LIST_TYPE_OPTIONS as readonly string[]).includes(selectedType)
    ? selectedType
    : null,
);
const unlistedStatus = $derived(
  selectedStatus &&
    !(CONTENT_LIST_STATUS_OPTIONS as readonly string[]).includes(selectedStatus)
    ? selectedStatus
    : null,
);
const unlistedValueDrops = $derived<ContentListQueryDrop[]>([
  ...(unlistedType === null || lockedType !== null
    ? []
    : [
        {
          scope: 'filter' as const,
          reason: 'unlisted-value' as const,
          columnId: CONTENT_LIST_TYPE_FILTER_ID,
          detail: unlistedType,
        },
      ]),
  ...(unlistedStatus === null
    ? []
    : [
        {
          scope: 'filter' as const,
          reason: 'unlisted-value' as const,
          columnId: CONTENT_LIST_STATUS_FILTER_ID,
          detail: unlistedStatus,
        },
      ]),
]);

const surfaceOptions = $derived(
  dataSurface
    ? {
        registry: dataSurface.registry,
        descriptor:
          dataSurface.descriptor ??
          buildContentListSurfaceDescriptor({ columnLabels }),
      }
    : undefined,
);

// ---------------------------------------------------------------------------
// Restore reporting
// ---------------------------------------------------------------------------

const dropNotices = $derived<ContentListDropNotice[]>([
  ...restoreDrops,
  ...queryDrops,
  ...unlistedValueDrops,
  ...(pageCapDrop === null ? [] : [pageCapDrop]),
]);
/**
 * What the server said about the completeness of the answer.
 *
 * A binding may expose the flags directly; `remoteQuery` does not, so the
 * component falls back to the envelope its own `execute` resolved. Either way
 * the operator has to be told: the server drops trailing rows to fit its byte
 * budget, and the next page is computed from `page * limit`, so those rows are
 * skipped on the following page too.
 */
const queryTruncated = $derived(
  queryBinding?.truncated ?? resultNotices.truncated,
);
const queryWarnings = $derived<ReadonlyArray<string>>(
  queryBinding?.warnings ?? resultNotices.warnings,
);
/** Identity of the current set of refusals, so a dismissal is not permanent. */
const dropNoticeKey = $derived(
  dropNotices.length > 0 || queryTruncated || queryWarnings.length > 0
    ? JSON.stringify([dropNotices, queryTruncated, queryWarnings])
    : '',
);
const showDropNotice = $derived(
  dropNoticeKey !== '' && dropNoticeKey !== dismissedDropKey,
);

const DROP_REASON_MESSAGES: Record<
  ContentListStateDropReason | ContentListQueryDropReason,
  string
> = {
  'unknown-column': M['content.content_list.drop_unknown_column'],
  'hidden-column': M['content.content_list.drop_hidden_column'],
  'structural-column': M['content.content_list.drop_structural_column'],
  'no-server-field': M['content.content_list.drop_no_server_field'],
  'unsupported-operator': M['content.content_list.drop_unsupported_operator'],
  'unsupported-value': M['content.content_list.drop_unsupported_value'],
  malformed: M['content.content_list.drop_malformed'],
  'out-of-range': M['content.content_list.drop_out_of_range'],
  'unlisted-value': M['content.content_list.drop_unlisted_value'],
  'unpaginated-unsupported': M['content.content_list.drop_unpaginated'],
};

function dropNoticeText(drop: ContentListDropNotice): string {
  // A capped offset is a redirect, not merely a refused value: the operator
  // needs to know which page they asked for and which one they are looking at.
  if (drop.reason === 'unlisted-value') {
    return t(M['content.content_list.drop_unlisted_value'], {
      value: drop.detail ?? '',
    });
  }
  if (drop.scope === 'page' && drop.reason === 'out-of-range') {
    return t(M['content.content_list.drop_page_unreachable'], {
      requested: drop.detail ?? '',
      landed: String(pageCapCorrectedTo ?? ''),
    });
  }
  return t(M['content.content_list.dropped_item'], {
    target: drop.columnId ?? drop.scope,
    reason: t(DROP_REASON_MESSAGES[drop.reason]),
  });
}

function dismissDropNotice() {
  dismissedDropKey = dropNoticeKey;
}

// ---------------------------------------------------------------------------
// Saved views
// ---------------------------------------------------------------------------

$effect(() => {
  const store = savedViews;
  if (!store) {
    savedViewList = [];
    return;
  }
  let cancelled = false;
  void store
    .list()
    .then((views) => {
      if (!cancelled) savedViewList = views;
    })
    .catch(() => {
      // An unreadable store is an empty store; the list still opens.
      if (!cancelled) savedViewList = [];
    });
  return () => {
    cancelled = true;
  };
});

async function reloadSavedViews() {
  if (!savedViews) return;
  try {
    savedViewList = await savedViews.list();
  } catch {
    savedViewList = [];
  }
}

function applySavedView(id: string) {
  selectedSavedViewId = id;
  const view = savedViewList.find((entry) => entry.id === id);
  if (!view) return;
  try {
    // The same validator, AND the same limits, the URL path uses: a stored view
    // must not be a way around a `maxPageSize` the host configured for links. A
    // stale view restores its valid remainder rather than refusing to open.
    const restoration = restoreContentListSavedView(view, restoreOptions);
    applyContentListViewState(controller, restoration.state, restoreOptions);
    restoreDrops = restoration.dropped;
  } catch {
    restoreDrops = [{ scope: 'state', reason: 'malformed' }];
  }
}

async function saveCurrentView() {
  const store = savedViews;
  const name = savedViewName.trim();
  if (!store || !name) return;
  try {
    const saved = await store.save(
      toContentListSavedViewInput(name, controller.snapshot()),
    );
    savedViewName = '';
    selectedSavedViewId = saved.id;
    await reloadSavedViews();
  } catch {
    // Keep the operator's text so the save can be retried.
  }
}

async function deleteSelectedView() {
  const store = savedViews;
  const id = selectedSavedViewId;
  if (!store || !id) return;
  try {
    await store.delete(id);
    selectedSavedViewId = '';
    await reloadSavedViews();
  } catch {
    // Nothing to undo; the list is reloaded on the next mount.
  }
}

function isSelected(row: ContentListRow): boolean {
  return selectedRowKeys.has(String(row.id));
}

function toggleRow(row: ContentListRow) {
  if (!row.identified) return;
  controller.dispatch({ type: 'toggleRowSelection', rowId: row.id });
}

function togglePageSelection() {
  const remaining = tableState.selectedRowIds.filter(
    (rowId) =>
      !selectablePageRowIds.some(
        (pageRowId) => String(pageRowId) === String(rowId),
      ),
  );
  controller.dispatch({
    type: 'setSelectedRows',
    rowIds: allPageSelected
      ? remaining
      : [...remaining, ...selectablePageRowIds],
  });
}

function clearSelection() {
  controller.dispatch({ type: 'setSelectedRows', rowIds: [] });
}

function handlePageChange(page: number) {
  controller.dispatch({ type: 'setPage', page });
}

function handleSearch(value: string) {
  controller.dispatch({ type: 'setSearch', search: value });
}

function handleFilter(columnId: string, value: string) {
  applyContentListFilter(controller, columnId, value || null);
}

function rowActions(row: ContentListRow) {
  return contentListRowActions(row, { getViewHref });
}

function viewHref(row: ContentListRow): string | null {
  return resolveContentHref(row.content, getViewHref);
}

function selectRowLabel(row: ContentListRow): string {
  return isSelected(row)
    ? t(M['content.content_list.deselect_row'], { title: row.title })
    : t(M['content.content_list.select_row'], { title: row.title });
}

function handleDeleteContent(row: ContentListRow) {
  pendingDelete = row;
}

function confirmDelete() {
  const target = pendingDelete;
  pendingDelete = null;
  if (target) {
    onDelete(target.content);
  }
}

function cancelDelete() {
  pendingDelete = null;
}

/**
 * Compact mode renders the shared columns with content-specific cells.
 *
 * Selection is a content-owned column rather than DataTable's built-in one:
 * DataTable has no per-row selection predicate, so its header select-all would
 * address the synthetic id of an unidentified row, which the normalization
 * effect then strips — leaving the header permanently indeterminate. Owning the
 * column keeps compact select-all identical to the card presentations.
 */
const tableColumns: DataTableColumn<ContentListRow>[] = $derived([
  {
    id: CONTENT_LIST_SELECTION_COLUMN_ID,
    label: t(M['content.content_list.select_all']),
    role: 'action',
    align: 'center',
    width: '3rem',
    sortable: false,
    searchable: false,
    filterable: false,
    header: selectHeader,
    cell: selectCell,
  },
  ...queryColumns.map((column) => {
    if (column.id === 'type') return { ...column, cell: typeCell };
    if (column.id === 'title') return { ...column, cell: titleCell };
    if (column.id === 'status') return { ...column, cell: statusCell };
    if (column.id === 'state') return { ...column, cell: stateCell };
    if (column.id === 'publish') return { ...column, cell: publishCell };
    if (column.id === 'updated') return { ...column, cell: updatedCell };
    return column;
  }),
  {
    id: CONTENT_LIST_ACTIONS_COLUMN_ID,
    label: t(M['content.content_list.actions_column']),
    role: 'action',
    align: 'right',
    sortable: false,
    searchable: false,
    filterable: false,
    cell: actionsCell,
  },
]);
</script>

{#snippet tableEmptyState()}
  <p class="table-empty-state">{t(M['content.content_list.empty'])}</p>
{/snippet}

{#snippet selectHeader()}
  <Checkbox
    checked={allPageSelected}
    indeterminate={somePageSelected}
    aria-label={t(M['content.content_list.select_all'])}
    onchange={togglePageSelection}
  />
{/snippet}

{#snippet selectCell({ row }: { row: ContentListRow })}
  <Checkbox
    checked={isSelected(row)}
    disabled={!row.identified}
    aria-label={selectRowLabel(row)}
    title={row.identified
      ? undefined
      : t(M['content.content_list.row_not_selectable'])}
    onchange={() => toggleRow(row)}
  />
{/snippet}

{#snippet typeCell({ row }: { row: ContentListRow })}
  <span class={`type-pill type-pill--${row.type}`}>{row.typeLabel}</span>
{/snippet}

{#snippet titleCell({ row }: { row: ContentListRow })}
  {#if viewHref(row)}
    <a class="title-link" href={viewHref(row)}>{row.title}</a>
  {:else}
    <strong>{row.title}</strong>
  {/if}
{/snippet}

{#snippet statusCell({ row }: { row: ContentListRow })}
  <span class="badge status-{contentStatusVariant(row.status)}">{row.statusLabel}</span>
{/snippet}

{#snippet stateCell({ row }: { row: ContentListRow })}
  <span class="badge state-{contentStateVariant(row.state)}">{row.stateLabel}</span>
{/snippet}

{#snippet publishCell({ row }: { row: ContentListRow })}
  {row.publishLabel || '-'}
{/snippet}

{#snippet updatedCell({ row }: { row: ContentListRow })}
  {row.updatedLabel || '-'}
{/snippet}

{#snippet actionsCell({ row }: { row: ContentListRow })}
  {@const actions = rowActions(row)}
  <div class="actions-cell">
    {#if actions.includes('view')}
      <a
        class="icon-btn"
        href={viewHref(row)}
        title={t(M['content.content_list.view_published_article'])}
        aria-label={t(M['content.content_list.view_published_article'])}
      >
        <span aria-hidden="true">🔎</span>
      </a>
    {/if}
    {#if actions.includes('edit')}
      <Button
        variant="ghost"
        size="sm"
        class="icon-btn"
        type="button"
        onclick={() => onEdit(row.content)}
        title={t(M['content.content_list.edit'])}
        aria-label={t(M['content.content_list.edit'])}
      >
        <span aria-hidden="true">✏️</span>
      </Button>
    {/if}
    {#if actions.includes('delete')}
      <Button
        variant="ghost"
        size="sm"
        class="icon-btn delete-icon"
        type="button"
        onclick={() => handleDeleteContent(row)}
        title={t(M['content.content_list.delete'])}
        aria-label={t(M['content.content_list.delete'])}
      >
        <span aria-hidden="true">🗑️</span>
      </Button>
    {/if}
  </div>
{/snippet}

<div class="content-list-wrapper">

  <div class="content-controls">
    <div class="search-filters">
      <Input
        type="text"
        placeholder={t(M['content.content_list.search_placeholder'])}
        aria-label={t(M['content.content_list.search_label'])}
        value={tableState.search}
        oninput={(event: Event) =>
          handleSearch((event.currentTarget as HTMLInputElement).value)}
      />

      {#if !lockedType}
        <Select
          aria-label={t(M['content.content_list.filter_type'])}
          value={selectedType}
          onchange={(event: Event) =>
            handleFilter(
              CONTENT_LIST_TYPE_FILTER_ID,
              (event.currentTarget as HTMLSelectElement).value,
            )}
        >
          <option value="">{t(M['content.content_list.all_types'])}</option>
          <option value="article">{t(M['content.content_list.type_articles'])}</option>
          <option value="document">{t(M['content.content_list.type_documents'])}</option>
          <option value="mirror">{t(M['content.content_list.type_mirrors'])}</option>
          {#if unlistedType}
            <!-- A live filter the vocabulary does not cover; showing it is what
                 keeps the toolbar honest about why the list may be empty. -->
            <option value={unlistedType}>{unlistedType}</option>
          {/if}
        </Select>
      {/if}

      <Select
        aria-label={t(M['content.content_list.filter_status'])}
        value={selectedStatus}
        onchange={(event: Event) =>
          handleFilter(
            CONTENT_LIST_STATUS_FILTER_ID,
            (event.currentTarget as HTMLSelectElement).value,
          )}
      >
        <option value="">{t(M['content.content_list.all_statuses'])}</option>
        <option value="published">{t(M['content.content_list.status_published'])}</option>
        <option value="draft">{t(M['content.content_list.status_draft'])}</option>
        <option value="review">{t(M['content.content_list.status_review'])}</option>
        <option value="archived">{t(M['content.content_list.status_archived'])}</option>
        {#if unlistedStatus}
          <option value={unlistedStatus}>{unlistedStatus}</option>
        {/if}
      </Select>

      {#if savedViews}
        <div class="saved-views" role="group" aria-label={t(M['content.content_list.saved_views'])}>
          <Select
            aria-label={t(M['content.content_list.saved_views'])}
            value={selectedSavedViewId}
            onchange={(event: Event) =>
              applySavedView((event.currentTarget as HTMLSelectElement).value)}
          >
            <option value="">{t(M['content.content_list.saved_view_none'])}</option>
            {#each savedViewList as view (view.id)}
              <option value={view.id}>{view.name}</option>
            {/each}
          </Select>
          <Input
            type="text"
            aria-label={t(M['content.content_list.saved_view_name'])}
            placeholder={t(M['content.content_list.saved_view_name_placeholder'])}
            value={savedViewName}
            oninput={(event: Event) => {
              savedViewName = (event.currentTarget as HTMLInputElement).value;
            }}
          />
          <Button
            variant="ghost"
            size="sm"
            type="button"
            disabled={savedViewName.trim().length === 0}
            onclick={() => void saveCurrentView()}
          >
            {t(M['content.content_list.saved_view_save'])}
          </Button>
          {#if selectedSavedViewId}
            <Button
              variant="ghost"
              size="sm"
              type="button"
              onclick={() => void deleteSelectedView()}
            >
              {t(M['content.content_list.saved_view_delete'])}
            </Button>
          {/if}
        </div>
      {/if}

      {#if controls}
        {@render controls()}
      {/if}
    </div>

    <div class="actions-group">
      <div class="view-toggles" role="group" aria-label={t(M['content.content_list.view_mode'])}>
        <Button
          variant="ghost"
          size="sm"
          type="button"
          class={`view-toggle-btn${viewMode === 'grid' ? ' view-toggle-btn--active' : ''}`}
          aria-pressed={viewMode === 'grid'}
          onclick={() => viewMode = 'grid'}
          aria-label={t(M['content.content_list.grid_view'])}
          title={t(M['content.content_list.grid_view'])}
        >
          <svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" stroke-width="2" fill="none" aria-hidden="true">
            <rect x="3" y="3" width="7" height="7"></rect>
            <rect x="14" y="3" width="7" height="7"></rect>
            <rect x="14" y="14" width="7" height="7"></rect>
            <rect x="3" y="14" width="7" height="7"></rect>
          </svg>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          type="button"
          class={`view-toggle-btn${viewMode === 'detailed' ? ' view-toggle-btn--active' : ''}`}
          aria-pressed={viewMode === 'detailed'}
          onclick={() => viewMode = 'detailed'}
          aria-label={t(M['content.content_list.detailed_list'])}
          title={t(M['content.content_list.detailed_list'])}
        >
          <svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" stroke-width="2" fill="none" aria-hidden="true">
            <line x1="8" y1="6" x2="21" y2="6"></line>
            <line x1="8" y1="12" x2="21" y2="12"></line>
            <line x1="8" y1="18" x2="21" y2="18"></line>
            <line x1="3" y1="6" x2="3.01" y2="6"></line>
            <line x1="3" y1="12" x2="3.01" y2="12"></line>
            <line x1="3" y1="18" x2="3.01" y2="18"></line>
          </svg>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          type="button"
          class={`view-toggle-btn${viewMode === 'compact' ? ' view-toggle-btn--active' : ''}`}
          aria-pressed={viewMode === 'compact'}
          onclick={() => viewMode = 'compact'}
          aria-label={t(M['content.content_list.compact_list'])}
          title={t(M['content.content_list.compact_list'])}
        >
          <svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" stroke-width="2" fill="none" aria-hidden="true">
            <line x1="3" y1="6" x2="21" y2="6"></line>
            <line x1="3" y1="12" x2="21" y2="12"></line>
            <line x1="3" y1="18" x2="21" y2="18"></line>
          </svg>
        </Button>
      </div>

      <Button variant="ghost" class="add-button" type="button" onclick={() => onAdd()}>
        <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none" aria-hidden="true">
          <line x1="12" y1="5" x2="12" y2="19"></line>
          <line x1="5" y1="12" x2="19" y2="12"></line>
        </svg>
        {t(M['content.content_list.add_content'])}
      </Button>
    </div>
  </div>

  {#if showDropNotice}
    <div class="state-notice" role="status">
      <p class="state-notice__title">{t(M['content.content_list.dropped_title'])}</p>
      <ul class="state-notice__list">
        {#each dropNotices as drop, index (index)}
          <li>{dropNoticeText(drop)}</li>
        {/each}
        {#if queryTruncated}
          <li>{t(M['content.content_list.result_truncated'])}</li>
        {/if}
        {#each queryWarnings as warning, index (index)}
          <li>{warning}</li>
        {/each}
      </ul>
      <Button
        variant="ghost"
        size="sm"
        type="button"
        class="state-notice__dismiss"
        onclick={dismissDropNotice}
      >
        {t(M['content.content_list.dropped_dismiss'])}
      </Button>
    </div>
  {/if}

  {#if activeError}
    <div class="state-panel state-panel--error" role="alert">
      <p class="state-panel__title">{t(M['content.content_list.error_title'])}</p>
      <p class="state-panel__detail">{activeError}</p>
      {#if retryHandler}
        <Button variant="ghost" type="button" class="retry-button" onclick={() => retryHandler?.()}>
          {t(M['content.content_list.retry'])}
        </Button>
      {/if}
    </div>
  {:else}
    {#if pageRows.length > 0 || selectedCount > 0}
      <div class="content-selection">
        {#if viewMode !== 'compact'}
          <Checkbox
            checked={allPageSelected}
            indeterminate={somePageSelected}
            aria-label={t(M['content.content_list.select_all'])}
            onchange={togglePageSelection}
          />
        {/if}
        <span class="content-selection__count" aria-live="polite">
          {t(M['content.content_list.selection_count'], { count: selectedCount })}
        </span>
        {#if selectedCount > 0}
          <Button variant="ghost" size="sm" type="button" class="clear-selection" onclick={clearSelection}>
            {t(M['content.content_list.clear_selection'])}
          </Button>
        {/if}
      </div>
    {/if}

    {#if refreshing && viewMode !== 'compact'}
      <!-- DataTable announces its own refresh; the card views need their own. -->
      <p class="content-refreshing" role="status" aria-live="polite">
        {t(M['content.content_list.refreshing'])}
      </p>
    {/if}

    {#if viewMode === 'compact'}
      <!--
        The compact table stays mounted for empty and loading results: it owns
        the mounted data surface, so unmounting it on a zero-row query would
        unregister the surface and leave an agent unable to undo its own search.
      -->
      <div class="content-table-wrapper">
        <DataTable
          data={pageRows}
          totalRows={dataTableTotalRows}
          columns={tableColumns}
          rowKey={CONTENT_LIST_ROW_KEY}
          {controller}
          sortable
          agentAddressable
          loading={isLoading}
          caption={t(M['content.content_list.table_caption'])}
          rowLabel={(row: ContentListRow) => row.title}
          dataSurface={surfaceOptions}
          empty={tableEmptyState}
        />
      </div>
    {:else if isLoading && pageRows.length === 0}
      <div class="state-panel" role="status">
        {t(M['content.content_list.loading'])}
      </div>
    {:else if pageRows.length === 0}
      <div class="state-panel empty-state">
        {t(M['content.content_list.empty'])}
      </div>
    {:else if viewMode === 'detailed'}
      <div class="content-detailed">
        {#each pageRows as row (row.id)}
          {@const content = row.content}
          {@const actions = rowActions(row)}
          <article class="content-row">
            <div class="content-row__select">
              <Checkbox
                checked={isSelected(row)}
                disabled={!row.identified}
                aria-label={selectRowLabel(row)}
                title={row.identified
                  ? undefined
                  : t(M['content.content_list.row_not_selectable'])}
                onchange={() => toggleRow(row)}
              />
            </div>

            <div class="content-row__main">
              <div class="content-row__eyebrow">
                <span class={`type-pill type-pill--${row.type}`}>{row.typeLabel}</span>
                {#if row.author}
                  <span class="content-row__author">By {row.author}</span>
                {/if}
              </div>

              <h3>{row.title}</h3>

              {#if row.description}
                <p class="content-row__description">{row.description}</p>
              {/if}

              {#if content.url || content.fileKey}
                <div class="content-row__links">
                  {#if content.url}
                    <a href={content.url} target="_blank" rel="noreferrer">
                      {t(M['content.content_list.source_material'])}
                    </a>
                  {/if}
                  {#if content.fileKey}
                    <span>{content.fileKey}</span>
                  {/if}
                </div>
              {/if}
            </div>

            <div class="content-row__meta">
              <span class="meta-label">{t(M['content.content_list.column_status'])}</span>
              <span class="badge status-{contentStatusVariant(row.status)}">{row.statusLabel}</span>
              <span class="meta-label">{t(M['content.content_list.column_state'])}</span>
              <span class="badge state-{contentStateVariant(row.state)}">{row.stateLabel}</span>
            </div>

            <div class="content-row__actions">
              {#if actions.includes('view')}
                <a href={viewHref(row)} class="quiet-action">{t(M['content.content_list.view_article'])}</a>
              {/if}
              {#if actions.includes('edit')}
                <Button variant="ghost" type="button" class="quiet-action" onclick={() => onEdit(content)}>
                  {t(M['content.content_list.edit'])}
                </Button>
              {/if}
              {#if actions.includes('delete')}
                <Button
                  variant="ghost"
                  type="button"
                  class="quiet-action quiet-action--danger"
                  onclick={() => handleDeleteContent(row)}
                >
                  {t(M['content.content_list.delete'])}
                </Button>
              {/if}
            </div>
          </article>
        {/each}
      </div>
    {:else}
      <div class="content-grid">
        {#each pageRows as row (row.id)}
          {@const content = row.content}
          {@const actions = rowActions(row)}
          <div class="content-card">
            {#if content.thumbnailAssetId}
              <div class="card-thumbnail">
                <ImageThumbnail
                  apiBaseUrl={apiBaseUrl}
                  assetId={content.thumbnailAssetId}
                />
              </div>
            {/if}
            <div class="content-header">
              <div class="content-header__eyebrow">
                <Checkbox
                  checked={isSelected(row)}
                  disabled={!row.identified}
                  aria-label={selectRowLabel(row)}
                  title={row.identified
                    ? undefined
                    : t(M['content.content_list.row_not_selectable'])}
                  onchange={() => toggleRow(row)}
                />
                <span class={`type-pill type-pill--${row.type}`}>{row.typeLabel}</span>
                {#if row.author}
                  <div class="author">{row.author}</div>
                {/if}
              </div>
              <h3>{row.title}</h3>
            </div>

            <div class="content-meta">
              <div>{row.typeLabel}</div>
              <div class="badges">
                <span class="badge status-{contentStatusVariant(row.status)}">{row.statusLabel}</span>
                <span class="badge state-{contentStateVariant(row.state)}">{row.stateLabel}</span>
              </div>
            </div>

            <p class="content-description">{row.description}</p>

            <div class="content-footer">
              <div class="meta-links">
                {#if content.url}
                  <div class="source">Source: <a href={content.url} target="_blank" rel="noreferrer">{content.url}</a></div>
                {/if}
                {#if content.fileKey}
                  <div class="file">File: {content.fileKey}</div>
                {/if}
              </div>

              <div class="content-actions">
                {#if actions.includes('view')}
                  <a href={viewHref(row)} class="view-btn">{t(M['content.content_list.view_article_button'])}</a>
                {/if}
                {#if actions.includes('edit')}
                  <Button variant="ghost" type="button" class="content-action-btn" onclick={() => onEdit(content)}>
                    {t(M['content.content_list.edit'])}
                  </Button>
                {/if}
                {#if actions.includes('delete')}
                  <Button variant="ghost" type="button" class="content-action-btn delete-btn" onclick={() => handleDeleteContent(row)}>
                    {t(M['content.content_list.delete'])}
                  </Button>
                {/if}
              </div>
            </div>
          </div>
        {/each}
      </div>
    {/if}

    {#if showPagination && viewMode !== 'compact'}
      <div class="content-pagination">
        <Pagination
          currentPage={tableState.page}
          {totalPages}
          onPageChange={handlePageChange}
          aria-label={t(M['content.content_list.pagination'])}
        />
      </div>
    {/if}
  {/if}

</div>

<ConfirmDialog
  open={pendingDelete !== null}
  title={t(M['content.content_list.delete_confirm_title'])}
  message={t(M['content.content_list.delete_confirm_message'], {
    title: pendingDelete ? pendingDelete.title : '',
  })}
  confirmLabel={t(M['content.content_list.delete'])}
  cancelLabel={t(M['content.content_list.cancel'])}
  destructive
  onconfirm={confirmDelete}
  oncancel={cancelDelete}
/>

<style>
  .content-list-wrapper {
    display: flex;
    flex-direction: column;
    width: 100%;
  }

  .content-controls {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1.25rem;
    flex-wrap: wrap;
    gap: 1rem;
    background: var(--smrt-color-surface);
    padding: 0.9rem 1.1rem;
    border-radius: 0.75rem;
    box-shadow: var(--smrt-elevation-1, 0 1px 3px rgba(0,0,0,0.1));
  }

  .search-filters {
    display: flex;
    gap: 1rem;
    flex-wrap: wrap;
    align-items: center;
  }

  .search-filters :global(.input),
  .search-filters :global(.select) {
    padding: 0.5rem 0.9rem;
    border: 1px solid var(--smrt-color-outline);
    border-radius: 0.5rem;
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    height: 38px;
    background: var(--smrt-color-surface-container-low);
    color: var(--smrt-color-on-surface);
  }

  .actions-group {
    display: flex;
    gap: 0.75rem;
    align-items: center;
  }

  .view-toggles {
    display: flex;
    background: var(--smrt-color-surface-container-low);
    border-radius: 0.5rem;
    padding: 0.25rem;
    border: 1px solid var(--smrt-color-outline-variant);
  }

  .view-toggles :global(.view-toggle-btn) {
    background: transparent;
    border: none;
    padding: 0.4rem;
    color: var(--smrt-color-on-surface-variant);
    border-radius: 0.375rem;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.2s;
  }

  .view-toggles :global(.view-toggle-btn:hover) {
    color: var(--smrt-color-on-surface);
    background: color-mix(in srgb, var(--smrt-color-shadow) 5%, transparent);
  }

  .view-toggles :global(.view-toggle-btn.view-toggle-btn--active) {
    background: var(--smrt-color-surface);
    color: var(--smrt-color-on-surface);
    box-shadow: var(--smrt-elevation-1, 0 1px 2px rgba(0,0,0,0.1));
  }

  .actions-group :global(.add-button) {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    background: linear-gradient(
      135deg,
      var(--smrt-color-primary) 0%,
      color-mix(in srgb, var(--smrt-color-primary) 80%, black) 100%
    );
    color: var(--smrt-color-on-primary);
    border: none;
    padding: 0.5rem 1rem;
    height: 38px;
    border-radius: 0.5rem;
    font-weight: var(--smrt-typography-weight-semibold, 600);
    cursor: pointer;
    transition: transform 0.2s, box-shadow 0.2s;
  }

  .actions-group :global(.add-button:hover) {
    transform: translateY(-1px);
    box-shadow: 0 4px 6px -1px color-mix(in srgb, var(--smrt-color-primary) 50%, transparent);
  }

  /* Selection summary shared by every presentation. */
  .content-selection {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.35rem 0.1rem 0.75rem;
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
  }

  .content-selection :global(input[type='checkbox']) {
    cursor: pointer;
  }

  .content-header__eyebrow,
  .content-row__eyebrow {
    display: flex;
    align-items: center;
    gap: 0.65rem;
    flex-wrap: wrap;
    margin-bottom: 0.55rem;
  }

  .type-pill {
    display: inline-flex;
    align-items: center;
    border-radius: var(--smrt-radius-full, 9999px);
    padding: 0.2rem 0.65rem;
    font-size: var(--smrt-typography-label-medium-size, 0.72rem);
    font-weight: var(--smrt-typography-weight-bold, 700);
    letter-spacing: var(--smrt-typography-label-medium-tracking, 0.06em);
    text-transform: uppercase;
    background: var(--smrt-color-surface-container-low);
    color: var(--smrt-color-on-surface-variant);
  }

  .type-pill--article {
    background: color-mix(in srgb, var(--smrt-color-primary) 11%, transparent);
    color: var(--smrt-color-primary);
  }

  .type-pill--document {
    background: color-mix(in srgb, var(--smrt-color-tertiary, #0f766e) 12%, transparent);
    color: var(--smrt-color-tertiary, #0f766e);
  }

  .type-pill--mirror {
    background: color-mix(in srgb, var(--smrt-color-secondary, #9333ea) 12%, transparent);
    color: var(--smrt-color-secondary, #9333ea);
  }

  /* Shared Card Styles */
  .content-card {
    background: var(--smrt-color-surface);
    border-radius: 0.75rem;
    padding: 1.5rem;
    border: 1px solid var(--smrt-color-outline-variant);
    transition: transform 0.2s, box-shadow 0.2s;
    display: flex;
    flex-direction: column;
  }

  .content-card:hover {
    transform: translateY(-2px);
    box-shadow: var(--smrt-elevation-3, 0 10px 25px -3px rgba(0, 0, 0, 0.1));
  }

  .card-thumbnail {
    width: calc(100% + 3rem);
    margin: -1.5rem -1.5rem 1rem -1.5rem;
    height: 160px;
    border-bottom: 1px solid var(--smrt-color-outline-variant);
    overflow: hidden;
    background: var(--smrt-color-surface-container-high, #242424);
  }

  .content-header {
    margin-bottom: 1rem;
  }

  .content-header h3 {
    margin: 0 0 0.25rem 0;
    color: var(--smrt-color-on-surface);
    font-size: var(--smrt-typography-title-large-size, 1.25rem);
    line-height: var(--smrt-typography-title-large-line-height, 1.3);
  }

  .author {
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
  }

  .content-meta {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1rem;
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    color: var(--smrt-color-on-surface-variant);
  }

  .badges {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .badge {
    padding: 0.25rem 0.6rem;
    border-radius: var(--smrt-radius-full, 9999px);
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
    font-weight: var(--smrt-typography-weight-semibold, 600);
    text-transform: uppercase;
    letter-spacing: var(--smrt-typography-label-medium-tracking, 0.05em);
  }

  .status-published { background: var(--smrt-color-success-container); color: var(--smrt-color-on-success-container); border: 1px solid var(--smrt-color-success); }
  .status-draft { background: var(--smrt-color-warning-container); color: var(--smrt-color-on-warning-container); border: 1px solid var(--smrt-color-warning); }
  .status-archived { background: var(--smrt-color-surface-container); color: var(--smrt-color-on-surface-variant); border: 1px solid var(--smrt-color-outline-variant); }

  .state-highlighted { background: var(--smrt-color-warning-container); color: var(--smrt-color-on-warning-container); border: 1px solid var(--smrt-color-warning);}
  .state-active { background: var(--smrt-color-success-container); color: var(--smrt-color-on-success-container); border: 1px solid var(--smrt-color-success); }
  .state-deprecated { background: var(--smrt-color-error-container); color: var(--smrt-color-on-error-container); border: 1px solid var(--smrt-color-error); }

  .content-description {
    color: var(--smrt-color-on-surface-variant);
    line-height: 1.6;
    margin-bottom: 1.5rem;
    flex: 1;
  }

  .content-footer {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    margin-top: auto;
  }

  .meta-links {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .source, .file {
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
    color: var(--smrt-color-on-surface-variant);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .source a {
    color: var(--smrt-color-primary);
    text-decoration: none;
  }

  .source a:hover {
    text-decoration: underline;
  }

  .content-actions {
    display: flex;
    gap: 0.75rem;
    margin-top: 0.5rem;
    border-top: 1px solid var(--smrt-color-outline-variant);
    padding-top: 1rem;
  }

  .content-actions :global(.content-action-btn),
  .content-actions a {
    flex: 1;
    padding: 0.5rem 1rem;
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 0.375rem;
    background: var(--smrt-color-surface-container-low);
    color: var(--smrt-color-on-surface);
    font-size: var(--smrt-typography-label-large-size, 0.875rem);
    font-weight: var(--smrt-typography-weight-medium, 500);
    cursor: pointer;
    transition: all 0.2s;
    text-align: center;
    text-decoration: none;
  }

  .content-actions :global(.content-action-btn:hover),
  .content-actions a:hover {
    background: var(--smrt-color-surface-variant);
    border-color: var(--smrt-color-outline);
  }

  .view-btn {
    color: var(--smrt-color-primary) !important;
  }

  .content-actions :global(.delete-btn) {
    color: var(--smrt-color-error) !important;
  }

  .content-actions :global(.delete-btn:hover) {
    background: var(--smrt-color-error-container) !important;
    border-color: var(--smrt-color-error) !important;
  }

  /* GRID View Specifics */
  .content-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
    gap: 1.5rem;
  }

  /* DETAILED View Specifics */
  .content-detailed {
    display: flex;
    flex-direction: column;
    gap: 0;
    border-top: 1px solid var(--smrt-color-outline-variant);
  }

  .content-row {
    display: grid;
    grid-template-columns: auto minmax(0, 1.8fr) auto auto;
    gap: 1.25rem;
    align-items: start;
    padding: 1.1rem 0;
    border-bottom: 1px solid var(--smrt-color-outline-variant);
  }

  .content-row__select {
    padding-top: 0.25rem;
  }

  .content-row h3 {
    margin: 0;
    font-size: var(--smrt-typography-title-medium-size, 1.1rem);
    line-height: var(--smrt-typography-title-medium-line-height, 1.3);
  }

  .content-row__description {
    margin: 0.45rem 0 0;
    color: var(--smrt-color-on-surface-variant);
    line-height: 1.55;
  }

  .content-row__meta {
    display: grid;
    gap: 0.45rem;
    justify-items: start;
    align-content: start;
    min-width: 7.25rem;
  }

  .meta-label {
    font-size: var(--smrt-typography-label-medium-size, 0.72rem);
    text-transform: uppercase;
    letter-spacing: var(--smrt-typography-label-medium-tracking, 0.06em);
    font-weight: var(--smrt-typography-weight-bold, 700);
    color: var(--smrt-color-on-surface-variant);
  }

  .content-row__actions {
    display: grid;
    gap: 0.55rem;
    justify-items: stretch;
    min-width: 8.5rem;
  }

  .content-row__actions :global(.quiet-action) {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 2.4rem;
    padding: 0 0.85rem;
    border-radius: var(--smrt-radius-full, 9999px);
    border: 1px solid var(--smrt-color-outline-variant);
    background: transparent;
    color: var(--smrt-color-on-surface);
    font-weight: var(--smrt-typography-weight-semibold, 600);
    text-decoration: none;
    cursor: pointer;
  }

  .content-row__actions :global(.quiet-action:hover) {
    background: var(--smrt-color-surface-container-low);
  }

  .content-row__actions :global(.quiet-action--danger) {
    color: var(--smrt-color-error);
  }

  .content-row__links {
    display: flex;
    gap: 0.9rem;
    flex-wrap: wrap;
    margin-top: 0.8rem;
    font-size: var(--smrt-typography-body-medium-size, 0.82rem);
    color: var(--smrt-color-on-surface-variant);
  }

  .content-row__links a {
    color: var(--smrt-color-primary);
    text-decoration: none;
  }

  .content-row__author {
    font-size: var(--smrt-typography-body-medium-size, 0.85rem);
    color: var(--smrt-color-on-surface-variant);
  }

  /* COMPACT View Specifics */
  .content-table-wrapper {
    background: var(--smrt-color-surface);
    border-radius: 0.75rem;
    border: 1px solid var(--smrt-color-outline-variant);
    overflow: hidden;
    box-shadow: var(--smrt-elevation-1, 0 1px 3px rgba(0,0,0,0.05));
  }

  .content-refreshing {
    margin: 0 0 0.75rem;
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
  }

  .content-pagination {
    display: flex;
    justify-content: center;
    margin-top: 1.25rem;
  }

  .table-empty-state {
    margin: 0;
    padding: 1.5rem 0;
    text-align: center;
    color: var(--smrt-color-on-surface-variant);
  }

  .title-link {
    color: var(--smrt-color-primary);
    font-weight: var(--smrt-typography-weight-semibold, 600);
    text-decoration: none;
  }

  .title-link:hover {
    text-decoration: underline;
  }

  .actions-cell {
    display: flex;
    justify-content: flex-end;
    gap: 0.15rem;
    white-space: nowrap;
  }

  .actions-cell :global(.icon-btn) {
    background: transparent;
    border: none;
    cursor: pointer;
    font-size: var(--smrt-typography-title-medium-size, 1.1rem);
    padding: 0.25rem;
    border-radius: 0.25rem;
    transition: background 0.2s;
    opacity: 0.7;
    text-decoration: none;
  }

  .actions-cell :global(.icon-btn:hover) {
    background: var(--smrt-color-surface-variant);
    opacity: 1;
  }

  .actions-cell :global(.delete-icon:hover) {
    background: var(--smrt-color-error-container);
  }

  /* Saved views live beside the search and filters they name. */
  .saved-views {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    flex-wrap: wrap;
  }

  /* Reports what a restored link, saved view, or server query discarded. */
  .state-notice {
    margin-bottom: 1rem;
    padding: 0.75rem 1rem;
    border-radius: 0.5rem;
    border: 1px solid var(--smrt-color-outline-variant);
    background: var(--smrt-color-surface-container-low);
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
  }

  .state-notice__title {
    margin: 0 0 0.35rem;
    font-weight: var(--smrt-typography-weight-semibold, 600);
    color: var(--smrt-color-on-surface);
  }

  .state-notice__list {
    margin: 0 0 0.5rem;
    padding-left: 1.25rem;
  }

  .state-notice :global(.state-notice__dismiss) {
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 0.375rem;
    padding: 0.25rem 0.75rem;
    cursor: pointer;
  }

  /* Shared empty, loading, and error presentation. */
  .state-panel {
    background: var(--smrt-color-surface);
    padding: 4rem;
    text-align: center;
    border-radius: 0.75rem;
    border: 1px dashed var(--smrt-color-outline);
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-body-large-size, 1.1rem);
  }

  .state-panel--error {
    border-style: solid;
    border-color: var(--smrt-color-error);
    color: var(--smrt-color-on-surface);
  }

  .state-panel__title {
    margin: 0 0 0.5rem;
    font-weight: var(--smrt-typography-weight-semibold, 600);
  }

  .state-panel__detail {
    margin: 0 0 1rem;
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
  }

  .state-panel :global(.retry-button) {
    border: 1px solid var(--smrt-color-outline);
    border-radius: 0.5rem;
    padding: 0.5rem 1rem;
    cursor: pointer;
  }

  @media (max-width: 960px) {
    .content-row {
      grid-template-columns: auto minmax(0, 1fr);
      gap: 0.9rem;
    }

    .content-row__actions {
      grid-auto-flow: column;
      grid-auto-columns: 1fr;
      min-width: 0;
    }
  }

  @media (max-width: 720px) {
    .content-controls {
      align-items: stretch;
    }

    .search-filters,
    .actions-group {
      width: 100%;
    }

    .search-filters :global(.input),
    .search-filters :global(.select),
    .add-button {
      width: 100%;
    }

    .actions-group {
      justify-content: space-between;
      flex-wrap: wrap;
    }

    .content-row__actions {
      grid-auto-flow: row;
    }
  }
</style>
