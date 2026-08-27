/**
 * Principal-bound ContentList bulk workflows (#2453).
 *
 * The generic action adapter owns confirmation tokens, idempotency, principal
 * execution, permission checks, per-row outcomes, and background acceptance.
 * This module supplies the content-specific half: declarative workflows,
 * canonical query resolution, row-revision binding, governance eligibility,
 * and domain mutations.
 */

import { createHash } from 'node:crypto';
// Publication and automated-review permissions include facts operations. The
// catalog is registration-driven, so ensure those definitions exist even when
// a host imports only the content server entry point.
import '@happyvertical/smrt-facts';
import {
  type PrincipalRun,
  PrincipalToolNotAllowedError,
} from '@happyvertical/smrt-agents';
import {
  createDataSurfaceActionAdapter,
  type DataSurfaceActionAdapter,
  type DataSurfaceActionStateStore,
  type DataSurfaceBackgroundQueue,
  type DataSurfaceServerActionContext,
  type DataSurfaceServerActionDefinition,
  type DataSurfaceServerActionRequest,
} from '@happyvertical/smrt-agents/server';
import {
  createDataQueryFingerprint,
  normalizeDataQueryRequest,
} from '@happyvertical/smrt-core';
import type {
  DataQueryFilter,
  DataQueryRequest,
} from '@happyvertical/smrt-types';
import type {
  DataSurfaceActionResult,
  DataSurfaceDescriptor,
  DataSurfaceIdentity,
  DataSurfaceJsonObject,
  DataSurfaceJsonValue,
  DataSurfaceRowId,
} from '@happyvertical/smrt-ui/data';
import type { Content } from '../content.js';
import {
  buildContentQuerySchema,
  CONTENT_QUERY_MAX_PAGE_LIMIT,
  type ContentQueryCollection,
  type ContentQueryScope,
  executeContentQuery,
} from '../content-query.js';

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
export type ContentListWorkflowExecution = 'foreground' | 'background';
export type ContentListWorkflowConfirmation = 'required' | 'none';

export interface ContentListWorkflowDescriptor {
  id: ContentListWorkflowId;
  label: string;
  description: string;
  selectionScopes: Array<'current-page' | 'explicit-ids' | 'all-matching'>;
  sensitivity: 'public' | 'sensitive';
  confirmation: ContentListWorkflowConfirmation;
  execution: ContentListWorkflowExecution;
  inputSchema: DataSurfaceJsonObject | null;
  eligibility: string[];
  permissionRequirements: {
    tool: string;
    operations: Array<{ id: string; collection: string; action: string }>;
  };
  consequences: string[];
  partialResult: {
    statuses: Array<'accepted' | 'skipped' | 'failed'>;
    preservesFailedSelection: true;
  };
}

const ALL_SELECTION_SCOPES: ContentListWorkflowDescriptor['selectionScopes'] = [
  'current-page',
  'explicit-ids',
  'all-matching',
];

const NO_INPUT: DataSurfaceJsonObject = {
  type: 'object',
  additionalProperties: false,
};

const OPTIONAL_REVIEW_INPUT: DataSurfaceJsonObject = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', maxLength: 64 },
    policyKey: { type: 'string', maxLength: 128 },
  },
};

const CONTENT_UPDATE_OPERATION = {
  id: 'contents:update',
  collection: 'contents',
  action: 'update',
};

const CONTENT_READ_OPERATION = {
  id: 'contents:read',
  collection: 'contents',
  action: 'read',
};

const GOVERNANCE_READ_OPERATIONS = [
  {
    id: 'content-governance-assignments:read',
    collection: 'contentgovernanceassignments',
    action: 'read',
  },
  {
    id: 'content-governance-policies:read',
    collection: 'contentgovernancepolicies',
    action: 'read',
  },
  {
    id: 'content-governance-profiles:read',
    collection: 'contentgovernanceprofiles',
    action: 'read',
  },
] as const;

