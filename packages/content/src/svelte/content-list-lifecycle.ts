/**
 * Browser-safe trash, restore, and permanent-delete orchestration for
 * ContentList (#2454).
 *
 * Lifecycle authority stays on the server. The browser supplies a selection
 * hint and expected count, then renders the server's resolved preview. Apply
 * must reuse that preview's opaque confirmation token and exact request
 * identity; a changed query, count, permission, row revision, or eligibility
 * is therefore rejected by the principal-bound server adapter rather than
 * being guessed from stale list rows.
 */

import type {
  DataSurfaceActionResult,
  DataSurfaceIdentity,
  DataSurfaceJsonValue,
  DataSurfaceSelectionReference,
} from '@happyvertical/smrt-ui/data';
import type { ContentListDataQueryRequest } from './content-list-query.js';

export const CONTENT_LIST_LIFECYCLE_ACTION_IDS = [
  'move-to-trash',
  'restore',
  'permanent-delete',
] as const;

export type ContentListLifecycleActionId =
  (typeof CONTENT_LIST_LIFECYCLE_ACTION_IDS)[number];

export type ContentListRestoreStatus = 'draft' | 'review' | 'published';

export interface ContentListLifecycleTarget {
  /** Canonical server query. Required for all-matching selections. */
  query?: ContentListDataQueryRequest;
  /** Count visible when the operator requested the preview. */
  expectedCount: number;
  /** Operator-entered server preview count, sent only on permanent-delete apply. */
  confirmedCount?: number;
}

export interface ContentListLifecycleRequest {
  version: 1;
  requestId: string;
  identity: DataSurfaceIdentity;
  actionId: ContentListLifecycleActionId;
  phase: 'preview' | 'apply';
  selection: DataSurfaceSelectionReference;
  payload?: DataSurfaceJsonValue;
  expectedRevision: number;
  target: ContentListLifecycleTarget;
  confirmationToken?: string;
  idempotencyKey?: string;
}

export interface ContentListLifecycleClient {
  preview(
    request: ContentListLifecycleRequest,
  ): Promise<DataSurfaceActionResult>;
  apply(request: ContentListLifecycleRequest): Promise<DataSurfaceActionResult>;
}

export interface ContentListLifecycleBinding {
  client: ContentListLifecycleClient;
  /** Server-owned surface revision. Never derived from list rows. */
  revision?: number;
  /** Override the default ContentList identity. */
  identity?: DataSurfaceIdentity;
  /** Server action-selection cap. Defaults to 200 and fails closed in the UI. */
  maxSelectionSize?: number;
}

export interface ContentListLifecycleTransportOptions {
  apiBaseUrl?: string;
  path?: string;
  fetch?: typeof globalThis.fetch;
  headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
  credentials?: RequestCredentials;
}

export type ContentListLifecycleTransportErrorReason =
  | 'network_failure'
  | 'invalid_json'
  | 'http_error'
  | 'invalid_result';

export class ContentListLifecycleTransportError extends Error {
  readonly status?: number;
  readonly reason: ContentListLifecycleTransportErrorReason;

  constructor(
    message: string,
    status?: number,
    reason: ContentListLifecycleTransportErrorReason = 'http_error',
  ) {
    super(message);
    this.name = 'ContentListLifecycleTransportError';
    this.status = status;
    this.reason = reason;
  }
}

export interface ContentListLifecycleOutcome {
  rowId: string | number;
  status: 'accepted' | 'skipped' | 'failed';
  reason?: string;
  /** Canonical runtime subtype, for example a Document or Mirror. */
  resourceType?: string;
  /** Canonical resource id used by the server mutation. */
  resourceId?: string;
}

export interface ContentListLifecycleSummary {
  resolvedCount: number;
  accepted: number;
  skipped: number;
  failed: number;
  outcomes: ContentListLifecycleOutcome[];
  representativeLabels: string[];
  expiresAt?: number;
  /** Correlates the visible result with principal audit metadata. */
  auditReference: string;
}

export type ContentListLifecycleControllerStatus =
  | 'idle'
  | 'previewing'
  | 'ready'
  | 'applying'
  | 'succeeded'
  | 'failed';

export interface ContentListLifecycleSnapshot {
  status: ContentListLifecycleControllerStatus;
  actionId?: ContentListLifecycleActionId;
  selection?: DataSurfaceSelectionReference;
  summary?: ContentListLifecycleSummary;
  result?: DataSurfaceActionResult;
  error?: string;
  /** True when the only safe recovery is another server preview. */
  renewalRequired: boolean;
}

export interface ContentListLifecyclePreviewInput {
  actionId: ContentListLifecycleActionId;
  selection: DataSurfaceSelectionReference;
  expectedCount: number;
  query?: ContentListDataQueryRequest;
  restoreStatus?: ContentListRestoreStatus;
  /** Invalidates the preview when the visible query/selection changes. */
  viewKey: string;
}

