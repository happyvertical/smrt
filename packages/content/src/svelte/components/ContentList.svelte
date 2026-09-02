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
  type DataSurfaceActionResult,
  type DataSurfaceIdentity,
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
import type { ContentListLifecycleBinding } from '../content-list-lifecycle.js';
import {
  readContentListLifecycleSummary,
  reconcileContentListLifecycleSelection,
} from '../content-list-lifecycle.js';
import {
  registerContentListDataSurface,
  type ContentListSurfaceContext,
  type ContentListSurfaceHandle,
} from '../content-list-data-surface.js';
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
  CONTENT_LIST_UNREPRESENTABLE_OPTION,
  type ContentListSelectFilterState,
  isContentListFilterExactly,
  normalizeContentListTypeLock,
  paginateContentListRows,
  readContentListSelectFilter,
  resolveContentHref,
  selectableContentListRowIds,
  selectContentListRows,
  toContentListRows,
} from '../content-list-controller.js';
import {
  CONTENT_LIST_QUERY_DEFAULT_PAGE_SIZE,
  type ContentListDataQueryRequest,
  type ContentListQueryDrop,
  type ContentListQueryDropReason,
  type ContentListQueryNotices,
  type ContentListQueryRequestOptions,
  type ContentListQuerySource,
  contentListQueryErrorMessage,
  contentListQueryExactTotal,
  contentListQueryRowsToContents,
  contentListQueryTotalValue,
  CONTENT_LIST_QUERY_MAX_OFFSET,
  contentListQueryRequestKey,
  contentListViewStateToDataQueryRequest,
  readContentListQueryNotices,
  resolveContentListMaxPageSize,
} from '../content-list-query.js';
import {
  contentListJobAffectsQuery,
  type ContentListJob,
  type ContentListJobBinding,
  type ContentListJobSnapshot,
  type ContentListJobTarget,
} from '../content-list-runtime.js';
import {
  type ContentListSavedView,
  type ContentListSavedViewStore,
  restoreContentListSavedView,
  toContentListSavedViewInput,
} from '../content-list-saved-views.js';
import {
  type ContentListWorkflowBinding,
  ContentListWorkflowError,
  type ContentListWorkflowErrorReason,
  type ContentListWorkflowId,
  type ContentListWorkflowRequest,
  CONTENT_LIST_WORKFLOW_OPTIONS,
  contentListWorkflowOutcomes,
} from '../content-list-workflows.js';
import {
  applyContentListViewState,
  type ContentListStateDrop,
  type ContentListStateDropReason,
  type ContentListStateValidationOptions,
  mergeContentListViewStateIntoSearchParams,
  readContentListViewStateFromSearchParams,
} from '../content-list-url-state.js';
import { M } from '../i18n.contribution.js';
import ContentListLifecyclePanel from './ContentListLifecyclePanel.svelte';
import ImageThumbnail from './ImageThumbnail.svelte';

const { t } = useI18n();

const DEFAULT_CONTENT_LIST_SURFACE_IDENTITY: DataSurfaceIdentity = {
  surfaceId: 'content-list',
  kind: 'table',
};

function sameSurfaceIdentity(
  left: DataSurfaceIdentity,
  right: DataSurfaceIdentity,
): boolean {
  return (
    left.kind === right.kind &&
    left.surfaceId === right.surfaceId &&
    left.subject?.type === right.subject?.type &&
    left.subject?.id === right.subject?.id
  );
}

function resolveSurfaceAuthority(
  lifecycle: ContentListLifecycleBinding | undefined,
  workflows: ContentListWorkflowBinding | undefined,
): {
  identity?: DataSurfaceIdentity;
  maxSelectionSize?: number;
  lifecycle?: ContentListLifecycleBinding;
  workflows?: ContentListWorkflowBinding;
} {
  const lifecycleIdentity = lifecycle
    ? (lifecycle.identity ?? DEFAULT_CONTENT_LIST_SURFACE_IDENTITY)
    : undefined;
  const workflowIdentity = workflows
    ? (workflows.identity ?? DEFAULT_CONTENT_LIST_SURFACE_IDENTITY)
    : undefined;
  if (
    lifecycleIdentity &&
    workflowIdentity &&
    !sameSurfaceIdentity(lifecycleIdentity, workflowIdentity)
  ) {
    throw new Error(
      'ContentList lifecycle and workflow bindings must use the same data surface identity',
    );
  }
  const bindings = [lifecycle, workflows].filter(
    (binding): binding is ContentListLifecycleBinding | ContentListWorkflowBinding =>
      binding !== undefined,
  );
  const maxSelectionSize =
    bindings.length > 0
      ? Math.min(...bindings.map((binding) => binding.maxSelectionSize ?? 200))
      : undefined;
  return {
    ...(lifecycleIdentity ?? workflowIdentity
      ? { identity: lifecycleIdentity ?? workflowIdentity }
      : {}),
    ...(maxSelectionSize === undefined ? {} : { maxSelectionSize }),
    ...(lifecycle && lifecycleIdentity
      ? {
          lifecycle: {
            ...lifecycle,
            identity: lifecycleIdentity,
            ...(maxSelectionSize === undefined ? {} : { maxSelectionSize }),
          },
        }
      : {}),
    ...(workflows && workflowIdentity
      ? {
          workflows: {
            ...workflows,
            identity: workflowIdentity,
            ...(maxSelectionSize === undefined ? {} : { maxSelectionSize }),
          },
        }
      : {}),
  };
}

function reconcileSurfaceDescriptor(
  descriptor: import('@happyvertical/smrt-ui/data').DataSurfaceDescriptor,
  authority: ReturnType<typeof resolveSurfaceAuthority>,
): import('@happyvertical/smrt-ui/data').DataSurfaceDescriptor {
  if (
    authority.identity &&
    !sameSurfaceIdentity(descriptor.identity, authority.identity)
  ) {
    throw new Error(
      'ContentList custom data surface descriptor must use the lifecycle and workflow identity',
    );
  }
  if (
    authority.maxSelectionSize !== undefined &&
    descriptor.limits.maxSelectionSize !== authority.maxSelectionSize
  ) {
    throw new Error(
      'ContentList custom data surface descriptor must use the lifecycle and workflow selection limit',
    );
  }
  return descriptor;
}

const WORKFLOW_LABEL_MESSAGES: Record<
  ContentListWorkflowId,
  keyof typeof M
> = {
  'move-to-trash': M['content.content_list.workflow_move_to_trash'],
  'mark-draft': M['content.content_list.workflow_mark_draft'],
  'submit-review': M['content.content_list.workflow_submit_review'],
  publish: M['content.content_list.workflow_publish'],
  archive: M['content.content_list.workflow_archive'],
  restore: M['content.content_list.workflow_restore'],
  'automated-review': M['content.content_list.workflow_automated_review'],
  'format-body': M['content.content_list.workflow_format_body'],
  categorize: M['content.content_list.workflow_categorize'],
  optimize: M['content.content_list.workflow_optimize'],
};

const WORKFLOW_CONSEQUENCE_MESSAGES: Record<string, keyof typeof M> = {
  'Content leaves active views and becomes restorable from trash.':
    M['content.content_list.workflow_consequence_trash'],
  'Published content is no longer public.':
    M['content.content_list.workflow_consequence_unpublished'],
  'Content enters the review queue.':
    M['content.content_list.workflow_consequence_review_queue'],
  'Content becomes public and may create a publication snapshot.':
    M['content.content_list.workflow_consequence_published'],
  'Content leaves trash.':
    M['content.content_list.workflow_consequence_leave_trash'],
  'Publishing makes content public.':
    M['content.content_list.workflow_consequence_restore_published'],
  'Creates a review result and may create a review version.':
    M['content.content_list.workflow_consequence_review_result'],
  'The persisted content body may change.':
    M['content.content_list.workflow_consequence_body_change'],
  'The content category changes.':
    M['content.content_list.workflow_consequence_category_change'],
  'Content fields may be revised or completed.':
    M['content.content_list.workflow_consequence_fields_change'],
};

const WORKFLOW_REASON_MESSAGES: Record<string, keyof typeof M> = {
  not_deleted: M['content.content_list.workflow_reason_not_deleted'],
  publish_readiness_failed:
    M['content.content_list.workflow_reason_publish_readiness_failed'],
  deleted: M['content.content_list.workflow_reason_deleted'],
  already_draft: M['content.content_list.workflow_reason_already_draft'],
  requires_draft: M['content.content_list.workflow_reason_requires_draft'],
  invalid_status: M['content.content_list.workflow_reason_invalid_status'],
  already_archived: M['content.content_list.workflow_reason_already_archived'],
  governance_unavailable:
    M['content.content_list.workflow_reason_governance_unavailable'],
  review_policy_unavailable:
    M['content.content_list.workflow_reason_review_policy_unavailable'],
  review_kind_mismatch:
    M['content.content_list.workflow_reason_review_kind_mismatch'],
  handler_unavailable:
    M['content.content_list.workflow_reason_handler_unavailable'],
  requires_draft_or_review:
    M['content.content_list.workflow_reason_requires_draft_or_review'],
  not_found_or_denied:
    M['content.content_list.workflow_reason_not_found_or_denied'],
  row_revision_drifted:
    M['content.content_list.workflow_reason_row_revision_drifted'],
  permission_denied:
    M['content.content_list.workflow_reason_permission_denied'],
  not_found: M['content.content_list.workflow_reason_not_found'],
  stale_query_fingerprint:
    M['content.content_list.workflow_reason_stale_query_fingerprint'],
  matching_count_drifted:
    M['content.content_list.workflow_reason_matching_count_drifted'],
  limit_exceeded: M['content.content_list.workflow_reason_limit_exceeded'],
  invalid_request: M['content.content_list.workflow_reason_invalid_request'],
  invalid_payload: M['content.content_list.workflow_reason_invalid_payload'],
  confirmation_required:
    M['content.content_list.workflow_reason_confirmation_required'],
  stale_preview: M['content.content_list.workflow_reason_stale_preview'],
  denied: M['content.content_list.workflow_reason_denied'],
  unknown_permission:
    M['content.content_list.workflow_reason_unknown_permission'],
  execution_failed:
    M['content.content_list.workflow_reason_execution_failed'],
  idempotency_conflict:
    M['content.content_list.workflow_reason_idempotency_conflict'],
};