const PUBLICATION_OPERATIONS = [
  CONTENT_READ_OPERATION,
  CONTENT_UPDATE_OPERATION,
  ...GOVERNANCE_READ_OPERATIONS,
  {
    id: 'content-references:read',
    collection: 'contentreferences',
    action: 'read',
  },
  { id: 'facts:read', collection: 'facts', action: 'read' },
  { id: 'fact-contents:read', collection: 'factcontents', action: 'read' },
  { id: 'fact-sources:read', collection: 'factsources', action: 'read' },
  { id: 'content-reviews:read', collection: 'contentreviews', action: 'read' },
  {
    id: 'content-corrections:read',
    collection: 'contentcorrections',
    action: 'read',
  },
  {
    id: 'content-versions:read',
    collection: 'contentversions',
    action: 'read',
  },
  {
    id: 'content-versions:create',
    collection: 'contentversions',
    action: 'create',
  },
] as const;

const AUTOMATED_REVIEW_OPERATIONS = [
  CONTENT_READ_OPERATION,
  CONTENT_UPDATE_OPERATION,
  ...GOVERNANCE_READ_OPERATIONS,
  {
    id: 'content-references:read',
    collection: 'contentreferences',
    action: 'read',
  },
  { id: 'facts:read', collection: 'facts', action: 'read' },
  { id: 'fact-contents:read', collection: 'factcontents', action: 'read' },
  {
    id: 'prompt-overrides:read',
    collection: 'promptoverrides',
    action: 'read',
  },
  {
    id: 'content-versions:read',
    collection: 'contentversions',
    action: 'read',
  },
  {
    id: 'content-versions:create',
    collection: 'contentversions',
    action: 'create',
  },
  {
    id: 'content-reviews:create',
    collection: 'contentreviews',
    action: 'create',
  },
] as const;

export const CONTENT_LIST_WORKFLOWS: readonly ContentListWorkflowDescriptor[] =
  Object.freeze([
    workflow('move-to-trash', 'Move to trash', {
      description: 'Soft-delete eligible content into the trash lifecycle.',
      sensitivity: 'sensitive',
      eligibility: ['content is not already deleted'],
      consequences: [
        'Content leaves active views and becomes restorable from trash.',
      ],
    }),
    workflow('mark-draft', 'Mark draft', {
      description: 'Return eligible active content to draft.',
      eligibility: ['content is not deleted', 'content is not already draft'],
      consequences: ['Published content is no longer public.'],
    }),
    workflow('submit-review', 'Submit for review', {
      description: 'Move eligible draft content into editorial review.',
      eligibility: ['content is draft'],
      consequences: ['Content enters the review queue.'],
    }),
    workflow('publish', 'Publish', {
      description: 'Publish content that passes current governance readiness.',
      sensitivity: 'sensitive',
      eligibility: [
        'content is draft, review, or archived',
        'publication readiness passes',
      ],
      consequences: [
        'Content becomes public and may create a publication snapshot.',
      ],
      permissionRequirements: {
        tool: 'content.workflow.publish',
        operations: [...PUBLICATION_OPERATIONS],
      },
    }),
    workflow('archive', 'Archive', {
      description: 'Remove eligible content from active publication workflows.',
      eligibility: [
        'content is not deleted',
        'content is not already archived',
      ],
      consequences: ['Published content is no longer public.'],
    }),
    workflow('restore', 'Restore', {
      description: 'Restore deleted content to an explicit eligible status.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['status'],
        properties: {
          status: { enum: ['draft', 'review', 'published'] },
        },
      },
      eligibility: [
        'content is deleted',
        'requested destination is valid',
        'publish readiness passes when publishing',
      ],
      consequences: [
        'Content leaves trash.',
        'Publishing makes content public.',
      ],
      permissionRequirements: {
        tool: 'content.workflow.restore',
        operations: [...PUBLICATION_OPERATIONS],
      },
    }),
    workflow('automated-review', 'Automated review', {
      description: 'Run the configured content governance review.',
      execution: 'background',
      inputSchema: OPTIONAL_REVIEW_INPUT,
      eligibility: [
        'content is not deleted',
        'content governance is configured',
      ],
      consequences: [
        'Creates a review result and may create a review version.',
      ],
      permissionRequirements: {
        tool: 'content.workflow.automated-review',
        operations: [...AUTOMATED_REVIEW_OPERATIONS],
      },
    }),
    workflow('format-body', 'Format body', {
      description: 'Run the application-owned body-formatting workflow.',
      execution: 'background',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { format: { enum: ['markdown', 'html'] } },
      },
      eligibility: [
        'content is not deleted',
        'a formatting handler is configured',
      ],
      consequences: ['The persisted content body may change.'],
    }),
    workflow('categorize', 'Categorize', {
      description: 'Assign one required hierarchical category path.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['category'],
        properties: {
          category: { type: 'string', minLength: 1, maxLength: 256 },
        },
      },
      eligibility: ['content is not deleted', 'category is non-empty'],
      consequences: ['The content category changes.'],
    }),
    workflow('optimize', 'Optimize / complete', {
      description: 'Run the application-owned content optimization workflow.',
      execution: 'background',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { instructions: { type: 'string', maxLength: 4096 } },
      },
      eligibility: [
        'content is draft or review',
        'an optimization handler is configured',
      ],
      consequences: ['Content fields may be revised or completed.'],
    }),
  ]);