export interface ContentListLifecycleControllerOptions
  extends ContentListLifecycleBinding {
  createRequestId?: () => string;
  createIdempotencyKey?: () => string;
}

export interface ContentListLifecycleController {
  snapshot(): ContentListLifecycleSnapshot;
  subscribe(
    listener: (snapshot: ContentListLifecycleSnapshot) => void,
  ): () => void;
  preview(
    input: ContentListLifecyclePreviewInput,
  ): Promise<ContentListLifecycleSnapshot>;
  /**
   * Apply only after the operator confirms the server-resolved count. The
   * number is intentionally passed again rather than inferred by the UI.
   */
  apply(confirmedCount: number): Promise<ContentListLifecycleSnapshot>;
  /** Drop a preview after any visible query or selection change. */
  invalidate(viewKey: string): void;
  reset(): void;
}

const DEFAULT_IDENTITY: DataSurfaceIdentity = {
  surfaceId: 'content-list',
  kind: 'table',
};

const RENEWAL_REASONS = new Set([
  'stale_preview',
  'stale_revision',
  'invalid_or_expired_confirmation',
  'confirmation_mismatch',
  'confirmation_replayed',
  'count_drifted',
  'matching_count_drifted',
  'row_revision_drifted',
  'stale_query_fingerprint',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function identityMatches(
  value: unknown,
  expected: DataSurfaceIdentity,
): boolean {
  if (!isRecord(value)) return false;
  const expectedSubject = expected.subject;
  const subject = isRecord(value.subject) ? value.subject : undefined;
  return (
    value.surfaceId === expected.surfaceId &&
    value.kind === expected.kind &&
    (expectedSubject
      ? subject?.type === expectedSubject.type &&
        subject.id === expectedSubject.id
      : value.subject === undefined)
  );
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return 'The content lifecycle request failed.';
}

function boundedId(prefix: string): string {
  const random = globalThis.crypto?.randomUUID?.();
  if (random) return `${prefix}-${random}`;
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** Authenticated fetch transport for the host's lifecycle route. */
export function createContentListLifecycleTransport(
  options: ContentListLifecycleTransportOptions = {},
): ContentListLifecycleClient {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new TypeError(
      'createContentListLifecycleTransport requires a fetch implementation',
    );
  }
  const url = joinUrl(
    options.apiBaseUrl ?? '/api/v1',
    options.path ?? 'contents/lifecycle',
  );

  async function invoke(
    request: ContentListLifecycleRequest,
  ): Promise<DataSurfaceActionResult> {
    let headers: Headers;
    try {
      const provided =
        typeof options.headers === 'function'
          ? await options.headers()
          : options.headers;
      headers = new Headers(provided);
      headers.set('content-type', 'application/json');
      if (!headers.has('accept')) headers.set('accept', 'application/json');
    } catch {
      throw new ContentListLifecycleTransportError(
        'The content lifecycle request could not be prepared.',
        undefined,
        'network_failure',
      );
    }

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(request),
        ...(options.credentials ? { credentials: options.credentials } : {}),
      });
    } catch {
      throw new ContentListLifecycleTransportError(
        'The content lifecycle request failed.',
        undefined,
        'network_failure',
      );
    }

    let payload: unknown;
    try {
      const text = await response.text();
      payload = text ? JSON.parse(text) : undefined;
    } catch {
      throw new ContentListLifecycleTransportError(
        'The content lifecycle route returned invalid JSON.',
        response.status,
        'invalid_json',
      );
    }
    if (!response.ok) {
      const error =
        isRecord(payload) && isRecord(payload.error)
          ? payload.error
          : undefined;
      throw new ContentListLifecycleTransportError(
        typeof error?.message === 'string'
          ? error.message
          : `The content lifecycle request failed with HTTP ${response.status}.`,
        response.status,
        'http_error',
      );
    }
    const result =
      isRecord(payload) && Object.hasOwn(payload, 'result')
        ? payload.result
        : payload;
    if (
      !isRecord(result) ||
      result.version !== 1 ||
      typeof result.ok !== 'boolean' ||
      result.requestId !== request.requestId ||
      result.actionId !== request.actionId ||
      result.phase !== request.phase ||
      !identityMatches(result.identity, request.identity)
    ) {
      throw new ContentListLifecycleTransportError(
        'The content lifecycle route returned an invalid result.',
        response.status,
        'invalid_result',
      );
    }
    return result as unknown as DataSurfaceActionResult;
  }

  return { preview: invoke, apply: invoke };
}