const WORKFLOW_TRANSPORT_MESSAGES: Record<
  ContentListWorkflowErrorReason,
  keyof typeof M
> = {
  network_failure: M['content.content_list.workflow_transport_network_failure'],
  invalid_json: M['content.content_list.workflow_transport_invalid_json'],
  http_error: M['content.content_list.workflow_transport_http_error'],
  invalid_result: M['content.content_list.workflow_transport_invalid_result'],
  invalid_job_status:
    M['content.content_list.workflow_transport_invalid_job_status'],
  invalid_job_result:
    M['content.content_list.workflow_transport_invalid_job_result'],
};

function workflowLabel(id: ContentListWorkflowId): string {
  return t(WORKFLOW_LABEL_MESSAGES[id]);
}

function workflowConsequenceLabel(consequence: string): string {
  return t(
    WORKFLOW_CONSEQUENCE_MESSAGES[consequence] ??
      M['content.content_list.workflow_consequence_unknown'],
  );
}

function workflowReasonLabel(
  reason: string | undefined,
  fallback: keyof typeof M,
  params?: Record<string, string | number>,
): string {
  return t((reason && WORKFLOW_REASON_MESSAGES[reason]) ?? fallback, params);
}

function workflowExceptionMessage(
  error: unknown,
  fallback: keyof typeof M,
): string {
  if (error instanceof ContentListWorkflowError) {
    return t(WORKFLOW_TRANSPORT_MESSAGES[error.reason], {
      status: error.status ?? '',
    });
  }
  return t(fallback);
}

function workflowScopeLabel(scope: string): string {
  switch (scope) {
    case 'explicit-ids':
      return t(M['content.content_list.workflow_scope_explicit_ids']);
    case 'current-page':
      return t(M['content.content_list.workflow_scope_current_page']);
    case 'all-matching':
      return t(M['content.content_list.workflow_scope_all_matching']);
    default:
      return scope;
  }
}

function workflowJobStatusLabel(status: string): string {
  switch (status) {
    case 'queued':
      return t(M['content.content_list.job_queued']);
    case 'running':
      return t(M['content.content_list.job_running']);
    case 'succeeded':
      return t(M['content.content_list.job_succeeded']);
    case 'failed':
      return t(M['content.content_list.job_failed']);
    case 'cancelled':
      return t(M['content.content_list.workflow_status_cancelled']);
    default:
      return status;
  }
}

/** One reported refusal, from a restore or from the query translation. */
type ContentListDropNotice = ContentListStateDrop | ContentListQueryDrop;

interface Props {
  /** Base URL for content API requests. */
  apiBaseUrl?: string;
  /**
   * Client-side rows. Ignored when `query` is supplied — the server then owns
   * filtering, sorting, and paging, and these rows would be a second, disagreeing
   * source of truth.
   */
  contents?: ContentData[];
  /** Filter content by this type; no filtering applied when omitted. */
  type?: string;
  /** Initial view layout mode for the content list. */
  defaultViewMode?: ContentListViewMode;
  /** Invoked when the user requests to edit a content item. */
  onEdit: (content: ContentData) => void;
  /** Invoked when the user requests to delete a content item. */
  onDelete: (content: ContentData) => void;
  /** Invoked when the user requests to create new content. */
  onAdd: () => void;
  /** Optional UI controls rendered above the content list. */
  controls?: Snippet;
  /** Returns a URL to view the published content; null hides the view link. */
  getViewHref?: (content: ContentData) => string | null;
  /** Announced uniformly by every presentation; #2455 extends it. */
  loading?: boolean;
  /** Load failure announced instead of the list. */
  error?: string | null;
  /** Retry affordance rendered with an error. */
  onRetry?: () => void;
  /** Opt-in agent addressability shared by every list presentation. */
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
  /** Shared background-workflow state. The same binding guards submissions. */
  jobs?: ContentListJobBinding;
  /** Opt-in, authenticated preview/apply client for bulk workflows (#2453). */
  workflows?: ContentListWorkflowBinding;
  /** Opt-in, server-authoritative trash/restore/permanent-delete lifecycle. */
  lifecycle?: ContentListLifecycleBinding;
  /** Locks the status query to deleted content and exposes trash actions. */
  lifecycleMode?: 'active' | 'trash';
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
  jobs = undefined,
  workflows = undefined,
  lifecycle = undefined,
  lifecycleMode = 'active',
}: Props = $props();

const surfaceAuthority = $derived(
  resolveSurfaceAuthority(lifecycle, workflows),
);

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
  ...(untrack(() => lifecycleMode) === 'trash' ? { status: 'deleted' } : {}),
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
/**
 * The query signature the binding's rows and total currently describe.
 *
 * A total is only authoritative for the query that produced it. `remoteQuery`
 * keeps serving the PREVIOUS query's total while a new request is in flight, so
 * a saved view or a programmatic patch that changes the query AND restores a
 * page past the old query's last one would have that page clamped away before
 * its own total ever arrived.
 */
let settledSignature = $state<string | undefined>(undefined);
let settledLifecycleQuery = $state<ContentListDataQueryRequest | undefined>(
  undefined,
);
let settledLifecycleFingerprint = $state<string | undefined>(undefined);
let settledSurfaceMetadata = $state<
  | {
      signature: string;
      queryFingerprint: string | null;
      totalRows: number | null;
    }
  | undefined