function workflow(
  id: ContentListWorkflowId,
  label: string,
  options: Partial<ContentListWorkflowDescriptor> &
    Pick<
      ContentListWorkflowDescriptor,
      'description' | 'eligibility' | 'consequences'
    >,
): ContentListWorkflowDescriptor {
  return {
    id,
    label,
    description: options.description,
    selectionScopes: options.selectionScopes ?? [...ALL_SELECTION_SCOPES],
    sensitivity: options.sensitivity ?? 'public',
    confirmation: options.confirmation ?? 'required',
    execution: options.execution ?? 'foreground',
    inputSchema: options.inputSchema ?? NO_INPUT,
    eligibility: options.eligibility,
    permissionRequirements: options.permissionRequirements ?? {
      tool: `content.workflow.${id}`,
      operations: [CONTENT_READ_OPERATION, CONTENT_UPDATE_OPERATION],
    },
    consequences: options.consequences,
    partialResult: {
      statuses: ['accepted', 'skipped', 'failed'],
      preservesFailedSelection: true,
    },
  };
}

export interface ContentListActionTarget {
  /** Canonical query sent to the content query endpoint. Required except for explicit IDs. */
  query?: DataQueryRequest;
  /** Count visible at selection time; drift fails the preview/apply. */
  expectedCount: number;
}

export interface ContentListActionRequest
  extends DataSurfaceServerActionRequest {
  actionId: ContentListWorkflowId;
  target: ContentListActionTarget;
}

export interface ContentListActionCollection extends ContentQueryCollection {
  get(filter: string | Record<string, unknown>): Promise<Content | null>;
}

export interface ContentListWorkflowHandlers {
  formatBody?: (
    content: Content,
    payload: DataSurfaceJsonValue | undefined,
    run: PrincipalRun,
  ) => Promise<void>;
  optimize?: (
    content: Content,
    payload: DataSurfaceJsonValue | undefined,
    run: PrincipalRun,
  ) => Promise<void>;
}

export interface ContentListActionAdapterOptions {
  state: DataSurfaceActionStateStore;
  collection(
    run: PrincipalRun,
  ): ContentListActionCollection | Promise<ContentListActionCollection>;
  /** Trusted site/organization narrowing, applied in addition to tenant context. */
  scope?: (
    run: PrincipalRun,
  ) => ContentQueryScope | undefined | Promise<ContentQueryScope | undefined>;
  /** Server-owned mounted/catalog revision. Defaults to zero for standalone endpoints. */
  revision?: (
    run: PrincipalRun,
    identity: DataSurfaceIdentity,
  ) => number | Promise<number>;
  authorize?: (
    workflow: ContentListWorkflowId,
    run: PrincipalRun,
  ) => boolean | Promise<boolean>;
  handlers?: ContentListWorkflowHandlers;
  backgroundQueue?: DataSurfaceBackgroundQueue;
  descriptor?: DataSurfaceDescriptor;
  maxSelectionSize?: number;
  representativeLimit?: number;
  tokenTtlMs?: number;
  /** Test/host seam for principal execution; production defaults to executeAsPrincipal. */
  runAsPrincipal?: typeof import('@happyvertical/smrt-agents').executeAsPrincipal;
}