/** Parse the bounded, optional preview/apply details without trusting casts. */
export function readContentListLifecycleSummary(
  result: DataSurfaceActionResult,
): ContentListLifecycleSummary {
  const details = isRecord(result.details) ? result.details : {};
  const outcomes = Array.isArray(details.outcomes)
    ? details.outcomes.flatMap((entry): ContentListLifecycleOutcome[] => {
        if (!isRecord(entry)) return [];
        if (
          (typeof entry.rowId !== 'string' &&
            typeof entry.rowId !== 'number') ||
          !['accepted', 'skipped', 'failed'].includes(String(entry.status))
        )
          return [];
        return [
          {
            rowId: entry.rowId,
            status: entry.status as ContentListLifecycleOutcome['status'],
            ...(typeof entry.reason === 'string'
              ? { reason: entry.reason }
              : {}),
            ...(typeof entry.resourceType === 'string'
              ? { resourceType: entry.resourceType }
              : {}),
            ...(typeof entry.resourceId === 'string'
              ? { resourceId: entry.resourceId }
              : {}),
          },
        ];
      })
    : [];
  const number = (value: unknown): number =>
    Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
  const representativeLabels = Array.isArray(details.representativeLabels)
    ? details.representativeLabels.filter(
        (label): label is string => typeof label === 'string',
      )
    : [];
  return {
    resolvedCount: number(details.count),
    accepted: number(details.accepted),
    skipped: number(details.skipped),
    failed: number(details.failed),
    outcomes,
    representativeLabels,
    ...(typeof details.expiresAt === 'number' &&
    Number.isFinite(details.expiresAt)
      ? { expiresAt: details.expiresAt }
      : {}),
    auditReference:
      typeof details.auditReference === 'string'
        ? details.auditReference
        : result.requestId,
  };
}

function cloneSelection(
  selection: DataSurfaceSelectionReference,
): DataSurfaceSelectionReference {
  return selection.scope === 'explicit-ids'
    ? { scope: 'explicit-ids', rowIds: [...selection.rowIds] }
    : { ...selection };
}

function requestPayload(
  input: ContentListLifecyclePreviewInput,
): DataSurfaceJsonValue | undefined {
  return input.actionId === 'restore'
    ? { status: input.restoreStatus ?? 'draft' }
    : undefined;
}