>(undefined);

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
// An empty query string is a valid binding, not an absent one: the reader
// still applies the configured defaults, so a page opened at a bare path must
// restore the same way one opened with parameters does.
if (initialUrlState?.params !== undefined && initialUrlState?.params !== null) {
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
  const initialTrashMode = untrack(() => lifecycleMode) === 'trash';
  const lockedFilters = [...(reading.state.filters ?? [])].filter(
    (filter) =>
      (initialLockedType === null ||
        filter.columnId !== CONTENT_LIST_TYPE_FILTER_ID) &&
      (!initialTrashMode ||
        filter.columnId !== CONTENT_LIST_STATUS_FILTER_ID),
  );
  if (initialLockedType !== null) {
    lockedFilters.push({
      columnId: CONTENT_LIST_TYPE_FILTER_ID,
      operator: 'equals',
      value: initialLockedType,
    });
  }
  if (initialTrashMode) {
    lockedFilters.push({
      columnId: CONTENT_LIST_STATUS_FILTER_ID,
      operator: 'equals',
      value: 'deleted',
    });
  }
  const patch = {
    ...reading.state,
    ...(initialLockedType !== null || initialTrashMode
      ? { filters: lockedFilters }
      : {}),
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
let locallyRemovedLifecycleIds = $state<Set<string>>(new Set());

let snapshot = $state(controller.snapshot());
let viewMode: ContentListViewMode = $state(untrack(() => defaultViewMode));
let pendingDelete = $state<ContentListRow | null>(null);
let savedViewList = $state<ContentListSavedView[]>([]);
let selectedSavedViewId = $state('');
let savedViewName = $state('');
let offline = $state(false);
let jobSnapshot = $state<ContentListJobSnapshot>({
  jobs: [],
  pendingRowIds: new Set(),
  pendingQueryKeys: new Set(),
});
const MAX_DEFERRED_JOB_COMPLETIONS = 50;
let completedJobs = $state<ContentListJob[]>([]);
let completedJobsOverflowed = $state(false);
let activeQueryKey = $state<string | undefined>(undefined);
let lifecycleRefreshPending = $state(false);
let surfaceRoot: HTMLDivElement | undefined;
let surfaceHighlighted = $state(false);
let surfaceHandle: ContentListSurfaceHandle | undefined;

// Job state is subscribed once so hosts can use a framework-free controller.
// Only transitions observed after the initial snapshot are completion events;
// old successful history must not refresh every newly-mounted list.
$effect(() => {
  const binding = jobs;
  completedJobs = [];
  completedJobsOverflowed = false;
  if (!binding) {
    jobSnapshot = {
      jobs: [],
      pendingRowIds: new Set(),
      pendingQueryKeys: new Set(),
    };
    return;
  }
  let initialized = false;
  let statuses = new Map<string, ContentListJob['status']>();
  return binding.subscribe((next) => {
    const completions: ContentListJob[] = [];
    const nextStatuses = new Map<string, ContentListJob['status']>();
    for (const job of next.jobs) {
      const previous = statuses.get(job.jobId);
      if (
        initialized &&
        job.status === 'succeeded' &&
        previous !== 'succeeded'
      )
        completions.push(job);
      nextStatuses.set(job.jobId, job.status);
    }
    statuses = nextStatuses;
    initialized = true;
    jobSnapshot = next;
    if (completions.length > 0) {
      const combined = [...completedJobs, ...completions];
      if (combined.length > MAX_DEFERRED_JOB_COMPLETIONS)
        completedJobsOverflowed = true;
      completedJobs = combined.slice(-MAX_DEFERRED_JOB_COMPLETIONS);
    }
  });
});
let settledWorkflowQuery = $state<ContentListDataQueryRequest | null>(null);
let settledWorkflowFingerprint = $state<string | null>(null);
let settledWorkflowRevision = $state<string | null>(null);
let selectedWorkflow = $state<ContentListWorkflowId>('mark-draft');
let workflowCategory = $state('');
let workflowRestoreStatus = $state<'draft' | 'review' | 'published'>('draft');
let workflowFormat = $state<'markdown' | 'html'>('markdown');
let workflowReviewKind = $state('');
let workflowPolicyKey = $state('');
let workflowInstructions = $state('');
let workflowPending = $state(false);
let pageHeaderSelectionOnly = $state(false);
let workflowPreview = $state<import('@happyvertical/smrt-ui/data').DataSurfaceActionResult | null>(null);
let workflowResult = $state<import('@happyvertical/smrt-ui/data').DataSurfaceActionResult | null>(null);
let workflowError = $state<string | null>(null);
let workflowConfirmOpen = $state(false);
let workflowIntentAtPreview = '';
let workflowIdempotencyKey = '';
let workflowQueuedJobs = $state<
  Array<{
    intent: string;
    jobId: string;
    actionId: ContentListWorkflowId;
    requestId: string;
    identity: DataSurfaceIdentity;
    target: ContentListJobTarget;
  }>
>([]);

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
  (queryBinding
    ? contentListQueryRowsToContents(queryBinding.rows)
    : contents
  ).filter((content) => !locallyRemovedLifecycleIds.has(String(content.id))),
);

$effect(() => {
  if (!queryBinding || refreshing || isLoading) return;
  const removed = locallyRemovedLifecycleIds;
  if (removed.size === 0) return;
  const visible = new Set(queryBinding.rows.map((row) => String(row.id)));
  const retained = new Set([...removed].filter((id) => visible.has(id)));
  if (retained.size !== removed.size) locallyRemovedLifecycleIds = retained;
});
const rows = $derived(toContentListRows(sourceContents));
const visibleRowIds = $derived(
  new Set(rows.filter((row) => row.identified).map((row) => String(row.id))),
);
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

/**
 * The row count the current page may be clamped against, or `undefined` when
 * no authoritative count exists.
 *
 * Clamping MOVES the operator, so every input has to be judged on whether it is
 * exactly right — twice now a clamp has acted on a number that was not the
 * total. The complete set:
 *
 * | Input | Authoritative? |
 * |---|---|
 * | local mode row count | yes — the supplied array IS the whole result set |
 * | server total, `exact` | yes |
 * | server total, `estimated` | NO — clamping on an approximation can hide a page that really exists |
 * | server total, `unavailable` | NO — the count is unknown, and `rows.length` is the page, not the total |
 * | no response yet for this query | NO — a page restored from a link must survive until its own count arrives |
 * | a settled response for a DIFFERENT query | NO — the binding still holds the previous query's total while a new request is in flight |
 * | a page-size change | n/a — `setPageSize` resets the page itself, so it can never strand an out-of-range one |
 *
 * `pageableRowCount` deliberately keeps using the looser
 * `contentListQueryTotalValue`: an estimate is fine for SHOWING a pager, and
 * over-offering a page is visible and self-correcting where hiding one is not.
 */
const clampableRowCount = $derived(
  serverBacked
    ? contentListQueryExactTotal(queryBinding?.total)
    : queryRows.length,
);

// The adapter owns filtering, sorting, and paging, so the controller's page has
// to be clamped against the result count rather than DataTable's. In server
// mode that count is the server's total — clamping against the page length
// would collapse every list to a single page.
$effect(() => {
  const totalRows = clampableRowCount;
  // Both signatures are read as dependencies on purpose: the effect must re-run
  // when the SETTLED query changes even if the new query's count happens to
  // equal the old one's, or a stale page survives on a coincidence.
  const settled = settledSignature;
  const signature = querySignature;
  if (totalRows === undefined) return;
  if (serverBacked && settled !== signature) return;
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
// EVERY presentation renders its own page controls, compact included, and
// `totalRows` is deliberately never handed to DataTable.
//
// DataTable runs its own `clampPage(totalRows)` effect against the SAME
// controller, with no authority rule and no notion of which query a total
// belongs to. One prop cannot serve both purposes: it drives that clamp AND
// DataTable's pager, so any total authoritative enough to clamp against is also
// the only total the pager can show, and vice versa. Passing an
// authoritative-only total silences the clamp correctly but leaves compact with
// no pager on an `estimated` total while the card modes still show one — the
// two modes would then disagree about which pages exist, which is a worse bug
// than the one being fixed.
//
// So ContentList owns paging outright: one clamp (the effect above, with the
// authority rule) and one pager (below, driven by `pageableRowCount`, which
// accepts an estimate because SHOWING a page is a different question from
// MOVING the operator). The same reasoning already made the selection column
// content-owned in compact mode.
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
const stale = $derived((queryBinding?.stale ?? false) || offline);
const blockingError = $derived(
  error ?? (pageRows.length === 0 ? queryErrorMessage : null),
);
const recoverableError = $derived(
  error === null && pageRows.length > 0 ? queryErrorMessage : null,
);
const lastUpdated = $derived(queryBinding?.lastUpdated);

function refreshQuery(): void {
  if (!queryBinding?.refresh || refreshing || isLoading) return;
  const key = activeQueryKey;
  void queryBinding
    .refresh()
    .then((result) => {
      if (result !== undefined && activeQueryKey === key) {
        if (executedWorkflowQuery) {
          settleWorkflowQueryResult(
            result,
            executedWorkflowQuery,
            querySignature,
          );
        } else {
          resultNotices = readContentListQueryNotices(result);
        }
        settleLifecycleResult(result, lifecycleQueryRequest, querySignature);
      }
    })
    .catch(() => undefined);
}

function requestLifecycleRefresh(): void {
  if (!queryBinding?.refresh) return;
  if (refreshing || isLoading) {
    lifecycleRefreshPending = true;
    return;
  }
  lifecycleRefreshPending = false;
  refreshQuery();
}

$effect(() => {
  if (!lifecycleRefreshPending || refreshing || isLoading) return;
  lifecycleRefreshPending = false;
  refreshQuery();
});

function settleWorkflowQueryResult(
  result: unknown,
  request: ContentListDataQueryRequest,
  signature: string,
): void {
  settledSignature = signature;
  const envelope =
    result !== null && typeof result === 'object' && !Array.isArray(result)
      ? (result as Record<string, unknown>)
      : undefined;
  settledSurfaceMetadata = {
    signature,
    queryFingerprint:
      typeof envelope?.queryFingerprint === 'string'
        ? envelope.queryFingerprint
        : null,
    totalRows: surfaceMetadataTotalRows(envelope?.total),
  };
  resultNotices = readContentListQueryNotices(result);
  if (envelope) {
    settledWorkflowQuery = request;
    settledWorkflowFingerprint =
      typeof envelope.queryFingerprint === 'string'
        ? envelope.queryFingerprint
        : null;
    const freshness = envelope.freshness;
    settledWorkflowRevision =
      freshness !== null &&
      typeof freshness === 'object' &&
      !Array.isArray(freshness) &&
      typeof (freshness as Record<string, unknown>).asOf === 'string'
        ? String((freshness as Record<string, unknown>).asOf)
        : null;
    return;
  }
  settledWorkflowQuery = null;
  settledWorkflowFingerprint = null;
  settledWorkflowRevision = null;
}

function surfaceMetadataTotalRows(total: unknown): number | null {
  if (!total || typeof total !== 'object' || Array.isArray(total)) return null;
  const record = total as Record<string, unknown>;
  return (record.kind === 'exact' || record.kind === 'estimated') &&
    typeof record.value === 'number' &&
    Number.isSafeInteger(record.value) &&
    record.value >= 0
    ? record.value
    : null;
}

function settleLifecycleResult(
  result: unknown,
  request: ContentListDataQueryRequest | undefined,
  signature: string,
): void {
  if (
    !request ||
    result === null ||
    typeof result !== 'object' ||
    Array.isArray(result)
  ) {
    settledLifecycleQuery = undefined;
    settledLifecycleFingerprint = undefined;
    return;
  }
  const fingerprint = (result as Record<string, unknown>).queryFingerprint;
  settledLifecycleQuery = request;
  settledLifecycleFingerprint =
    typeof fingerprint === 'string' ? fingerprint : undefined;
  settledSignature = signature;
}
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
  const request = executedWorkflowQuery;
  void queryBinding
    .retry()
    .then((result) => {
      // `retry()` resolves undefined when there is no request to repeat, and a
      // newer query may have superseded this one while it was in flight.
      if (
        result === undefined ||
        request === null ||
        executedSignature !== signature ||
        signature === undefined
      )
        return;
      settleWorkflowQueryResult(result, request, signature);
      settleLifecycleResult(result, lifecycleQueryRequest, signature);
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
let executedWorkflowQuery: ContentListDataQueryRequest | null = null;
let publishedUrlSignature: string | undefined;
let lifecycleQueryRequest: ContentListDataQueryRequest | undefined;

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
      activeQueryKey = contentListQueryRequestKey(translated.request);
      executedWorkflowQuery = translated.request;
      lifecycleQueryRequest = translated.request;
      void queryBinding
        .execute(translated.request)
        .then((result) => {
          // A newer query may have superseded this one while it was in flight.
          if (executedSignature !== signature) return;
          // The binding's rows and total now describe THIS query, so the page
          // may be clamped against them and workflows may bind to the exact
          // settled request.
          settleWorkflowQueryResult(result, translated.request, signature);
          settleLifecycleResult(result, translated.request, signature);
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

// Query-scoped live updates are opt-in at the transport. Reconnect refreshes
// the exact active query before resubscribing; without a live transport, the
// same browser event falls back to an ordinary exact-query refresh.
$effect(() => {
  const queryKey = activeQueryKey;
  if (!queryBinding || queryKey === undefined || typeof window === 'undefined')
    return;
  offline = typeof navigator !== 'undefined' && navigator.onLine === false;
  let live:
    | { unsubscribe(): void; reconnect?: () => void }
    | undefined;
  try {
    live = queryBinding.subscribeLive?.();
  } catch {
    live = undefined;
  }
  const handleOffline = () => {
    offline = true;
  };
  const handleOnline = () => {
    const wasOffline = offline;
    offline = false;
    if (!wasOffline) return;
    if (live?.reconnect) live.reconnect();
    else refreshQuery();
  };
  window.addEventListener('offline', handleOffline);
  window.addEventListener('online', handleOnline);
  return () => {
    window.removeEventListener('offline', handleOffline);
    window.removeEventListener('online', handleOnline);
    live?.unsubscribe();
  };
});

// A successful workflow refreshes only the page/query it can affect. Failures
// stay visible and never produce the refresh that a success would.
$effect(() => {
  const completions = completedJobs;
  const overflowed = completedJobsOverflowed;
  if (completions.length === 0 && !overflowed) return;
  if (!queryBinding?.refresh) {
    // Local lists and structurally valid read-only bindings cannot consume a
    // completion. Discard it rather than retaining unbounded job history.
    completedJobs = [];
    completedJobsOverflowed = false;
    return;
  }
  // A success can arrive while an older query is still in flight. Keep the
  // completion queued until that request settles so its pre-job answer cannot
  // become the indefinitely visible final state.
  if (refreshing || isLoading) return;
  completedJobs = [];
  completedJobsOverflowed = false;
  if (
    overflowed ||
    completions.some((job) =>
      contentListJobAffectsQuery(job, activeQueryKey, visibleRowIds),
    )
  )
    refreshQuery();
});

const selectedRowKeys = $derived(
  new Set(tableState.selectedRowIds.map((rowId) => String(rowId))),
);
// Only durable rows may be addressed by a selection.
const identifiedRowKeys = $derived(
  new Set(selectableContentListRowIds(rows).map((rowId) => String(rowId))),
);
const selectablePageRowIds = $derived(
  selectableContentListRowIds(pageRows.filter((row) => !rowPending(row))),
);
const allMatchingSelected = $derived(tableState.selection.scope === 'allMatching');
const allPageSelected = $derived(
  allMatchingSelected ||
    (selectablePageRowIds.length > 0 &&
      selectablePageRowIds.every((rowId) => selectedRowKeys.has(String(rowId)))),
);
const somePageSelected = $derived(
  !allPageSelected &&
    selectablePageRowIds.some((rowId) => selectedRowKeys.has(String(rowId))),
);
const selectedCount = $derived(
  tableState.selection.scope === 'allMatching'
    ? tableState.selection.expectedCount
    : tableState.selectedRowIds.length,
);
const exactMatchingCount = $derived(
  settledSignature === querySignature
    ? contentListQueryExactTotal(queryBinding?.total)
    : undefined,
);
const canSelectAllMatching = $derived(
  Boolean(
    workflows &&
      serverBacked &&
      settledWorkflowQuery &&
      settledWorkflowFingerprint &&
      settledWorkflowRevision &&
      exactMatchingCount !== undefined &&
      exactMatchingCount > 0 &&
      exactMatchingCount <= (surfaceAuthority.maxSelectionSize ?? 200),
  ),
);
const workflowPayloadValid = $derived(
  selectedWorkflow !== 'categorize' || workflowCategory.trim().length > 0,
);
const workflowDuplicateQueued = $derived(
  workflowQueuedJobs.some((job) => job.intent === workflowIntentSignature()),
);
const workflowQueuedJob = $derived(
  workflowQueuedJobs.find((job) => job.intent === workflowIntentSignature()) ??
    workflowQueuedJobs[0],
);
const lifecycleViewKey = $derived(
  JSON.stringify([
    lifecycleMode,
    querySignature,
    [...tableState.selectedRowIds].map(String).sort(),
  ]),
);
const lifecycleQuery = $derived(
  serverBacked && settledSignature === querySignature
    ? settledLifecycleQuery
    : undefined,
);
const lifecycleExactMatchingCount = $derived(
  serverBacked && settledSignature === querySignature
    ? contentListQueryExactTotal(queryBinding?.total)
    : queryRows.length,
);

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

// Trash is a view, not an editable select value. Keep its status predicate
// locked against URL restores and agent-driven filter commands.
$effect(() => {
  if (lifecycleMode !== 'trash') return;
  if (
    isContentListFilterExactly(
      tableState,
      CONTENT_LIST_STATUS_FILTER_ID,
      'deleted',
    )
  )
    return;
  untrack(() =>
    applyContentListFilter(controller, CONTENT_LIST_STATUS_FILTER_ID, 'deleted'),
  );
});

/**
 * What each toolbar select may display, and whether it can display the live
 * predicate at all.
 *
 * INVARIANT: the select's displayed state either matches the live predicate
 * exactly, or the operator is told it does not. Three states, and all three are
 * reachable from a shared link:
 *
 * - representable and inside the vocabulary — the select shows it, silently;
 * - representable but outside the vocabulary (`?status=embargoed`, or a typo)
 *   — the value is rendered as an extra option AND reported, so an empty list
 *   always has an explanation;
 * - not representable at all (`?status.in=draft,review`, `?status.isNull=1`,
 *   `?status.notEquals=draft`) — the select shows a disabled summary of the
 *   real predicate instead of a value it is not applying, and reports it.
 *   Choosing any real option replaces every filter on that column, so the
 *   operator is never stuck.
 */
const typeFilterState = $derived(
  readContentListSelectFilter(tableState, CONTENT_LIST_TYPE_FILTER_ID),
);
const statusFilterState = $derived(
  readContentListSelectFilter(tableState, CONTENT_LIST_STATUS_FILTER_ID),
);
const selectedType = $derived(
  typeFilterState.representable
    ? typeFilterState.value
    : CONTENT_LIST_UNREPRESENTABLE_OPTION,
);
const selectedStatus = $derived(
  statusFilterState.representable
    ? statusFilterState.value
    : CONTENT_LIST_UNREPRESENTABLE_OPTION,
);

/** A live, representable value the select has no option for. */
const unlistedType = $derived(
  typeFilterState.representable &&
    typeFilterState.value &&
    !(CONTENT_LIST_TYPE_OPTIONS as readonly string[]).includes(
      typeFilterState.value,
    )
    ? typeFilterState.value
    : null,
);
const unlistedStatus = $derived(
  statusFilterState.representable &&
    statusFilterState.value &&
    !(CONTENT_LIST_STATUS_OPTIONS as readonly string[]).includes(
      statusFilterState.value,
    )
    ? statusFilterState.value
    : null,
);

function columnFilterDrops(
  columnId: string,
  unlisted: string | null,
  filterState: ContentListSelectFilterState,
): ContentListQueryDrop[] {
  if (unlisted !== null) {
    return [
      {
        scope: 'filter',
        reason: 'unlisted-value',
        columnId,
        detail: unlisted,
      },
    ];
  }
  if (!filterState.representable) {
    return [
      {
        scope: 'filter',
        reason: 'unrepresentable-filter',
        columnId,
        detail: filterState.detail ?? '',
      },
    ];
  }
  return [];
}

const unlistedValueDrops = $derived<ContentListQueryDrop[]>([
  // A locked list renders no type select, so there is nothing to disagree with.
  ...(lockedType !== null
    ? []
    : columnFilterDrops(
        CONTENT_LIST_TYPE_FILTER_ID,
        unlistedType,
        typeFilterState,
      )),
  ...columnFilterDrops(
    CONTENT_LIST_STATUS_FILTER_ID,
    unlistedStatus,
    statusFilterState,
  ),
]);

const surfaceOptions = $derived(
  dataSurface
    ? {
        registry: dataSurface.registry,
        descriptor:
          dataSurface.descriptor
            ? reconcileSurfaceDescriptor(
                dataSurface.descriptor,
                surfaceAuthority,
              )
            :
          (() => {
            const descriptor = buildContentListSurfaceDescriptor({
              columnLabels,
              serverBacked: initialQuery !== undefined,
              lifecycle: lifecycle !== undefined,
              lifecycleMode,
              includeWorkflows: workflows !== undefined,
              refresh: queryBinding?.refresh !== undefined,
              retry: retryHandler !== undefined,
            });
            return {
              ...descriptor,
              identity: surfaceAuthority.identity ?? descriptor.identity,
              limits: {
                ...descriptor.limits,
                ...(surfaceAuthority.maxSelectionSize === undefined
                  ? {}
                  : { maxSelectionSize: surfaceAuthority.maxSelectionSize }),
              },
            };
          })(),
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
const boundResultNotices = $derived(
  queryBinding?.result === undefined
    ? undefined
    : readContentListQueryNotices(queryBinding.result),
);
const queryTruncated = $derived(
  queryBinding?.truncated ??
    boundResultNotices?.truncated ??
    resultNotices.truncated,
);
const queryWarnings = $derived<ReadonlyArray<string>>(
  queryBinding?.warnings ??
    boundResultNotices?.warnings ??
    resultNotices.warnings,
);

function surfaceLastUpdated(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  return null;
}

const matchingSurfaceMetadata = $derived(
  serverBacked && settledSurfaceMetadata?.signature === querySignature
    ? settledSurfaceMetadata
    : undefined,
);

const surfaceContext = $derived<ContentListSurfaceContext>({
  viewMode,
  queryFingerprint: serverBacked
    ? (matchingSurfaceMetadata?.queryFingerprint ?? null)
    : null,
  totalRows: serverBacked
    ? (matchingSurfaceMetadata?.totalRows ?? null)
    : Number.isSafeInteger(totalRowCount)
      ? totalRowCount
      : null,
  freshness: {
    stale,
    refreshing,
    offline,
    lastUpdated: surfaceLastUpdated(lastUpdated),
    truncated: queryTruncated,
    warnings: queryWarnings,
  },
});

function focusSurface(): void {
  if (!surfaceRoot) return;
  surfaceRoot.tabIndex = -1;
  surfaceRoot.focus();
}

// ContentList owns the registration so grid, detailed, compact, empty, and
// loading presentations all expose one stable identity and revision stream.
// This ref is deliberately non-reactive: registration input changes must
// advance a stable identity revision, but normal command acknowledgements must
// not themselves cause a registration teardown/replay window.
const surfaceRevision = { value: undefined as number | undefined };

$effect(() => {
  const surface = surfaceOptions;
  if (!surface) {
    surfaceHandle = undefined;
    return;
  }
  const handle = registerContentListDataSurface({
    ...surface,
    controller,
    context: untrack(() => surfaceContext),
    initialRevision:
      surfaceRevision.value === undefined ? 0 : surfaceRevision.value + 1,
    onRevision: (revision) => {
      surfaceRevision.value = revision;
    },
    setViewMode: (next) => {
      viewMode = next;
    },
    ...(queryBinding?.refresh
      ? {
          refresh: async () => {
            await refreshQuery();
            return true;
          },
        }
      : {}),
    ...(retryHandler
      ? {
          retry: async () => {
            await retryHandler();
            return true;
          },
        }
      : {}),
    focus: focusSurface,
    reveal: () => surfaceRoot?.scrollIntoView({ block: 'nearest' }),
    highlight: () => {
      surfaceHighlighted = true;
      setTimeout(() => {
        surfaceHighlighted = false;
      }, 1_000);
    },
  });
  surfaceHandle = handle;
  return () => {
    if (surfaceHandle === handle) surfaceHandle = undefined;
    handle.destroy();
  };
});

$effect(() => {
  surfaceHandle?.update(surfaceContext);
});
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
  'filter-widened': M['content.content_list.drop_filter_widened'],
  'unlisted-value': M['content.content_list.drop_unlisted_value'],
  'unrepresentable-filter':
    M['content.content_list.drop_unrepresentable_filter'],
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
  if (drop.reason === 'unrepresentable-filter') {
    return t(M['content.content_list.drop_unrepresentable_filter'], {
      target: drop.columnId ?? drop.scope,
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
  return allMatchingSelected || selectedRowKeys.has(String(row.id));
}

function rowPending(row: ContentListRow): boolean {
  return (
    jobSnapshot.pendingRowIds.has(String(row.id)) ||
    (activeQueryKey !== undefined &&
      jobSnapshot.pendingQueryKeys.has(activeQueryKey)) ||
    workflowQueuedJobs.some((job) =>
      job.target.kind === 'query'
        ? activeQueryKey !== undefined && job.target.queryKey === activeQueryKey
        : job.target.rowIds.includes(String(row.id)),
    )
  );
}

function retryJob(jobId: string): void {
  void jobs?.retry(jobId).catch(() => undefined);
}

function jobStatusLabel(job: ContentListJob): string {
  if (job.status === 'queued') return t(M['content.content_list.job_queued']);
  if (job.status === 'running') return t(M['content.content_list.job_running']);
  if (job.status === 'succeeded')
    return t(M['content.content_list.job_succeeded']);
  return t(M['content.content_list.job_failed']);
}

function formattedLastUpdated(value: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function toggleRow(row: ContentListRow) {
  if (
    workflowPending ||
    !row.identified ||
    rowPending(row) ||
    allMatchingSelected
  )
    return;
  pageHeaderSelectionOnly = false;
  controller.dispatch({ type: 'toggleRowSelection', rowId: row.id });
}

function togglePageSelection() {
  if (workflowPending) return;
  if (allMatchingSelected) {
    clearSelection();
    return;
  }
  const rowKey = (rowId: string | number) =>
    `${typeof rowId}:${String(rowId)}`;
  const pageKeys = new Set(selectablePageRowIds.map(rowKey));
  if (allPageSelected) {
    pageHeaderSelectionOnly = false;
    controller.dispatch({
      type: 'setSelectedRows',
      rowIds: tableState.selectedRowIds.filter(
        (rowId) => !pageKeys.has(rowKey(rowId)),
      ),
    });
    return;
  }
  const selected = new Map(
    tableState.selectedRowIds.map((rowId) => [rowKey(rowId), rowId]),
  );
  pageHeaderSelectionOnly =
    serverBacked && tableState.selectedRowIds.length === 0;
  for (const rowId of selectablePageRowIds) selected.set(rowKey(rowId), rowId);
  controller.dispatch({
    type: 'setSelectedRows',
    rowIds: [...selected.values()],
  });
}

function selectAllMatching() {
  if (
    workflowPending ||
    !canSelectAllMatching ||
    !settledWorkflowFingerprint ||
    !settledWorkflowRevision ||
    exactMatchingCount === undefined
  ) return;
  pageHeaderSelectionOnly = false;
  controller.dispatch({
    type: 'selectAllMatching',
    queryFingerprint: settledWorkflowFingerprint,
    queryRevision: settledWorkflowRevision,
    expectedCount: exactMatchingCount,
  });
}

function clearSelection() {
  if (workflowPending) return;
  pageHeaderSelectionOnly = false;
  controller.dispatch({ type: 'setSelectedRows', rowIds: [] });
}

function workflowPayload(): Record<string, string> | undefined {
  switch (selectedWorkflow) {
    case 'categorize':
      return { category: workflowCategory.trim() };
    case 'restore':
      return { status: workflowRestoreStatus };
    case 'format-body':
      return { format: workflowFormat };
    case 'automated-review': {
      const payload: Record<string, string> = {};
      if (workflowReviewKind.trim()) payload.kind = workflowReviewKind.trim();
      if (workflowPolicyKey.trim()) payload.policyKey = workflowPolicyKey.trim();
      return payload;
    }
    case 'optimize':
      return workflowInstructions.trim()
        ? { instructions: workflowInstructions.trim() }
        : {};
    default:
      return {};
  }
}

function workflowSelection(): ContentListWorkflowRequest['selection'] | null {
  const selection = tableState.selection;
  if (selection.scope === 'allMatching') {
    return { scope: 'all-matching', queryFingerprint: selection.queryFingerprint };
  }
  const currentPageKeys = new Set(pageRows.map((row) => String(row.id)));
  const selectablePageKeys = new Set(selectablePageRowIds.map(String));
  const effectiveRowIds =
    selection.scope === 'page' || pageHeaderSelectionOnly
      ? selection.rowIds.filter((rowId) => {
          const key = String(rowId);
          return !currentPageKeys.has(key) || selectablePageKeys.has(key);
        })
      : selection.rowIds;
  if (
    serverBacked &&
    pageHeaderSelectionOnly &&
    selectablePageRowIds.length === pageRows.length &&
    effectiveRowIds.length === selectablePageRowIds.length &&
    selectablePageRowIds.every((rowId) =>
      effectiveRowIds.some(
        (selectedId) => String(selectedId) === String(rowId),
      ),
    )
  ) {
    return { scope: 'current-page' };
  }
  if (effectiveRowIds.length === 0) return null;
  return { scope: 'explicit-ids', rowIds: effectiveRowIds };
}

function workflowSelectionCount(
  selection: ContentListWorkflowRequest['selection'],
): number {
  if (selection.scope === 'explicit-ids') return selection.rowIds.length;
  if (selection.scope === 'current-page') return selectablePageRowIds.length;
  return tableState.selection.scope === 'allMatching'
    ? tableState.selection.expectedCount
    : 0;
}

function workflowJobTarget(
  request: ContentListWorkflowRequest,
): ContentListJobTarget {
  if (request.selection.scope === 'all-matching' && activeQueryKey !== undefined)
    return { kind: 'query', queryKey: activeQueryKey };
  if (request.selection.scope === 'explicit-ids')
    return { kind: 'rows', rowIds: request.selection.rowIds.map(String) };
  return { kind: 'rows', rowIds: selectablePageRowIds.map(String) };
}

function workflowIntentSignature(): string {
  const selection = workflowSelection();
  if (selection?.scope === 'explicit-ids') {
    return JSON.stringify([
      selectedWorkflow,
      workflowPayload(),
      {
        scope: selection.scope,
        rowIds: [...selection.rowIds].sort((left, right) => {
          const leftKey = `${typeof left}:${String(left)}`;
          const rightKey = `${typeof right}:${String(right)}`;
          return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
        }),
      },
    ]);
  }
  return JSON.stringify([
    selectedWorkflow,
    workflowPayload(),
    tableState.selection,
    settledWorkflowFingerprint,
    querySignature,
  ]);
}

function createWorkflowRequest(
  phase: 'preview' | 'apply',
): ContentListWorkflowRequest | null {
  const selection = workflowSelection();
  if (!selection) return null;
  const selectionCount = workflowSelectionCount(selection);
  if (selectionCount > (surfaceAuthority.maxSelectionSize ?? 200)) return null;
  const queryRequired = selection.scope !== 'explicit-ids';
  if (
    queryRequired &&
    (!settledWorkflowQuery || settledSignature !== querySignature)
  ) return null;
  if (
    selection.scope === 'all-matching' &&
    selection.queryFingerprint !== settledWorkflowFingerprint
  ) return null;
  return {
    version: 1,
    requestId: globalThis.crypto?.randomUUID?.() ?? `content-workflow-${Date.now()}`,
    identity:
      surfaceAuthority.identity ?? DEFAULT_CONTENT_LIST_SURFACE_IDENTITY,
    actionId: selectedWorkflow,
    phase,
    selection,
    payload: workflowPayload(),
    expectedRevision: workflows?.revision ?? 0,
    target: {
      ...(queryRequired && settledWorkflowQuery
        ? { query: settledWorkflowQuery }
        : {}),
      expectedCount: selectionCount,
    },
  };
}

function workflowIdentityMatches(
  actual: DataSurfaceIdentity | null | undefined,
  expected: DataSurfaceIdentity,
): boolean {
  return (
    actual !== null &&
    actual !== undefined &&
    actual.surfaceId === expected.surfaceId &&
    actual.kind === expected.kind &&
    (expected.subject
      ? actual.subject?.type === expected.subject.type &&
        actual.subject.id === expected.subject.id
      : actual.subject === undefined)
  );
}

function workflowResultMatchesRequest(
  result: DataSurfaceActionResult,
  request: ContentListWorkflowRequest,
): boolean {
  return (
    result.version === 1 &&
    result.requestId === request.requestId &&
    result.phase === request.phase &&
    result.actionId === request.actionId &&
    workflowIdentityMatches(result.identity, request.identity)
  );
}

function workflowResultMessage(result: import('@happyvertical/smrt-ui/data').DataSurfaceActionResult): string {
  const details = result.details ?? {};
  const accepted = typeof details.accepted === 'number' ? details.accepted : 0;
  if (details.background === true) {
    return t(M['content.content_list.workflow_result_background'], {
      accepted,
    });
  }
  const skipped = typeof details.skipped === 'number' ? details.skipped : 0;
  const failed = typeof details.failed === 'number' ? details.failed : 0;
  return t(M['content.content_list.workflow_result_summary'], {
    accepted,
    skipped,
    failed,
  });
}

function applyWorkflowSelectionOutcomes(
  result: import('@happyvertical/smrt-ui/data').DataSurfaceActionResult,
): boolean {
  const outcomes = contentListWorkflowOutcomes(result);
  const rowKey = (rowId: string | number) =>
    `${typeof rowId}:${String(rowId)}`;
  if (tableState.selection.scope === 'allMatching') {
    const uniqueOutcomes = new Set(outcomes.map((outcome) => rowKey(outcome.rowId)));
    if (
      outcomes.length !== tableState.selection.expectedCount ||
      uniqueOutcomes.size !== outcomes.length
    ) {
      workflowError = t(
        M['content.content_list.workflow_incomplete_outcomes'],
      );
      return false;
    }
    controller.dispatch({
      type: 'setSelectedRows',
      rowIds: outcomes
        .filter((outcome) => outcome.status !== 'accepted')
        .map((outcome) => outcome.rowId),
    });
    return true;
  }
  const accepted = new Set(
    outcomes
      .filter((outcome) => outcome.status === 'accepted')
      .map((outcome) => rowKey(outcome.rowId)),
  );
  controller.dispatch({
    type: 'setSelectedRows',
    rowIds: tableState.selectedRowIds.filter(
      (rowId) => !accepted.has(rowKey(rowId)),
    ),
  });
  return true;
}

function workflowPreviewMessage(): string {
  const details = workflowPreview?.details ?? {};
  const count = typeof details.count === 'number' ? details.count : selectedCount;
  const labels = Array.isArray(details.representativeLabels)
    ? details.representativeLabels.filter((entry): entry is string => typeof entry === 'string')
    : [];
  const consequences = Array.isArray(details.consequences)
    ? details.consequences.filter((entry): entry is string => typeof entry === 'string')
    : [];
  const skipped = typeof details.skipped === 'number' ? details.skipped : 0;
  const resolvedScope =
    typeof details.resolvedScope === 'string'
      ? details.resolvedScope
      : workflowSelection()?.scope;
  const ineligible = Array.isArray(details.ineligible)
    ? details.ineligible.flatMap((entry) => {
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry))
          return [];
        const outcome = entry as Record<string, unknown>;
        if (
          typeof outcome.rowId !== 'string' &&
          typeof outcome.rowId !== 'number'
        )
          return [];
        const reason =
          typeof outcome.reason === 'string'
            ? ` (${workflowReasonLabel(
                outcome.reason,
                M['content.content_list.workflow_reason_unknown'],
              )})`
            : '';
        return [`${String(outcome.rowId)}${reason}`];
      })
    : [];
  return [
    resolvedScope
      ? t(M['content.content_list.workflow_preview_scope'], {
          scope: workflowScopeLabel(resolvedScope),
        })
      : '',
    t(
      count === 1
        ? M['content.content_list.workflow_preview_count_one']
        : M['content.content_list.workflow_preview_count_many'],
      { count },
    ),
    labels.length
      ? t(M['content.content_list.workflow_preview_examples'], {
          labels: labels.join(', '),
        })
      : '',
    skipped
      ? t(M['content.content_list.workflow_preview_ineligible_count'], {
          count: skipped,
        })
      : '',
    ineligible.length
      ? t(M['content.content_list.workflow_preview_ineligible'], {
          items: ineligible.join(', '),
        })
      : '',
    ...consequences.map(workflowConsequenceLabel),
  ].filter(Boolean).join(' ');
}

async function previewWorkflow() {
  if (!workflows || workflowPending || workflowDuplicateQueued) return;
  const request = createWorkflowRequest('preview');
  if (!request) return;
  workflowPending = true;
  workflowError = null;
  workflowResult = null;
  workflowIdempotencyKey = '';
  try {
    const result = await workflows.client.preview(request);
    if (!workflowResultMatchesRequest(result, request)) {
      workflowError = t(M['content.content_list.workflow_preview_mismatch']);
      return;
    }
    if (!result.ok) {
      workflowError = workflowReasonLabel(
        result.reason,
        M['content.content_list.workflow_preview_failed'],
      );
      return;
    }
    workflowPreview = result;
    workflowIntentAtPreview = workflowIntentSignature();
    workflowIdempotencyKey =
      globalThis.crypto?.randomUUID?.() ?? `content-workflow-apply-${Date.now()}`;
    workflowConfirmOpen = true;
  } catch (error) {
    workflowError = workflowExceptionMessage(
      error,
      M['content.content_list.workflow_preview_failed'],
    );
  } finally {
    workflowPending = false;
  }
}

async function applyWorkflow() {
  if (!workflows || workflowPending || !workflowPreview?.confirmationToken) return;
  if (workflowIntentAtPreview !== workflowIntentSignature()) {
    workflowConfirmOpen = false;
    workflowPreview = null;
    workflowIdempotencyKey = '';
    workflowError = t(M['content.content_list.workflow_selection_changed']);
    return;
  }
  const request = createWorkflowRequest('apply');
  if (!request) return;
  request.confirmationToken = workflowPreview.confirmationToken;
  request.idempotencyKey = workflowIdempotencyKey;
  const appliedIntent = workflowIntentAtPreview;
  const appliedTarget = workflowJobTarget(request);
  workflowPending = true;
  workflowError = null;
  try {
    const result = await workflows.client.apply(request);
    if (!workflowResultMatchesRequest(result, request)) {
      workflowError = t(M['content.content_list.workflow_apply_mismatch']);
      return;
    }
    if (appliedIntent !== workflowIntentSignature()) {
      if (
        result.ok &&
        result.details?.background === true &&
        typeof result.details.jobId === 'string' &&
        !workflowQueuedJobs.some((job) => job.intent === appliedIntent)
      ) {
        workflowQueuedJobs = [
          ...workflowQueuedJobs,
          {
            intent: appliedIntent,
            jobId: result.details.jobId,
            actionId: request.actionId,
            requestId:
              typeof result.details.jobRequestId === 'string'
                ? result.details.jobRequestId
                : request.requestId,
            identity: request.identity,
            target: appliedTarget,
          },
        ];
      }
      workflowError = t(M['content.content_list.workflow_changed_applying']);
      workflowPreview = null;
      workflowIdempotencyKey = '';
      workflowConfirmOpen = false;
      return;
    }
    workflowResult = result;
    if (!result.ok) {
      workflowError = workflowReasonLabel(
        result.reason,
        M['content.content_list.workflow_failed'],
      );
      workflowPreview = null;
      workflowIdempotencyKey = '';
      workflowConfirmOpen = false;
      return;
    }
    if (result.details?.background !== true) {
      applyWorkflowSelectionOutcomes(result);
      refreshQuery();
    } else if (
      typeof result.details.jobId === 'string' &&
      !workflowQueuedJobs.some((job) => job.intent === workflowIntentAtPreview)
    ) {
      workflowQueuedJobs = [
        ...workflowQueuedJobs,
        {
          intent: workflowIntentAtPreview,
          jobId: result.details.jobId,
          actionId: request.actionId,
          requestId:
            typeof result.details.jobRequestId === 'string'
              ? result.details.jobRequestId
              : request.requestId,
          identity: request.identity,
          target: appliedTarget,
        },
      ];
    }
    workflowPreview = null;
    workflowIdempotencyKey = '';
    workflowConfirmOpen = false;
  } catch (error) {
    workflowError = workflowExceptionMessage(
      error,
      M['content.content_list.workflow_failed'],
    );
  } finally {
    workflowPending = false;
  }
}

async function checkWorkflowJob() {
  if (!workflows?.client.status || !workflowQueuedJob || workflowPending) return;
  const queuedJob = workflowQueuedJob;
  workflowPending = true;
  workflowError = null;
  try {
    const job = await workflows.client.status(queuedJob.jobId);
    const matchesCurrentIntent =
      queuedJob.intent === workflowIntentSignature();
    if (job.status === 'queued' || job.status === 'running') {
      workflowError = t(M['content.content_list.workflow_job_still'], {
        id: job.jobId,
        status: workflowJobStatusLabel(job.status),
      });
      return;
    }
    if (job.status === 'succeeded' && !job.result) {
      workflowError = t(M['content.content_list.workflow_job_missing_result'], {
        id: job.jobId,
      });
      return;
    }
    if (
      job.result &&
      (job.result.version !== 1 ||
        job.result.phase !== 'apply' ||
        job.result.actionId !== queuedJob.actionId ||
        job.result.requestId !== queuedJob.requestId ||
        !workflowIdentityMatches(job.result.identity, queuedJob.identity))
    ) {
      workflowError = t(M['content.content_list.workflow_job_wrong_workflow'], {
        id: job.jobId,
      });
      return;
    }
    workflowQueuedJobs = workflowQueuedJobs.filter(
      (queued) => queued.jobId !== job.jobId,
    );
    if (!matchesCurrentIntent) {
      if (job.status === 'succeeded' && job.result?.ok) refreshQuery();
      workflowError = t(
        M['content.content_list.workflow_changed_checking_job'],
      );
      return;
    }
    if (job.status === 'succeeded' && job.result) {
      if (matchesCurrentIntent) workflowResult = job.result;
      if (!job.result.ok) {
        workflowError = workflowReasonLabel(
          job.result.reason,
          M['content.content_list.workflow_job_failed'],
          { id: job.jobId },
        );
      } else if (matchesCurrentIntent) {
        applyWorkflowSelectionOutcomes(job.result);
      }
      if (job.result.ok) refreshQuery();
    }
    if (job.status !== 'succeeded') {
      workflowError = workflowReasonLabel(
        job.reason,
        M['content.content_list.workflow_job_status'],
        { id: job.jobId, status: workflowJobStatusLabel(job.status) },
      );
    }
  } catch (error) {
    workflowError = workflowExceptionMessage(
      error,
      M['content.content_list.workflow_job_failed'],
    );
  } finally {
    workflowPending = false;
  }
}

function cancelWorkflowConfirmation() {
  if (workflowPending) return;
  workflowConfirmOpen = false;
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
  return contentListRowActions(row, {
    getViewHref,
    canEdit: lifecycleMode !== 'trash',
    canDelete: lifecycleMode !== 'trash' && lifecycle === undefined,
  });
}

function handleLifecycleComplete(
  result: import('@happyvertical/smrt-ui/data').DataSurfaceActionResult,
) {
  const removed = new Set(locallyRemovedLifecycleIds);
  for (const outcome of readContentListLifecycleSummary(result).outcomes) {
    if (outcome.status === 'accepted') removed.add(String(outcome.rowId));
  }
  locallyRemovedLifecycleIds = removed;
  controller.dispatch({
    type: 'setSelectedRows',
    rowIds: reconcileContentListLifecycleSelection(
      tableState.selectedRowIds,
      result,
    ),
  });
  requestLifecycleRefresh();
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
  if (rowPending(row)) return;
  pendingDelete = row;
}

function confirmDelete() {
  const target = pendingDelete;
  pendingDelete = null;
  if (target && !rowPending(target)) {
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
  <p class="table-empty-state">
    {lifecycleMode === 'trash'
      ? t(M['content.content_list.trash_empty'])
      : t(M['content.content_list.empty'])}
  </p>
{/snippet}

{#snippet selectHeader()}
  <Checkbox
    checked={allPageSelected}
    indeterminate={somePageSelected}
    disabled={workflowPending}
    aria-label={t(M['content.content_list.select_all'])}
    onchange={togglePageSelection}
  />
{/snippet}

{#snippet selectCell({ row }: { row: ContentListRow })}
  <Checkbox
    checked={isSelected(row)}
    disabled={workflowPending || !row.identified || rowPending(row) || allMatchingSelected}
    aria-label={selectRowLabel(row)}
    title={row.identified
      ? rowPending(row)
        ? t(M['content.content_list.row_pending'])
        : undefined
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
        disabled={rowPending(row)}
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
        disabled={rowPending(row)}
        onclick={() => handleDeleteContent(row)}
        title={t(M['content.content_list.delete'])}
        aria-label={t(M['content.content_list.delete'])}
      >
        <span aria-hidden="true">🗑️</span>
      </Button>
    {/if}
  </div>
{/snippet}

<div
  class="content-list-wrapper"
  class:data-surface-highlighted={surfaceHighlighted}
  bind:this={surfaceRoot}
>

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
          {:else if !typeFilterState.representable}
            <!-- A live predicate no single option can express. Show the
                 predicate rather than a value the query is not applying. -->
            <option value={CONTENT_LIST_UNREPRESENTABLE_OPTION} disabled>
              {typeFilterState.detail}
            </option>
          {/if}
        </Select>
      {/if}

      {#if lifecycleMode !== 'trash'}
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
        {:else if !statusFilterState.representable}
          <option value={CONTENT_LIST_UNREPRESENTABLE_OPTION} disabled>
            {statusFilterState.detail}
          </option>
        {/if}
      </Select>
      {/if}

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

        {#if workflowQueuedJobs.length > 0 && workflows?.client.status}
          <Button
            variant="ghost"
            size="sm"
            type="button"
            disabled={workflowPending}
            onclick={() => void checkWorkflowJob()}
          >
            {t(M['content.content_list.check_job'])}
          </Button>
        {/if}
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

  {#if serverBacked}
    <div class="content-freshness" aria-live="polite" aria-atomic="true">
      <span>
        {#if offline}
          {t(M['content.content_list.offline'])}
        {:else if stale}
          {t(M['content.content_list.stale'])}
        {:else if lastUpdated !== undefined}
          {t(M['content.content_list.last_updated'], {
            time: formattedLastUpdated(lastUpdated),
          })}
        {/if}
      </span>
      {#if queryBinding?.refresh}
        <Button
          variant="ghost"
          size="sm"
          type="button"
          class="refresh-button"
          disabled={refreshing || isLoading || offline}
          onclick={refreshQuery}
        >
          {t(M['content.content_list.refresh'])}
        </Button>
      {/if}
    </div>
  {/if}

  {#if jobSnapshot.jobs.length > 0}
    <section class="content-jobs" aria-label={t(M['content.content_list.jobs'])}>
      <ul class="content-jobs__list" aria-live="polite" aria-atomic="false">
        {#each jobSnapshot.jobs as job (job.jobId)}
          <li class={`content-job content-job--${job.status}`} data-job-id={job.jobId}>
            <span class="content-job__identity">
              {t(M['content.content_list.job_identity'], { id: job.jobId })}
            </span>
            <span>{jobStatusLabel(job)}</span>
            {#if job.total !== undefined && job.total > 0}
              <progress
                value={Math.min(job.completed ?? 0, job.total)}
                max={job.total}
                aria-label={t(M['content.content_list.job_progress'], {
                  completed: job.completed ?? 0,
                  total: job.total,
                })}
              ></progress>
            {/if}
            {#if job.message}<span>{job.message}</span>{/if}
            {#if job.status === 'failed'}
              {#if job.error}<span role="alert">{job.error}</span>{/if}
              {#if jobs?.canRetry?.(job.jobId) === true}
                <Button
                  variant="ghost"
                  size="sm"
                  type="button"
                  onclick={() => retryJob(job.jobId)}
                >
                  {t(M['content.content_list.retry_job'])}
                </Button>
              {/if}
            {/if}
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  {#if blockingError}
    <div class="state-panel state-panel--error" role="alert">
      <p class="state-panel__title">{t(M['content.content_list.error_title'])}</p>
      <p class="state-panel__detail">{blockingError}</p>
      {#if retryHandler}
        <Button variant="ghost" type="button" class="retry-button" onclick={() => retryHandler?.()}>
          {t(M['content.content_list.retry'])}
        </Button>
      {/if}
    </div>
  {:else}
    {#if recoverableError}
      <div class="state-panel state-panel--error state-panel--inline" role="alert">
        <p class="state-panel__title">{t(M['content.content_list.refresh_error_title'])}</p>
        <p class="state-panel__detail">{recoverableError}</p>
        {#if retryHandler}
          <Button variant="ghost" type="button" class="retry-button" onclick={() => retryHandler?.()}>
            {t(M['content.content_list.retry'])}
          </Button>
        {/if}
      </div>
    {/if}
    {#if pageRows.length > 0 || selectedCount > 0}
      <div class="content-selection">
        {#if viewMode !== 'compact'}
          <Checkbox
            checked={allPageSelected}
            indeterminate={somePageSelected}
            disabled={workflowPending}
            aria-label={t(M['content.content_list.select_all'])}
            onchange={togglePageSelection}
          />
        {/if}
        <span class="content-selection__count" aria-live="polite">
          {t(M['content.content_list.selection_count'], { count: selectedCount })}
        </span>
        {#if selectedCount > 0}
          <Button variant="ghost" size="sm" type="button" class="clear-selection" disabled={workflowPending} onclick={clearSelection}>
            {t(M['content.content_list.clear_selection'])}
          </Button>
        {/if}
        {#if canSelectAllMatching && !allMatchingSelected && exactMatchingCount !== undefined && exactMatchingCount > selectedCount}
          <Button
            variant="ghost"
            size="sm"
            type="button"
            class="select-all-matching"
            disabled={workflowPending}
            onclick={selectAllMatching}
          >
            {t(M['content.content_list.select_all_matching'], {
              count: exactMatchingCount,
            })}
          </Button>
        {/if}
      </div>
    {/if}

    {#if lifecycle}
      <ContentListLifecyclePanel
        binding={surfaceAuthority.lifecycle ?? lifecycle}
        mode={lifecycleMode}
        selectedRowIds={tableState.selectedRowIds}
        query={lifecycleQuery}
        queryFingerprint={settledLifecycleFingerprint}
        exactMatchingCount={lifecycleExactMatchingCount}
        viewKey={lifecycleViewKey}
        oncomplete={handleLifecycleComplete}
      />
    {/if}

    {#if workflows && (selectedCount > 0 || workflowError || workflowResult)}
      <section class="content-workflows" aria-label={t(M['content.content_list.bulk_workflows'])}>
        <Select
          aria-label={t(M['content.content_list.bulk_workflow'])}
          value={selectedWorkflow}
          disabled={workflowPending}
          onchange={(event: Event) => {
            selectedWorkflow = (event.currentTarget as HTMLSelectElement).value as ContentListWorkflowId;
            workflowPreview = null;
            workflowIdempotencyKey = '';
            workflowResult = null;
            workflowError = null;
          }}
        >
          {#each CONTENT_LIST_WORKFLOW_OPTIONS as option (option.id)}
            <option value={option.id}>{workflowLabel(option.id)}</option>
          {/each}
        </Select>

        {#if selectedWorkflow === 'categorize'}
          <Input
            aria-label={t(M['content.content_list.category_path'])}
            placeholder={t(M['content.content_list.category_path'])}
            value={workflowCategory}
            disabled={workflowPending}
            oninput={(event: Event) => workflowCategory = (event.currentTarget as HTMLInputElement).value}
          />
        {:else if selectedWorkflow === 'restore'}
          <Select
            aria-label={t(M['content.content_list.restore_status'])}
            value={workflowRestoreStatus}
            disabled={workflowPending}
            onchange={(event: Event) => workflowRestoreStatus = (event.currentTarget as HTMLSelectElement).value as typeof workflowRestoreStatus}
          >
            <option value="draft">{t(M['content.content_list.workflow_draft'])}</option>
            <option value="review">{t(M['content.content_list.workflow_review'])}</option>
            <option value="published">{t(M['content.content_list.workflow_published'])}</option>
          </Select>
        {:else if selectedWorkflow === 'format-body'}
          <Select
            aria-label={t(M['content.content_list.body_format'])}
            value={workflowFormat}
            disabled={workflowPending}
            onchange={(event: Event) => workflowFormat = (event.currentTarget as HTMLSelectElement).value as typeof workflowFormat}
          >
            <option value="markdown">{t(M['content.content_list.workflow_markdown'])}</option>
            <option value="html">{t(M['content.content_list.workflow_html'])}</option>
          </Select>
        {:else if selectedWorkflow === 'automated-review'}
          <Select
            aria-label={t(M['content.content_list.review_kind'])}
            value={workflowReviewKind}
            disabled={workflowPending}
            onchange={(event: Event) => workflowReviewKind = (event.currentTarget as HTMLSelectElement).value}
          >
            <option value="">{t(M['content.content_list.default_review_kind'])}</option>
            <option value="facts">{t(M['content.content_list.workflow_facts'])}</option>
            <option value="safety">{t(M['content.content_list.workflow_safety'])}</option>
            <option value="custom">{t(M['content.content_list.workflow_custom'])}</option>
          </Select>
          <Input
            aria-label={t(M['content.content_list.review_policy_key'])}
            placeholder={t(M['content.content_list.policy_key_optional'])}
            value={workflowPolicyKey}
            disabled={workflowPending}
            oninput={(event: Event) => workflowPolicyKey = (event.currentTarget as HTMLInputElement).value}
          />
        {:else if selectedWorkflow === 'optimize'}
          <Input
            aria-label={t(M['content.content_list.optimization_instructions'])}
            placeholder={t(M['content.content_list.optimization_instructions_optional'])}
            value={workflowInstructions}
            disabled={workflowPending}
            oninput={(event: Event) => workflowInstructions = (event.currentTarget as HTMLInputElement).value}
          />
        {/if}

        <Button
          variant="ghost"
          size="sm"
          type="button"
          disabled={
            workflowPending || !workflowPayloadValid || workflowDuplicateQueued
          }
          onclick={() => void previewWorkflow()}
        >
          {workflowPending
            ? t(M['content.content_list.workflow_working'])
            : workflowDuplicateQueued
              ? t(M['content.content_list.workflow_job_queued'])
              : t(M['content.content_list.workflow_preview'])}
        </Button>

        {#if workflowError}
          <p class="content-workflows__error" role="alert">{workflowError}</p>
        {/if}
        {#if workflowResult?.ok}
          <p class="content-workflows__result" role="status">
            {workflowResultMessage(workflowResult)}
            {#if typeof workflowResult.details?.jobId === 'string'}
              {t(M['content.content_list.job_queued_progress'], {
                id: workflowResult.details.jobId,
              })}
            {/if}
          </p>
        {/if}
      </section>
    {/if}

    {#if refreshing && viewMode !== 'compact'}
      <!-- DataTable announces its own refresh; the card views need their own. -->
      <p class="content-refreshing" role="status" aria-live="polite">
        {t(M['content.content_list.refreshing'])}
      </p>
    {/if}

    {#if viewMode === 'compact'}
      <!--
        The compact table stays mounted for empty and loading results so its
        table semantics and operator affordances remain stable across queries.
        ContentList itself owns the agent-addressable surface in every view.
      -->
      <div class="content-table-wrapper">
        <DataTable
          data={pageRows}
          columns={tableColumns}
          rowKey={CONTENT_LIST_ROW_KEY}
          {controller}
          sortable
          agentAddressable
          loading={isLoading}
          caption={t(M['content.content_list.table_caption'])}
          rowLabel={(row: ContentListRow) => row.title}
          empty={tableEmptyState}
        />
      </div>
    {:else if isLoading && pageRows.length === 0}
      <div class="state-panel" role="status">
        {t(M['content.content_list.loading'])}
      </div>
    {:else if pageRows.length === 0}
      <div class="state-panel empty-state">
        {lifecycleMode === 'trash'
          ? t(M['content.content_list.trash_empty'])
          : t(M['content.content_list.empty'])}
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
                disabled={workflowPending || !row.identified || rowPending(row) || allMatchingSelected}
                aria-label={selectRowLabel(row)}
                title={row.identified
                  ? rowPending(row)
                    ? t(M['content.content_list.row_pending'])
                    : undefined
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
                <Button
                  variant="ghost"
                  type="button"
                  class="quiet-action"
                  disabled={rowPending(row)}
                  onclick={() => onEdit(content)}
                >
                  {t(M['content.content_list.edit'])}
                </Button>
              {/if}
              {#if actions.includes('delete')}
                <Button
                  variant="ghost"
                  type="button"
                  disabled={rowPending(row)}
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
                  disabled={workflowPending || !row.identified || rowPending(row) || allMatchingSelected}
                  aria-label={selectRowLabel(row)}
                  title={row.identified
                    ? rowPending(row)
                      ? t(M['content.content_list.row_pending'])
                      : undefined
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
                  <Button
                    variant="ghost"
                    type="button"
                    class="content-action-btn"
                    disabled={rowPending(row)}
                    onclick={() => onEdit(content)}
                  >
                    {t(M['content.content_list.edit'])}
                  </Button>
                {/if}
                {#if actions.includes('delete')}
                  <Button
                    variant="ghost"
                    type="button"
                    class="content-action-btn delete-btn"
                    disabled={rowPending(row)}
                    onclick={() => handleDeleteContent(row)}
                  >
                    {t(M['content.content_list.delete'])}
                  </Button>
                {/if}
              </div>
            </div>
          </div>
        {/each}
      </div>
    {/if}

    {#if showPagination}
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

<ConfirmDialog
  open={workflowConfirmOpen}
  title={t(M['content.content_list.workflow_confirm'], {
    workflow: selectedWorkflow
      ? workflowLabel(selectedWorkflow)
      : t(M['content.content_list.workflow_noun']),
  })}
  message={workflowPreviewMessage()}
  confirmLabel={workflowPending
    ? t(M['content.content_list.workflow_applying'])
    : t(M['content.content_list.workflow_apply'])}
  cancelLabel={t(M['content.content_list.cancel'])}
  destructive={CONTENT_LIST_WORKFLOW_OPTIONS.find((option) => option.id === selectedWorkflow)?.sensitivity === 'sensitive'}
  onconfirm={() => void applyWorkflow()}
  oncancel={cancelWorkflowConfirmation}
/>

<style>
  .content-list-wrapper {
    display: flex;
    flex-direction: column;
    width: 100%;
  }

  .content-list-wrapper.data-surface-highlighted {
    outline: 2px solid var(--smrt-color-primary);
    outline-offset: 0.25rem;
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

  .content-workflows {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.75rem;
    margin-bottom: 1rem;
    padding: 0.75rem;
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 0.65rem;
    background: var(--smrt-color-surface-container-low);
  }

  .content-workflows__error,
  .content-workflows__result {
    flex-basis: 100%;
    margin: 0;
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
  }

  .content-workflows__error {
    color: var(--smrt-color-error);
  }

  .content-workflows__result {
    color: var(--smrt-color-on-surface-variant);
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

  .content-freshness {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    min-height: 2rem;
    margin-bottom: 0.75rem;
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
  }

  .content-freshness :global(.refresh-button) {
    transition: background 0.2s, color 0.2s;
  }

  .content-jobs {
    margin-bottom: 1rem;
  }

  .content-jobs__list {
    display: grid;
    gap: 0.5rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .content-job {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.65rem 0.75rem;
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 0.5rem;
    background: var(--smrt-color-surface-container-low);
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
  }

  .content-job--failed {
    border-color: var(--smrt-color-error);
  }

  .content-job__identity {
    color: var(--smrt-color-on-surface);
    font-weight: var(--smrt-typography-weight-semibold, 600);
  }

  .content-job progress {
    min-width: 8rem;
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

  .state-panel--inline {
    margin-bottom: 1rem;
    padding: 1rem;
    text-align: left;
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

  @media (prefers-reduced-motion: reduce) {
    .content-freshness :global(.refresh-button),
    .actions-cell :global(.icon-btn) {
      transition: none;
    }
  }
</style>