interface ResolvedContentSelection {
  revision: number;
  queryFingerprint: string;
  rowIds: DataSurfaceRowId[];
  rows: Array<Record<string, unknown>>;
  representativeLabels: string[];
  scope: ContentListActionRequest['selection']['scope'];
}

const REQUIRED_QUERY_FIELDS = ['id', 'title', 'status', 'updated_at'] as const;
const DEFAULT_MAX_SELECTION_SIZE = 200;
const DEFAULT_REPRESENTATIVE_LIMIT = 5;

class ContentListActionError extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isPermissionDenied(error: unknown): boolean {
  if (!(error instanceof Error) || error.name !== 'OperationPermissionError')
    return false;
  const decision = (error as Error & { decision?: unknown }).decision;
  return isRecord(decision) && decision.reason === 'permission_denied';
}

function isWorkflowId(value: unknown): value is ContentListWorkflowId {
  return (CONTENT_LIST_WORKFLOW_IDS as readonly unknown[]).includes(value);
}

function payloadRecord(
  value: DataSurfaceJsonValue | undefined,
): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function validPayload(
  workflowId: ContentListWorkflowId,
  payload: DataSurfaceJsonValue | undefined,
): boolean {
  const value = payloadRecord(payload);
  const keys = Object.keys(value);
  switch (workflowId) {
    case 'restore':
      return (
        keys.length === 1 &&
        typeof value.status === 'string' &&
        ['draft', 'review', 'published'].includes(value.status)
      );
    case 'categorize':
      return (
        keys.length === 1 &&
        typeof value.category === 'string' &&
        value.category.trim().length > 0 &&
        value.category.length <= 256
      );
    case 'automated-review':
      return (
        keys.every((key) => ['kind', 'policyKey'].includes(key)) &&
        [value.kind, value.policyKey].every(
          (entry) =>
            entry === undefined ||
            (typeof entry === 'string' &&
              entry.length > 0 &&
              entry.length <= 128),
        )
      );
    case 'format-body':
      return (
        keys.every((key) => key === 'format') &&
        (value.format === undefined ||
          value.format === 'markdown' ||
          value.format === 'html')
      );
    case 'optimize':
      return (
        keys.every((key) => key === 'instructions') &&
        (value.instructions === undefined ||
          (typeof value.instructions === 'string' &&
            value.instructions.length <= 4096))
      );
    default:
      return keys.length === 0;
  }
}

function actionResult(
  request: unknown,
  ok: boolean,
  reason?: string,
): DataSurfaceActionResult {
  const candidate = isRecord(request) ? request : {};
  const identityCandidate = isRecord(candidate.identity)
    ? candidate.identity
    : {};
  const identity: DataSurfaceIdentity =
    typeof identityCandidate.surfaceId === 'string' &&
    ['table', 'list', 'report', 'custom'].includes(
      String(identityCandidate.kind),
    )
      ? (identityCandidate as unknown as DataSurfaceIdentity)
      : { surfaceId: 'content-list', kind: 'table' };
  return {
    version: 1,
    requestId:
      typeof candidate.requestId === 'string'
        ? candidate.requestId
        : 'invalid-request',
    identity,
    actionId:
      typeof candidate.actionId === 'string' ? candidate.actionId : 'invalid',
    phase: candidate.phase === 'apply' ? 'apply' : 'preview',
    ok,
    ...(reason ? { reason } : {}),
  };
}

function validateTarget(request: unknown): string | undefined {
  if (
    !isRecord(request) ||
    !isWorkflowId(request.actionId) ||
    !isRecord(request.target) ||
    !isRecord(request.selection)
  )
    return 'invalid_request';
  const keys = Object.keys(request.target);
  if (keys.some((key) => key !== 'query' && key !== 'expectedCount'))
    return 'invalid_request';
  const expectedCount = request.target.expectedCount;
  if (
    typeof expectedCount !== 'number' ||
    !Number.isSafeInteger(expectedCount) ||
    expectedCount < 0
  ) {
    return 'invalid_request';
  }
  if (
    request.selection.scope !== 'explicit-ids' &&
    !isRecord(request.target.query)
  ) {
    return 'invalid_request';
  }
  return undefined;
}

