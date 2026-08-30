/**
 * Browser contract for ContentList bulk workflows (#2453).
 *
 * The server implementation lives behind an application-owned route. This
 * module deliberately mirrors its JSON contract without importing the Node
 * adapter, so importing `@happyvertical/smrt-content/svelte` remains safe in a
 * browser bundle.
 */

import type {
  DataSurfaceActionResult,
  DataSurfaceIdentity,
  DataSurfaceJsonValue,
  DataSurfaceSelectionReference,
} from '@happyvertical/smrt-ui/data';
import type { ContentListDataQueryRequest } from './content-list-query.js';

export const CONTENT_LIST_WORKFLOW_IDS = [
  'move-to-trash',
  'mark-draft',
  'submit-review',
  'publish',
  'archive',
  'restore',
  'automated-review',
  'format-body',
  'categorize',
  'optimize',
] as const;

export type ContentListWorkflowId = (typeof CONTENT_LIST_WORKFLOW_IDS)[number];

export interface ContentListWorkflowOption {
  id: ContentListWorkflowId;
  label: string;
  execution: 'foreground' | 'background';
  sensitivity: 'public' | 'sensitive';
}

/**
 * Workflow choices with default English descriptor labels. ContentList maps
 * their stable ids through its i18n catalog before rendering them.
 */
export const CONTENT_LIST_WORKFLOW_OPTIONS: readonly ContentListWorkflowOption[] =
  Object.freeze([
    option('move-to-trash', 'Move to trash', 'foreground', 'sensitive'),
    option('mark-draft', 'Mark draft'),
    option('submit-review', 'Submit for review'),
    option('publish', 'Publish', 'foreground', 'sensitive'),
    option('archive', 'Archive'),
    option('restore', 'Restore'),
    option('automated-review', 'Automated review', 'background'),
    option('format-body', 'Format body', 'background'),
    option('categorize', 'Categorize'),
    option('optimize', 'Optimize / complete', 'background'),
  ]);

function option(
  id: ContentListWorkflowId,
  label: string,
  execution: ContentListWorkflowOption['execution'] = 'foreground',
  sensitivity: ContentListWorkflowOption['sensitivity'] = 'public',
): ContentListWorkflowOption {
  return { id, label, execution, sensitivity };
}

export interface ContentListWorkflowRequest {
  version: 1;
  requestId: string;
  identity: DataSurfaceIdentity;
  actionId: ContentListWorkflowId;
  phase: 'preview' | 'apply';
  selection: DataSurfaceSelectionReference;
  payload?: DataSurfaceJsonValue;
  expectedRevision: number;
  target: {
    query?: ContentListDataQueryRequest;
    expectedCount: number;
  };
  confirmationToken?: string;
  idempotencyKey?: string;
}

export interface ContentListWorkflowClient {
  preview(
    request: ContentListWorkflowRequest,
  ): Promise<DataSurfaceActionResult>;
  apply(request: ContentListWorkflowRequest): Promise<DataSurfaceActionResult>;
  /** Resolve a background job through the host's authenticated job runner. */
  status?(jobId: string): Promise<ContentListWorkflowJobStatus>;
}

export interface ContentListWorkflowJobStatus {
  jobId: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  /** Terminal row outcomes use the same partial-result contract as apply. */
  result?: DataSurfaceActionResult;
  reason?: string;
}

/** Opt-in workflow binding supplied to ContentList by an authenticated host. */
export interface ContentListWorkflowBinding {
  client: ContentListWorkflowClient;
  /** Server-owned surface revision expected by preview/apply. Defaults to zero. */
  revision?: number;
  /** Server action-selection cap used to gate all-matching UI. Defaults to 200. */
  maxSelectionSize?: number;
  /** Override the default mounted identity when the host uses another surface. */
  identity?: DataSurfaceIdentity;
}

export interface ContentListWorkflowTransportOptions {
  apiBaseUrl?: string;
  /** Host route that dispatches the request by its `phase`. */
  path?: string;
  /** Optional authenticated job-status path. `{jobId}` is URL encoded. */
  jobStatusPath?: string;
  fetch?: typeof globalThis.fetch;
  headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
  credentials?: RequestCredentials;
}