/** Framework-free state machine shared by UI and agent-driven lifecycle flows. */
export function createContentListLifecycleController(
  options: ContentListLifecycleControllerOptions,
): ContentListLifecycleController {
  const listeners = new Set<(snapshot: ContentListLifecycleSnapshot) => void>();
  const identity = options.identity ?? DEFAULT_IDENTITY;
  const createRequestId =
    options.createRequestId ?? (() => boundedId('lifecycle'));
  const createIdempotencyKey =
    options.createIdempotencyKey ?? (() => boundedId('lifecycle-apply'));
  let state: ContentListLifecycleSnapshot = {
    status: 'idle',
    renewalRequired: false,
  };
  let generation = 0;
  let previewViewKey: string | undefined;
  let frozen:
    | {
        request: ContentListLifecycleRequest;
        viewKey: string;
        result: DataSurfaceActionResult;
      }
    | undefined;
  let pendingApply:
    | {
        request: ContentListLifecycleRequest;
        confirmedCount: number;
      }
    | undefined;

  const publish = (next: ContentListLifecycleSnapshot): void => {
    state = next;
    for (const listener of listeners) listener({ ...state });
  };

  const reset = (): void => {
    generation += 1;
    previewViewKey = undefined;
    frozen = undefined;
    pendingApply = undefined;
    publish({ status: 'idle', renewalRequired: false });
  };

  const preview = async (
    input: ContentListLifecyclePreviewInput,
  ): Promise<ContentListLifecycleSnapshot> => {
    const currentGeneration = ++generation;
    previewViewKey = input.viewKey;
    frozen = undefined;
    const selection = cloneSelection(input.selection);
    if (
      input.expectedCount < 0 ||
      !Number.isSafeInteger(input.expectedCount) ||
      input.expectedCount > (options.maxSelectionSize ?? 200) ||
      (selection.scope === 'all-matching' && !input.query) ||
      (selection.scope === 'explicit-ids' && selection.rowIds.length === 0)
    ) {
      const failed = {
        status: 'failed' as const,
        actionId: input.actionId,
        selection,
        error: 'The lifecycle selection is invalid.',
        renewalRequired: true,
      };
      publish(failed);
      return failed;
    }
    const payload = requestPayload(input);
    const request: ContentListLifecycleRequest = {
      version: 1,
      requestId: createRequestId(),
      identity,
      actionId: input.actionId,
      phase: 'preview',
      selection,
      expectedRevision: options.revision ?? 0,
      target: {
        expectedCount: input.expectedCount,
        ...(input.query ? { query: input.query } : {}),
      },
      ...(payload === undefined ? {} : { payload }),
    };
    publish({
      status: 'previewing',
      actionId: input.actionId,
      selection,
      renewalRequired: false,
    });
    try {
      const result = await options.client.preview(request);
      if (currentGeneration !== generation) return state;
      previewViewKey = undefined;
      const summary = readContentListLifecycleSummary(result);
      if (!result.ok || !result.confirmationToken) {
        const reason = result.reason ?? 'preview_failed';
        publish({
          status: 'failed',
          actionId: input.actionId,
          selection,
          result,
          summary,
          error: reason,
          renewalRequired: RENEWAL_REASONS.has(reason),
        });
        return state;
      }
      frozen = { request, viewKey: input.viewKey, result };
      publish({
        status: 'ready',
        actionId: input.actionId,
        selection,
        result,
        summary,
        renewalRequired: false,
      });
      return state;
    } catch (error) {
      if (currentGeneration !== generation) return state;
      previewViewKey = undefined;
      publish({
        status: 'failed',
        actionId: input.actionId,
        selection,
        error: messageOf(error),
        renewalRequired: true,
      });
      return state;
    }
  };

  const apply = async (
    confirmedCount: number,
  ): Promise<ContentListLifecycleSnapshot> => {
    const previewed = frozen;
    const summary = state.summary;
    const expired =
      summary?.expiresAt !== undefined && summary.expiresAt <= Date.now();
    const retry = state.status === 'failed' ? pendingApply : undefined;
    if (
      (state.status !== 'ready' && !retry) ||
      !previewed ||
      !summary ||
      confirmedCount !== summary.resolvedCount ||
      (retry !== undefined && retry.confirmedCount !== confirmedCount) ||
      expired
    ) {
      frozen = undefined;
      publish({
        ...state,
        status: 'failed',
        error: expired
          ? 'The lifecycle preview expired and must be renewed.'
          : 'The confirmed count no longer matches the lifecycle preview.',
        renewalRequired: true,
      });
      return state;
    }
    const currentGeneration = ++generation;
    const request: ContentListLifecycleRequest = retry?.request ?? {
      ...previewed.request,
      phase: 'apply',
      target: {
        ...previewed.request.target,
        ...(previewed.request.actionId === 'permanent-delete'
          ? { confirmedCount }
          : {}),
      },
      confirmationToken: previewed.result.confirmationToken,
      idempotencyKey: createIdempotencyKey(),
    };
    pendingApply = { request, confirmedCount };
    publish({ ...state, status: 'applying', error: undefined });
    try {
      const result = await options.client.apply(request);
      if (currentGeneration !== generation) return state;
      const nextSummary = readContentListLifecycleSummary(result);
      if (!result.ok) {
        const reason = result.reason ?? 'apply_failed';
        if (reason === 'idempotency_in_progress') {
          publish({
            ...state,
            status: 'failed',
            result,
            error: reason,
            renewalRequired: false,
          });
          return state;
        }
        frozen = undefined;
        pendingApply = undefined;
        publish({
          ...state,
          status: 'failed',
          result,
          summary: nextSummary,
          error: reason,
          renewalRequired: RENEWAL_REASONS.has(reason),
        });
        return state;
      }
      frozen = undefined;
      pendingApply = undefined;
      publish({
        ...state,
        status: 'succeeded',
        result,
        summary: nextSummary,
        renewalRequired: false,
      });
      return state;
    } catch (error) {
      if (currentGeneration !== generation) return state;
      publish({
        ...state,
        status: 'failed',
        error: messageOf(error),
        // The server may have committed before the response was lost. Retain
        // the exact token/idempotency envelope so retry can replay safely.
        renewalRequired: false,
      });
      return state;
    }
  };

  return {
    snapshot: () => ({ ...state }),
    subscribe(listener) {
      listeners.add(listener);
      listener({ ...state });
      return () => listeners.delete(listener);
    },
    preview,
    apply,
    invalidate(viewKey) {
      // Once apply starts, the server-authorized mutation owns completion.
      // A changing view must not discard its refresh, audit, or reconciliation.
      if (state.status === 'applying') return;
      if (
        (previewViewKey !== undefined && previewViewKey !== viewKey) ||
        (frozen !== undefined && frozen.viewKey !== viewKey)
      ) {
        reset();
      }
    },
    reset,
  };
}

/** Keep unsuccessful rows selected so partial failures are visible/retryable. */
export function reconcileContentListLifecycleSelection(
  selectedRowIds: readonly (string | number)[],
  result: DataSurfaceActionResult,
): Array<string | number> {
  const accepted = new Set(
    readContentListLifecycleSummary(result)
      .outcomes.filter((outcome) => outcome.status === 'accepted')
      .map((outcome) => String(outcome.rowId)),
  );
  return selectedRowIds.filter((rowId) => !accepted.has(String(rowId)));
}