function statusOf(content: Content): string {
  return String(content.status ?? '').toLowerCase();
}

async function publishReady(content: Content): Promise<boolean> {
  const governance = await content.resolveGovernance();
  if (!governance.isGoverned || !governance.enforcePublishReadiness)
    return true;
  if (!governance.publicationProfileKey) return false;
  return (await content.evaluateReviewProfile(governance.publicationProfileKey))
    .ready;
}

async function eligibility(
  workflowId: ContentListWorkflowId,
  content: Content,
  payload: DataSurfaceJsonValue | undefined,
  handlers: ContentListWorkflowHandlers,
): Promise<{ eligible: boolean; reason?: string }> {
  const status = statusOf(content);
  if (workflowId === 'restore') {
    if (status !== 'deleted') return { eligible: false, reason: 'not_deleted' };
    if (
      payloadRecord(payload).status === 'published' &&
      !(await publishReady(content))
    ) {
      return { eligible: false, reason: 'publish_readiness_failed' };
    }
    return { eligible: true };
  }
  if (status === 'deleted') return { eligible: false, reason: 'deleted' };
  switch (workflowId) {
    case 'move-to-trash':
      return { eligible: true };
    case 'mark-draft':
      return status === 'draft'
        ? { eligible: false, reason: 'already_draft' }
        : { eligible: true };
    case 'submit-review':
      return status === 'draft'
        ? { eligible: true }
        : { eligible: false, reason: 'requires_draft' };
    case 'publish':
      if (!['draft', 'review', 'archived'].includes(status))
        return { eligible: false, reason: 'invalid_status' };
      return (await publishReady(content))
        ? { eligible: true }
        : { eligible: false, reason: 'publish_readiness_failed' };
    case 'archive':
      return status === 'archived'
        ? { eligible: false, reason: 'already_archived' }
        : { eligible: true };
    case 'automated-review':
      return (await content.resolveGovernance()).isGoverned
        ? { eligible: true }
        : { eligible: false, reason: 'governance_unavailable' };
    case 'format-body':
      return handlers.formatBody
        ? { eligible: true }
        : { eligible: false, reason: 'handler_unavailable' };
    case 'categorize':
      return { eligible: true };
    case 'optimize':
      if (!handlers.optimize)
        return { eligible: false, reason: 'handler_unavailable' };
      return ['draft', 'review'].includes(status)
        ? { eligible: true }
        : { eligible: false, reason: 'requires_draft_or_review' };
  }
}

async function applyWorkflow(
  workflowId: ContentListWorkflowId,
  content: Content,
  payload: DataSurfaceJsonValue | undefined,
  run: PrincipalRun,
  handlers: ContentListWorkflowHandlers,
): Promise<void> {
  const input = payloadRecord(payload);
  switch (workflowId) {
    case 'move-to-trash':
      content.status = 'deleted';
      await content.save();
      return;
    case 'mark-draft':
      content.status = 'draft';
      await content.save();
      return;
    case 'submit-review':
      content.status = 'review';
      await content.save();
      return;
    case 'publish':
      content.status = 'published';
      await content.save();
      return;
    case 'archive':
      content.status = 'archived';
      await content.save();
      return;
    case 'restore':
      content.status = input.status as Content['status'];
      await content.save();
      return;
    case 'automated-review':
      await content.runReviewAction({
        ...(typeof input.kind === 'string'
          ? { kind: input.kind as never }
          : {}),
        ...(typeof input.policyKey === 'string'
          ? { policyKey: input.policyKey }
          : {}),
      });
      return;
    case 'format-body':
      if (!handlers.formatBody) throw new Error('format handler unavailable');
      await handlers.formatBody(content, payload, run);
      return;
    case 'categorize':
      content.category = String(input.category).trim();
      await content.save();
      return;
    case 'optimize':
      if (!handlers.optimize) throw new Error('optimize handler unavailable');
      await handlers.optimize(content, payload, run);
      return;
  }
}

function mergeFilter(
  left: DataQueryFilter | undefined,
  right: DataQueryFilter,
): DataQueryFilter {
  return left ? { kind: 'all', filters: [left, right] } : right;
}