export class ContentListWorkflowError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'ContentListWorkflowError';
    this.status = status;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function matchesIdentity(
  value: unknown,
  expected: DataSurfaceIdentity,
): boolean {
  if (!isRecord(value)) return false;
  const subject = isRecord(value.subject) ? value.subject : undefined;
  return (
    value.surfaceId === expected.surfaceId &&
    value.kind === expected.kind &&
    (expected.subject
      ? subject?.type === expected.subject.type &&
        subject.id === expected.subject.id
      : value.subject === undefined)
  );
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

/** Creates the shared human/agent preview/apply transport for a host route. */
export function createContentListWorkflowTransport(
  options: ContentListWorkflowTransportOptions = {},
): ContentListWorkflowClient {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new TypeError(
      'createContentListWorkflowTransport requires a fetch implementation',
    );
  }
  const url = joinUrl(
    options.apiBaseUrl ?? '/api/v1',
    options.path ?? 'contents/actions',
  );

  async function fetchJson(url: string, init: RequestInit): Promise<unknown> {
    const response = await fetchImpl(url, init);
    const text = await response.text();
    let payload: unknown;
    try {
      payload = text ? JSON.parse(text) : undefined;
    } catch {
      throw new ContentListWorkflowError(
        'The content workflow returned invalid JSON.',
        response.status,
      );
    }
    if (!response.ok) {
      const error =
        isRecord(payload) && isRecord(payload.error)
          ? payload.error
          : undefined;
      throw new ContentListWorkflowError(
        typeof error?.message === 'string'
          ? error.message
          : `The content workflow failed with HTTP ${response.status}.`,
        response.status,
      );
    }
    return payload;
  }

  async function invoke(
    request: ContentListWorkflowRequest,
  ): Promise<DataSurfaceActionResult> {
    const extraHeaders =
      typeof options.headers === 'function'
        ? await options.headers()
        : options.headers;
    const headers = new Headers(extraHeaders);
    headers.set('content-type', 'application/json');
    if (!headers.has('accept')) headers.set('accept', 'application/json');
    const payload = await fetchJson(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(request),
      ...(options.credentials ? { credentials: options.credentials } : {}),
    });
    const result =
      isRecord(payload) && Object.hasOwn(payload, 'result')
        ? payload.result
        : payload;
    if (
      !isRecord(result) ||
      result.version !== 1 ||
      typeof result.ok !== 'boolean' ||
      result.requestId !== request.requestId ||
      result.phase !== request.phase ||
      result.actionId !== request.actionId ||
      !matchesIdentity(result.identity, request.identity)
    ) {
      throw new ContentListWorkflowError(
        'The content workflow returned an invalid result.',
      );
    }
    return result as unknown as DataSurfaceActionResult;
  }

  const client: ContentListWorkflowClient = {
    preview: invoke,
    apply: invoke,
  };
  if (options.jobStatusPath) {
    client.status = async (jobId) => {
      const extraHeaders =
        typeof options.headers === 'function'
          ? await options.headers()
          : options.headers;
      const headers = new Headers(extraHeaders);
      if (!headers.has('accept')) headers.set('accept', 'application/json');
      const path = options.jobStatusPath?.replace(
        '{jobId}',
        encodeURIComponent(jobId),
      );
      const payload = await fetchJson(
        joinUrl(options.apiBaseUrl ?? '/api/v1', path ?? ''),
        {
          method: 'GET',
          headers,
          ...(options.credentials ? { credentials: options.credentials } : {}),
        },
      );
      const status =
        isRecord(payload) && isRecord(payload.job) ? payload.job : payload;
      if (
        !isRecord(status) ||
        typeof status.jobId !== 'string' ||
        status.jobId !== jobId ||
        !['queued', 'running', 'succeeded', 'failed', 'cancelled'].includes(
          String(status.status),
        )
      ) {
        throw new ContentListWorkflowError(
          'The content workflow returned an invalid job status.',
        );
      }
      if (
        status.result !== undefined &&
        (!isRecord(status.result) ||
          status.result.version !== 1 ||
          typeof status.result.ok !== 'boolean' ||
          status.result.phase !== 'apply' ||
          typeof status.result.requestId !== 'string' ||
          typeof status.result.actionId !== 'string' ||
          !isRecord(status.result.identity))
      ) {
        throw new ContentListWorkflowError(
          'The content workflow returned an invalid job result.',
        );
      }
      return status as unknown as ContentListWorkflowJobStatus;
    };
  }
  return client;
}

/** Reads an array-shaped row outcome list from a preview/apply result. */
export function contentListWorkflowOutcomes(
  result: DataSurfaceActionResult | null,
): Array<{
  rowId: string | number;
  status: 'accepted' | 'skipped' | 'failed';
  reason?: string;
}> {
  const outcomes = result?.details?.outcomes;
  if (!Array.isArray(outcomes)) return [];
  return outcomes.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    if (
      (typeof entry.rowId !== 'string' && typeof entry.rowId !== 'number') ||
      !['accepted', 'skipped', 'failed'].includes(String(entry.status))
    ) {
      return [];
    }
    return [
      {
        rowId: entry.rowId,
        status: entry.status as 'accepted' | 'skipped' | 'failed',
        ...(typeof entry.reason === 'string' ? { reason: entry.reason } : {}),
      },
    ];
  });
}