function revisionFingerprint(rows: readonly Record<string, unknown>[]): string {
  const canonical = rows
    .map((row) => `${String(row.id)}\u0000${String(row.updated_at ?? '')}`)
    .sort();
  return createHash('sha256')
    .update(canonical.join('\u0001'))
    .digest('base64url');
}

function representativeLabels(
  rows: readonly Record<string, unknown>[],
  limit: number,
): string[] {
  return rows.slice(0, limit).map((row) => {
    const title = typeof row.title === 'string' ? row.title.trim() : '';
    return title || String(row.id);
  });
}

async function resolveQuerySelection(
  request: ContentListActionRequest,
  collection: ContentListActionCollection,
  scope: ContentQueryScope | undefined,
  maxSelectionSize: number,
  representativeLimit: number,
  revision: number,
): Promise<ResolvedContentSelection> {
  const schema = await buildContentQuerySchema();
  const selection = request.selection;
  const rows: Array<Record<string, unknown>> = [];
  let queryFingerprint: string;

  if (selection.scope === 'explicit-ids') {
    const ids = [...new Set(selection.rowIds.map((rowId) => String(rowId)))];
    if (ids.length > maxSelectionSize)
      throw new ContentListActionError('limit_exceeded');
    queryFingerprint = `explicit:${revisionFingerprint(ids.map((id) => ({ id })))}`;
    for (let start = 0; start < ids.length; start += 100) {
      const chunk = ids.slice(start, start + 100);
      const query: DataQueryRequest = {
        version: 1,
        requestId: `content-action-explicit-${start}`,
        mode: 'rows',
        projection: [...REQUIRED_QUERY_FIELDS],
        filter: {
          kind: 'condition',
          field: 'id',
          operator: 'in',
          value: chunk,
        },
        sort: [{ field: 'id', direction: 'asc' }],
        page: { kind: 'offset', offset: 0, limit: Math.max(1, chunk.length) },
      };
      const result = await executeContentQuery(collection, query, { scope });
      rows.push(...result.rows);
    }
    queryFingerprint = `${queryFingerprint}:${revisionFingerprint(rows)}`;
  } else {
    const input = request.target.query;
    if (!input) throw new ContentListActionError('invalid_target');
    const normalized = normalizeDataQueryRequest(input, schema);
    if (normalized.mode !== 'rows')
      throw new ContentListActionError('invalid_target');
    for (const field of REQUIRED_QUERY_FIELDS) {
      if (!normalized.projection?.includes(field))
        throw new ContentListActionError('missing_action_projection');
    }
    const baseFingerprint = createDataQueryFingerprint(normalized, schema);
    if (
      selection.scope === 'all-matching' &&
      selection.queryFingerprint !== baseFingerprint
    ) {
      throw new ContentListActionError('stale_query_fingerprint');
    }
    const pageLimit =
      selection.scope === 'current-page'
        ? (normalized.page?.limit ?? CONTENT_QUERY_MAX_PAGE_LIMIT)
        : CONTENT_QUERY_MAX_PAGE_LIMIT;
    let offset =
      selection.scope === 'current-page' && normalized.page?.kind === 'offset'
        ? normalized.page.offset
        : 0;
    let authoritativeTotal: number | undefined;
    do {
      const pageRequest: DataQueryRequest = {
        ...normalized,
        requestId: `${normalized.requestId}-action-${offset}`.slice(0, 128),
        page: { kind: 'offset', offset, limit: pageLimit },
      };
      const result = await executeContentQuery(collection, pageRequest, {
        scope,
      });
      if (result.total.kind !== 'exact')
        throw new ContentListActionError('count_unavailable');
      if (authoritativeTotal === undefined)
        authoritativeTotal = result.total.value;
      if (result.total.value !== authoritativeTotal)
        throw new ContentListActionError('matching_count_drifted');
      rows.push(...result.rows);
      if (selection.scope === 'current-page' || !result.page?.hasMore) break;
      offset += pageLimit;
      if (rows.length > maxSelectionSize) break;
    } while (rows.length <= maxSelectionSize);
    if (
      selection.scope === 'all-matching' &&
      rows.length !== authoritativeTotal
    ) {
      if (rows.length <= maxSelectionSize)
        throw new ContentListActionError('matching_count_drifted');
    }
    queryFingerprint = `${baseFingerprint}:${revisionFingerprint(rows)}`;
  }

  if (request.target.expectedCount !== rows.length) {
    throw new ContentListActionError('matching_count_drifted');
  }
  return {
    revision,
    queryFingerprint,
    rowIds: rows.map((row) => row.id as DataSurfaceRowId),
    rows,
    representativeLabels: representativeLabels(rows, representativeLimit),
    scope: selection.scope,
  };
}

function defaultDescriptor(maxSelectionSize: number): DataSurfaceDescriptor {
  return {
    version: 1,
    identity: { surfaceId: 'content-list', kind: 'table' },
    schemaVersion: 2,
    label: 'Contents',
    rowKey: 'id',
    columns: [
      {
        id: 'id',
        label: 'Content id',
        fieldName: 'id',
        role: 'row-key',
        capabilities: ['read', 'project'],
      },
      {
        id: 'title',
        label: 'Title',
        fieldName: 'title',
        capabilities: ['read', 'project'],
      },
      {
        id: 'status',
        label: 'Status',
        fieldName: 'status',
        role: 'status',
        capabilities: ['read', 'project'],
      },
    ],
    query: {
      modes: ['rows', 'count'],
      projectableColumnIds: ['id', 'title', 'status'],
    },
    controls: [],
    actions: CONTENT_LIST_WORKFLOWS.map((entry) => ({
      id: entry.id,
      label: entry.label,
      description: entry.description,
      sensitivity: entry.sensitivity,
      selectionScopes: [...entry.selectionScopes],
      requiresConfirmation: entry.confirmation === 'required',
    })),
    limits: {
      maxQueryRows: CONTENT_QUERY_MAX_PAGE_LIMIT,
      maxQueryBytes: 1_000_000,
      maxSelectionSize,
    },
  };
}

export interface ContentListActionAdapter extends DataSurfaceActionAdapter {
  preview(
    request: ContentListActionRequest,
    context: DataSurfaceServerActionContext,
  ): Promise<DataSurfaceActionResult>;
  apply(
    request: ContentListActionRequest,
    context: DataSurfaceServerActionContext,
  ): Promise<DataSurfaceActionResult>;
}

export function createContentListActionAdapter(
  options: ContentListActionAdapterOptions,
): ContentListActionAdapter {
  const handlers = options.handlers ?? {};
  const maxSelectionSize =
    options.maxSelectionSize ?? DEFAULT_MAX_SELECTION_SIZE;
  const representativeLimit =
    options.representativeLimit ?? DEFAULT_REPRESENTATIVE_LIMIT;
  const descriptor = options.descriptor ?? defaultDescriptor(maxSelectionSize);
  const resolvedByRequest = new WeakMap<object, ResolvedContentSelection>();
  async function loadContent(
    invocation: { run: PrincipalRun; request: DataSurfaceServerActionRequest },
    rowId: DataSurfaceRowId,
  ): Promise<Content | null> {
    const key = String(rowId);
    const collection = await options.collection(invocation.run);
    const content = await collection.get({ id: key });
    if (!content) return null;
    const resolved = resolvedByRequest.get(invocation.request);
    const expected = resolved?.rows.find((row) => String(row.id) === key);
    const revisionValue = (value: unknown) =>
      value instanceof Date ? value.toISOString() : String(value ?? '');
    if (
      !expected ||
      revisionValue(content.updated_at) !== revisionValue(expected.updated_at)
    ) {
      throw new ContentListActionError('row_revision_drifted');
    }
    return content;
  }

  const mapActionError = (error: unknown) =>
    error instanceof ContentListActionError
      ? error.reason
      : isPermissionDenied(error) ||
          error instanceof PrincipalToolNotAllowedError
        ? 'denied'
        : 'execution_failed';

  const definitions = Object.fromEntries(
    CONTENT_LIST_WORKFLOWS.map(
      (entry): [string, DataSurfaceServerActionDefinition] => [
        entry.id,
        {
          descriptor: {
            id: entry.id,
            label: entry.label,
            description: entry.description,
            sensitivity: entry.sensitivity,
            selectionScopes: [...entry.selectionScopes],
            requiresConfirmation: entry.confirmation === 'required',
          },
          inputSchema: entry.inputSchema,
          validatePayload: (payload) =>
            validPayload(entry.id, payload)
              ? { valid: true }
              : { valid: false, reason: 'invalid_payload' },
          confirmation: entry.confirmation,
          execution: entry.execution,
          tool: entry.permissionRequirements.tool,
          operation:
            entry.permissionRequirements.operations[0] ??
            CONTENT_READ_OPERATION,
          authorize: async (invocation) => {
            const operations =
              entry.id === 'restore' &&
              payloadRecord(invocation.request.payload).status !== 'published'
                ? entry.permissionRequirements.operations.slice(0, 2)
                : entry.permissionRequirements.operations;
            for (const operation of operations.slice(1)) {
              try {
                await invocation.run.assertOperation(
                  operation.collection,
                  operation.action,
                );
              } catch (error) {
                if (isPermissionDenied(error)) return false;
                throw error;
              }
            }
            return options.authorize?.(entry.id, invocation.run) ?? true;
          },
          eligible: async (invocation, rowId) => {
            const content = await loadContent(invocation, rowId);
            if (!content)
              return { eligible: false, reason: 'not_found_or_denied' };
            return eligibility(
              entry.id,
              content,
              invocation.request.payload,
              handlers,
            );
          },
          apply: async (invocation, rowId) => {
            const content = await loadContent(invocation, rowId);
            if (!content) throw new Error('content not found');
            await applyWorkflow(
              entry.id,
              content,
              invocation.request.payload,
              invocation.run,
              handlers,
            );
            return null;
          },
        },
      ],
    ),
  );

  const generic = createDataSurfaceActionAdapter({
    state: options.state,
    backgroundQueue: options.backgroundQueue,
    tokenTtlMs: options.tokenTtlMs,
    runAsPrincipal: options.runAsPrincipal,
    requestFingerprintExtension: (request) =>
      (request as ContentListActionRequest)
        .target as unknown as DataSurfaceJsonValue,
    mapError: mapActionError,
    resolveSurface: async (run) => ({
      descriptor,
      revision: await (options.revision?.(run, descriptor.identity) ?? 0),
      actions: definitions,
    }),
    resolveSelection: async (invocation, selection) => {
      const request = invocation.request as ContentListActionRequest;
      const collection = await options.collection(invocation.run);
      const scope = await options.scope?.(invocation.run);
      const revision = await (options.revision?.(
        invocation.run,
        descriptor.identity,
      ) ?? 0);
      const resolved = await resolveQuerySelection(
        { ...request, selection },
        collection,
        scope,
        maxSelectionSize,
        representativeLimit,
        revision,
      );
      resolvedByRequest.set(request, resolved);
      return resolved;
    },
  });

  async function invoke(
    phase: 'preview' | 'apply',
    request: ContentListActionRequest,
    context: DataSurfaceServerActionContext,
  ): Promise<DataSurfaceActionResult> {
    const invalid = validateTarget(request);
    if (invalid) return actionResult(request, false, invalid);
    try {
      const result = await generic[phase](request, context);
      if (phase !== 'preview' || !result.ok) return result;
      const resolved = resolvedByRequest.get(request);
      const workflow = CONTENT_LIST_WORKFLOWS.find(
        (entry) => entry.id === request.actionId,
      );
      return {
        ...result,
        details: {
          ...(result.details ?? {}),
          resolvedScope: resolved?.scope ?? request.selection.scope,
          representativeLabels: resolved?.representativeLabels ?? [],
          ineligible: Array.isArray(result.details?.outcomes)
            ? result.details.outcomes.filter(
                (entry) => isRecord(entry) && entry.status === 'skipped',
              )
            : [],
          consequences: workflow?.consequences ?? [],
          sensitivity: workflow?.sensitivity ?? 'public',
          execution: workflow?.execution ?? 'foreground',
        },
      };
    } catch (error) {
      return actionResult(request, false, mapActionError(error));
    } finally {
      resolvedByRequest.delete(request);
    }
  }

  return {
    preview: (request, context) => invoke('preview', request, context),
    apply: (request, context) => invoke('apply', request, context),
  };
}
