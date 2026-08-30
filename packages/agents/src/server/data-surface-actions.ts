/**
 * Principal-bound preview/apply orchestration for data-surface actions.
 *
 * Browser state is treated only as an input hint. Every preview and apply is
 * executed under the bound principal, resolves the surface and selection
 * afresh, and delegates durable work only after authorization and eligibility
 * checks have passed.
 */
import { createHash, randomBytes } from 'node:crypto';
import type {
  DataSurfaceActionDescriptor,
  DataSurfaceActionRequest,
  DataSurfaceActionResult,
  DataSurfaceDescriptor,
  DataSurfaceIdentity,
  DataSurfaceJsonObject,
  DataSurfaceJsonValue,
  DataSurfaceRowId,
  DataSurfaceSelectionReference,
} from '@happyvertical/smrt-ui/data';
import {
  type ExecuteAsPrincipalOptions,
  executeAsPrincipal,
  type PrincipalRun,
} from '../execute-as-principal.js';

export type DataSurfaceConfirmationPolicy = 'required' | 'none';
export type DataSurfaceActionExecution = 'foreground' | 'background';

export interface DataSurfaceActionEligibility {
  eligible: boolean;
  reason?: string;
}

export type DataSurfaceActionPayloadValidation =
  | { valid: true }
  | { valid: false; reason?: string };

export interface DataSurfaceActionRowOutcome {
  rowId: DataSurfaceRowId;
  status: 'accepted' | 'skipped' | 'failed';
  reason?: string;
}

export interface ResolvedDataSurfaceSelection {
  /** Fresh server-side revision of the selected surface/query. */
  revision: number;
  /** Canonical fingerprint of the frozen query represented by the selection. */
  queryFingerprint: string;
  /** Authoritatively resolved row ids. Browser-provided ids are only hints. */
  rowIds: DataSurfaceRowId[];
}

export interface DataSurfaceActionInvocation {
  run: PrincipalRun;
  request: DataSurfaceServerActionRequest;
  descriptor: DataSurfaceDescriptor;
  action: DataSurfaceServerActionDefinition;
  selection: ResolvedDataSurfaceSelection;
}

export interface DataSurfaceServerActionDefinition {
  descriptor: DataSurfaceActionDescriptor;
  /** Serializable declaration for transport/schema generators; null means no input. */
  inputSchema: DataSurfaceJsonObject | null;
  /** Runtime enforcement for the declared schema; absence is never permissive. */
  validatePayload(
    payload: DataSurfaceJsonValue | undefined,
  ):
    | DataSurfaceActionPayloadValidation
    | Promise<DataSurfaceActionPayloadValidation>;
  /** Explicit for every action, including sensitive/public/destructive ones. */
  confirmation: DataSurfaceConfirmationPolicy;
  execution: DataSurfaceActionExecution;
  /** Fail-closed persona capability checked by PrincipalRun. */
  tool: string;
  /** Explicit RBAC catalog gate, enforced independently of callback convention. */
  operation: {
    id: string;
    collection: Parameters<PrincipalRun['assertOperation']>[0];
    action: string;
  };
  /** Fresh permission/domain authorization check, run for preview and apply. */
  authorize(
    invocation: DataSurfaceActionInvocation,
  ): boolean | Promise<boolean>;
  /** Fresh per-row domain precondition check, repeated at apply time. */
  eligible(
    invocation: DataSurfaceActionInvocation,
    rowId: DataSurfaceRowId,
  ): DataSurfaceActionEligibility | Promise<DataSurfaceActionEligibility>;
  /** Foreground mutation. Background definitions are run by the injected queue. */
  apply(
    invocation: DataSurfaceActionInvocation,
    rowId: DataSurfaceRowId,
  ):
    | undefined
    | DataSurfaceJsonValue
    | Promise<undefined | DataSurfaceJsonValue>;
}

export interface ResolvedDataSurfaceActions {
  descriptor: DataSurfaceDescriptor;
  /** Current server-side revision, never trusted from the browser. */
  revision: number;
  actions: Record<string, DataSurfaceServerActionDefinition>;
}

export interface DataSurfaceServerActionRequest
  extends DataSurfaceActionRequest {
  /** Required on apply and bound into the preview token. */
  expectedRevision: number;
  /** Required on apply. Identical retries replay the first terminal result. */
  idempotencyKey?: string;
}

export interface DataSurfaceActionContext {
  principal: ExecuteAsPrincipalOptions;
}

export interface DataSurfaceBackgroundActionJob {
  idempotencyKey: string;
  identity: DataSurfaceIdentity;
  actionId: string;
  rowIds: DataSurfaceRowId[];
  /**
   * The queue must call this task to perform the work. It re-enters the bound
   * principal and repeats descriptor, authorization, selection, and eligibility
   * checks before any mutation.
   */
  run: () => Promise<DataSurfaceActionResult>;
}

export interface DataSurfaceBackgroundQueue {
  enqueue(
    job: DataSurfaceBackgroundActionJob,
  ): Promise<{ jobId: string; details?: DataSurfaceJsonObject }>;
}

export interface DataSurfacePreviewTokenRecord {
  expiresAt: number;
  actorUserId: string;
  tenantId: string | null;
  onBehalfOfUserId: string | null;
  actsAsProfileId: string | null;
  identityKey: string;
  actionId: string;
  actionFingerprint: string;
  revision: number;
  queryFingerprint: string;
  selectionFingerprint: string;
  resolvedRowsFingerprint: string;
  requestFingerprint: string;
  consumedBy?: string;
}

export type DataSurfaceIdempotencyRecord =
  | {
      status: 'reserved';
      requestFingerprint: string;
      ownerToken: string;
      reservedAt: number;
    }
  | {
      status: 'completed';
      requestFingerprint: string;
      result: DataSurfaceActionResult;
    };

export interface DataSurfaceIdempotencyReservation {
  requestFingerprint: string;
  ownerToken: string;
  reservedAt: number;
}

export interface DataSurfaceActionStateStore {
  putToken(
    token: string,
    record: DataSurfacePreviewTokenRecord,
  ): Promise<void> | void;
  getToken(
    token: string,
  ):
    | Promise<DataSurfacePreviewTokenRecord | undefined>
    | DataSurfacePreviewTokenRecord
    | undefined;
  markTokenConsumed(
    token: string,
    idempotencyKey: string,
  ): Promise<boolean> | boolean;
  getIdempotency(
    key: string,
  ):
    | Promise<DataSurfaceIdempotencyRecord | undefined>
    | DataSurfaceIdempotencyRecord
    | undefined;
  /** Atomically create a durable reservation or return the existing record. */
  reserveIdempotency(
    key: string,
    reservation: DataSurfaceIdempotencyReservation,
  ): Promise<DataSurfaceIdempotencyRecord> | DataSurfaceIdempotencyRecord;
  completeIdempotency(
    key: string,
    ownerToken: string,
    result: DataSurfaceActionResult,
  ): Promise<boolean> | boolean;
  releaseIdempotency(
    key: string,
    ownerToken: string,
  ): Promise<boolean> | boolean;
}

/** Explicit single-process/testing store; production callers inject shared state. */
export class InMemoryDataSurfaceActionStateStore
  implements DataSurfaceActionStateStore
{
  private readonly tokens = new Map<string, DataSurfacePreviewTokenRecord>();
  private readonly idempotency = new Map<
    string,
    DataSurfaceIdempotencyRecord
  >();

  putToken(token: string, record: DataSurfacePreviewTokenRecord): void {
    this.tokens.set(token, record);
  }

  getToken(token: string): DataSurfacePreviewTokenRecord | undefined {
    return this.tokens.get(token);
  }

  markTokenConsumed(token: string, idempotencyKey: string): boolean {
    const record = this.tokens.get(token);
    if (!record) return false;
    if (record.consumedBy && record.consumedBy !== idempotencyKey) return false;
    record.consumedBy = idempotencyKey;
    return true;
  }

  getIdempotency(key: string): DataSurfaceIdempotencyRecord | undefined {
    return this.idempotency.get(key);
  }

  reserveIdempotency(
    key: string,
    reservation: DataSurfaceIdempotencyReservation,
  ): DataSurfaceIdempotencyRecord {
    const existing = this.idempotency.get(key);
    if (existing) return existing;
    const record: DataSurfaceIdempotencyRecord = {
      status: 'reserved',
      ...reservation,
    };
    this.idempotency.set(key, record);
    return record;
  }

  completeIdempotency(
    key: string,
    ownerToken: string,
    result: DataSurfaceActionResult,
  ): boolean {
    const existing = this.idempotency.get(key);
    if (existing?.status !== 'reserved' || existing.ownerToken !== ownerToken)
      return false;
    this.idempotency.set(key, {
      status: 'completed',
      requestFingerprint: existing.requestFingerprint,
      result,
    });
    return true;
  }

  releaseIdempotency(key: string, ownerToken: string): boolean {
    const existing = this.idempotency.get(key);
    if (existing?.status !== 'reserved' || existing.ownerToken !== ownerToken)
      return false;
    return this.idempotency.delete(key);
  }
}

export interface DataSurfaceActionAdapterOptions {
  resolveSurface(
    run: PrincipalRun,
    identity: DataSurfaceIdentity,
  ): Promise<ResolvedDataSurfaceActions>;
  resolveSelection(
    invocation: Omit<DataSurfaceActionInvocation, 'selection'>,
    selection: DataSurfaceSelectionReference,
  ): Promise<ResolvedDataSurfaceSelection>;
  backgroundQueue?: DataSurfaceBackgroundQueue;
  /** Required durable, shared backend in production; memory storage is opt-in. */
  state: DataSurfaceActionStateStore;
  tokenTtlMs?: number;
  now?: () => number;
  createToken?: () => string;
  runAsPrincipal?: typeof executeAsPrincipal;
  /**
   * Re-resolve the complete current binding immediately before deferred work.
   * Background execution fails closed when this seam is absent or returns a
   * binding for a different principal.
   */
  resolveDeferredPrincipal?(
    reference: Readonly<{
      runAsUserId: string;
      tenantId: string | null;
      actsAsProfileId: string | null;
      onBehalfOfUserId: string | null;
      agentClass?: string;
    }>,
  ): ExecuteAsPrincipalOptions | Promise<ExecuteAsPrincipalOptions>;
  idempotencyPollIntervalMs?: number;
  idempotencyWaitTimeoutMs?: number;
  /** Domain-specific request input that must participate in confirmation/idempotency. */
  requestFingerprintExtension?(
    request: DataSurfaceServerActionRequest,
  ): DataSurfaceJsonValue | undefined;
  /** Maps terminal domain failures; return undefined to preserve queue retries. */
  mapError?(
    error: unknown,
    request: DataSurfaceServerActionRequest,
  ): string | undefined;
}

export interface DataSurfaceActionAdapter {
  preview(
    request: DataSurfaceServerActionRequest,
    context: DataSurfaceActionContext,
  ): Promise<DataSurfaceActionResult>;
  apply(
    request: DataSurfaceServerActionRequest,
    context: DataSurfaceActionContext,
  ): Promise<DataSurfaceActionResult>;
}

const DEFAULT_TOKEN_TTL_MS = 5 * 60 * 1_000;
const MAX_IDENTIFIER_LENGTH = 256;
const MAX_JSON_DEPTH = 16;
const MAX_JSON_ITEMS = 1_000;
const FORBIDDEN_JSON_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isBoundedJsonValue(
  value: unknown,
  depth = 0,
  seen = new Set<object>(),
): value is DataSurfaceJsonValue {
  if (value === null) return true;
  if (['string', 'boolean'].includes(typeof value)) return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || depth >= MAX_JSON_DEPTH || seen.has(value))
    return false;
  seen.add(value);
  if (Array.isArray(value)) {
    if (value.length > MAX_JSON_ITEMS) return false;
    return value.every((item) => isBoundedJsonValue(item, depth + 1, seen));
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const entries = Object.entries(value);
  if (entries.length > MAX_JSON_ITEMS) return false;
  return entries.every(
    ([key, item]) =>
      !FORBIDDEN_JSON_KEYS.has(key) &&
      isBoundedJsonValue(item, depth + 1, seen),
  );
}

/** Validates untrusted extension values before they enter canonical hashing. */
export function isBoundedDataSurfaceJsonValue(
  value: unknown,
): value is DataSurfaceJsonValue {
  return isBoundedJsonValue(value);
}

function validIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_IDENTIFIER_LENGTH
  );
}

function validSelection(
  selection: unknown,
): selection is DataSurfaceSelectionReference {
  if (!selection || typeof selection !== 'object') return false;
  const candidate = selection as Record<string, unknown>;
  if (candidate.scope === 'current-page') return true;
  if (candidate.scope === 'all-matching')
    return validIdentifier(candidate.queryFingerprint);
  if (candidate.scope !== 'explicit-ids' || !Array.isArray(candidate.rowIds))
    return false;
  if (candidate.rowIds.length > MAX_JSON_ITEMS) return false;
  return candidate.rowIds.every(
    (rowId) =>
      (typeof rowId === 'string' && rowId.length > 0) ||
      (typeof rowId === 'number' && Number.isFinite(rowId)),
  );
}

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
    .join(',')}}`;
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(stable(value)).digest('hex');
}

function identityKey(identity: DataSurfaceIdentity): string {
  return stable(canonicalIdentity(identity));
}

function canonicalIdentity(identity: DataSurfaceIdentity): DataSurfaceIdentity {
  return {
    kind: identity.kind,
    surfaceId: identity.surfaceId,
    ...(identity.subject
      ? {
          subject: {
            type: identity.subject.type,
            id: identity.subject.id,
          },
        }
      : {}),
  };
}

function rowIdKey(rowId: DataSurfaceRowId): string {
  return `${typeof rowId}:${String(rowId)}`;
}

function compareRowIds(
  left: DataSurfaceRowId,
  right: DataSurfaceRowId,
): number {
  if (typeof left !== typeof right) return typeof left === 'number' ? -1 : 1;
  if (typeof left === 'number' && typeof right === 'number')
    return left - right;
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalRowIds(
  rowIds: readonly DataSurfaceRowId[],
): DataSurfaceRowId[] {
  const ids = new Map<string, DataSurfaceRowId>();
  for (const rowId of rowIds) ids.set(rowIdKey(rowId), rowId);
  return [...ids.values()].sort(compareRowIds);
}

function canonicalSelection(
  selection: DataSurfaceSelectionReference,
): DataSurfaceSelectionReference {
  if (selection.scope !== 'explicit-ids') return selection;
  return { scope: selection.scope, rowIds: canonicalRowIds(selection.rowIds) };
}

function requestFingerprint(
  request: DataSurfaceServerActionRequest,
  extension?: DataSurfaceJsonValue,
): string {
  return fingerprint({
    identity: canonicalIdentity(request.identity),
    actionId: request.actionId,
    selection: canonicalSelection(request.selection),
    payload: request.payload,
    expectedRevision: request.expectedRevision,
    ...(extension === undefined ? {} : { extension }),
  });
}

function actionFingerprint(action: DataSurfaceServerActionDefinition): string {
  return fingerprint({
    descriptor: action.descriptor,
    inputSchema: action.inputSchema,
    confirmation: action.confirmation,
    execution: action.execution,
    tool: action.tool,
    operationId: action.operation.id,
    operationCollection: action.operation.collection,
    operationAction: action.operation.action,
  });
}

function result(
  request: DataSurfaceServerActionRequest,
  ok: boolean,
  reason?: string,
  details?: DataSurfaceJsonObject,
  confirmationToken?: string,
): DataSurfaceActionResult {
  return {
    version: 1,
    requestId: request.requestId,
    identity: request.identity,
    actionId: request.actionId,
    phase: request.phase,
    ok,
    ...(reason ? { reason } : {}),
    ...(details ? { details } : {}),
    ...(confirmationToken ? { confirmationToken } : {}),
  };
}

function replayResult(
  request: DataSurfaceServerActionRequest,
  stored: DataSurfaceActionResult,
): DataSurfaceActionResult {
  // Idempotency keys identify one logical execution, but each transport retry
  // has its own correlation id. Preserve the stored outcome while binding the
  // replay envelope to the request that is receiving it.
  return { ...stored, requestId: request.requestId };
}

function outcomesDetails(
  outcomes: DataSurfaceActionRowOutcome[],
  extra: DataSurfaceJsonObject = {},
): DataSurfaceJsonObject {
  const accepted = outcomes.filter(
    ({ status }) => status === 'accepted',
  ).length;
  const skipped = outcomes.filter(({ status }) => status === 'skipped').length;
  const failed = outcomes.filter(({ status }) => status === 'failed').length;
  return {
    accepted,
    skipped,
    failed,
    outcomes: outcomes.map(({ rowId, status, reason }) => ({
      rowId,
      status,
      ...(reason ? { reason } : {}),
    })),
    ...extra,
  };
}

function validateRequest(
  request: DataSurfaceServerActionRequest,
  phase: 'preview' | 'apply',
): string | undefined {
  if (!request || typeof request !== 'object') return 'invalid_request';
  if (request.version !== 1 || request.phase !== phase)
    return 'invalid_request';
  if (
    !validIdentifier(request.requestId) ||
    !validIdentifier(request.actionId) ||
    !validIdentifier(request.identity?.surfaceId) ||
    !['table', 'list', 'report', 'custom'].includes(request.identity?.kind) ||
    !validSelection(request.selection) ||
    (request.payload !== undefined && !isBoundedJsonValue(request.payload))
  )
    return 'invalid_request';
  if (
    !Number.isSafeInteger(request.expectedRevision) ||
    request.expectedRevision < 0
  )
    return 'invalid_request';
  if (
    phase === 'apply' &&
    (!validIdentifier(request.idempotencyKey) ||
      (request.confirmationToken !== undefined &&
        !validIdentifier(request.confirmationToken)))
  )
    return 'invalid_request';
  return undefined;
}

/** Create a transport-neutral, principal-bound data-surface action adapter. */
export function createDataSurfaceActionAdapter(
  options: DataSurfaceActionAdapterOptions,
): DataSurfaceActionAdapter {
  const state = options.state;
  const now = options.now ?? Date.now;
  const createToken =
    options.createToken ?? (() => randomBytes(32).toString('base64url'));
  const tokenTtlMs = options.tokenTtlMs ?? DEFAULT_TOKEN_TTL_MS;
  const runAsPrincipal = options.runAsPrincipal ?? executeAsPrincipal;
  const idempotencyPollIntervalMs = Math.max(
    1,
    options.idempotencyPollIntervalMs ?? 10,
  );
  const idempotencyWaitTimeoutMs = Math.max(
    0,
    options.idempotencyWaitTimeoutMs ?? 5_000,
  );
  const fingerprintRequest = (request: DataSurfaceServerActionRequest) =>
    requestFingerprint(request, options.requestFingerprintExtension?.(request));

  async function resolveInvocation(
    request: DataSurfaceServerActionRequest,
    run: PrincipalRun,
  ): Promise<DataSurfaceActionInvocation | DataSurfaceActionResult> {
    const surface = await options.resolveSurface(run, request.identity);
    if (
      identityKey(surface.descriptor.identity) !== identityKey(request.identity)
    ) {
      return result(request, false, 'not_found');
    }
    const action = surface.actions[request.actionId];
    const declared = surface.descriptor.actions.find(
      ({ id }) => id === request.actionId,
    );
    if (
      !action ||
      !declared ||
      action.descriptor.id !== declared.id ||
      Boolean(declared.requiresConfirmation) !==
        (action.confirmation === 'required')
    ) {
      return result(request, false, 'unsupported');
    }
    if (
      !action.tool ||
      !validIdentifier(action.operation?.id) ||
      !validIdentifier(action.operation?.action)
    )
      return result(request, false, 'denied');
    run.assertToolAllowed(action.tool);
    await run.assertOperation(
      action.operation.collection,
      action.operation.action,
    );
    const payloadValidation = await action.validatePayload(request.payload);
    if (!payloadValidation.valid)
      return result(
        request,
        false,
        payloadValidation.reason ?? 'invalid_payload',
      );
    if (
      !declared.selectionScopes.includes(request.selection.scope) ||
      !action.descriptor.selectionScopes.includes(request.selection.scope)
    ) {
      return result(request, false, 'selection_not_supported');
    }
    const base = {
      run,
      request,
      descriptor: surface.descriptor,
      action,
    };
    const resolvedSelection = await options.resolveSelection(
      base,
      canonicalSelection(request.selection),
    );
    const selection = {
      ...resolvedSelection,
      rowIds: canonicalRowIds(resolvedSelection.rowIds),
    };
    const invocation = { ...base, selection };
    if (!(await action.authorize(invocation))) {
      return result(request, false, 'denied');
    }
    if (selection.rowIds.length > surface.descriptor.limits.maxSelectionSize) {
      return result(request, false, 'limit_exceeded');
    }
    return invocation;
  }

  async function preview(
    request: DataSurfaceServerActionRequest,
    context: DataSurfaceActionContext,
  ): Promise<DataSurfaceActionResult> {
    const invalid = validateRequest(request, 'preview');
    if (invalid) return result(request, false, invalid);
    return runAsPrincipal(
      {
        ...context.principal,
        action: 'data_surface.action.preview',
        auditMetadata: {
          ...context.principal.auditMetadata,
          surfaceId: request.identity.surfaceId,
          actionId: request.actionId,
          requestId: request.requestId,
        },
      },
      async (run) => {
        const invocation = await resolveInvocation(request, run);
        if ('ok' in invocation) return invocation;
        if (invocation.selection.revision !== request.expectedRevision) {
          return result(request, false, 'stale_revision');
        }
        const outcomes: DataSurfaceActionRowOutcome[] = [];
        for (const rowId of invocation.selection.rowIds) {
          const eligibility = await invocation.action.eligible(
            invocation,
            rowId,
          );
          outcomes.push({
            rowId,
            status: eligibility.eligible ? 'accepted' : 'skipped',
            ...(eligibility.reason ? { reason: eligibility.reason } : {}),
          });
        }
        const confirmationToken = createToken();
        const selectionFingerprint = fingerprint(
          canonicalSelection(request.selection),
        );
        const requestFingerprintValue = fingerprintRequest(request);
        const expiresAt = now() + tokenTtlMs;
        await state.putToken(confirmationToken, {
          expiresAt,
          actorUserId: context.principal.principal.runAsUserId,
          tenantId: context.principal.principal.tenantId,
          onBehalfOfUserId: context.principal.onBehalfOfUserId ?? null,
          actsAsProfileId: context.principal.principal.actsAsProfileId ?? null,
          identityKey: identityKey(request.identity),
          actionId: request.actionId,
          actionFingerprint: actionFingerprint(invocation.action),
          revision: invocation.selection.revision,
          queryFingerprint: invocation.selection.queryFingerprint,
          selectionFingerprint,
          resolvedRowsFingerprint: fingerprint(
            canonicalRowIds(invocation.selection.rowIds),
          ),
          requestFingerprint: requestFingerprintValue,
        });
        return result(
          request,
          true,
          undefined,
          outcomesDetails(outcomes, {
            count: invocation.selection.rowIds.length,
            revision: invocation.selection.revision,
            queryFingerprint: invocation.selection.queryFingerprint,
            expiresAt,
          }),
          confirmationToken,
        );
      },
    );
  }

  async function executeForeground(
    request: DataSurfaceServerActionRequest,
    invocation: DataSurfaceActionInvocation,
  ): Promise<DataSurfaceActionResult> {
    const outcomes: DataSurfaceActionRowOutcome[] = [];
    for (const rowId of invocation.selection.rowIds) {
      try {
        const eligibility = await invocation.action.eligible(invocation, rowId);
        if (!eligibility.eligible) {
          outcomes.push({
            rowId,
            status: 'skipped',
            ...(eligibility.reason ? { reason: eligibility.reason } : {}),
          });
          continue;
        }
        await invocation.action.apply(invocation, rowId);
        outcomes.push({ rowId, status: 'accepted' });
      } catch (error) {
        outcomes.push({
          rowId,
          status: 'failed',
          reason: options.mapError?.(error, request) ?? 'execution_failed',
        });
      }
    }
    return result(request, true, undefined, outcomesDetails(outcomes));
  }

  async function executeBackgroundOnce(
    request: DataSurfaceServerActionRequest,
    context: DataSurfaceActionContext,
    token: DataSurfacePreviewTokenRecord | undefined,
    reference: Readonly<{
      runAsUserId: string;
      tenantId: string | null;
      actsAsProfileId: string | null;
      onBehalfOfUserId: string | null;
      agentClass?: string;
    }>,
  ): Promise<DataSurfaceActionResult> {
    const ownerToken = randomBytes(16).toString('base64url');
    const executionFingerprint = fingerprint({
      kind: 'background-execution',
      request: token?.requestFingerprint ?? fingerprintRequest(request),
      action: token?.actionFingerprint ?? request.actionId,
    });
    const executionScope = fingerprint({
      kind: 'background-execution',
      actorUserId: reference.runAsUserId,
      tenantId: reference.tenantId,
      onBehalfOfUserId: reference.onBehalfOfUserId,
      actsAsProfileId: reference.actsAsProfileId,
      identity: canonicalIdentity(request.identity),
      actionId: request.actionId,
      idempotencyKey: request.idempotencyKey,
    });
    const maxPolls = Math.max(
      1,
      Math.ceil(idempotencyWaitTimeoutMs / idempotencyPollIntervalMs),
    );
    for (let poll = 0; poll <= maxPolls; poll += 1) {
      const winner = await state.reserveIdempotency(executionScope, {
        requestFingerprint: executionFingerprint,
        ownerToken,
        reservedAt: now(),
      });
      if (winner.requestFingerprint !== executionFingerprint)
        return result(request, false, 'idempotency_conflict');
      if (winner.status === 'completed')
        return replayResult(request, winner.result);
      if (winner.ownerToken === ownerToken) {
        let executed: DataSurfaceActionResult;
        try {
          // A queued job may run long after the request that created it. The
          // complete persona binding (including the TenantAgent-capped tool
          // allow-list) must therefore be resolved again at execution time.
          const refreshed = await options.resolveDeferredPrincipal?.(reference);
          if (
            !refreshed ||
            refreshed.principal.runAsUserId !== reference.runAsUserId ||
            refreshed.principal.tenantId !== reference.tenantId ||
            (refreshed.principal.actsAsProfileId ?? null) !==
              reference.actsAsProfileId ||
            (refreshed.onBehalfOfUserId ?? null) !==
              reference.onBehalfOfUserId ||
            (refreshed.agentClass ?? null) !== (reference.agentClass ?? null) ||
            !Array.isArray(refreshed.principal.allowedTools)
          ) {
            throw new Error(
              'Deferred data-surface action principal binding could not be resolved safely',
            );
          }
          // Permission snapshots are never carried across the queue boundary;
          // executeAsPrincipal resolves current RBAC/membership immediately.
          const { permissions: _permissions, ...livePrincipal } = refreshed;
          executed = await authorizedApply(
            request,
            { ...context, principal: livePrincipal },
            token,
            false,
          );
        } catch (error) {
          const reason = options.mapError?.(error, request);
          if (!reason) {
            await state.releaseIdempotency(executionScope, ownerToken);
            throw error;
          }
          executed = result(request, false, reason);
        }
        if (
          !(await state.completeIdempotency(
            executionScope,
            ownerToken,
            executed,
          ))
        ) {
          throw new Error('Lost background action idempotency reservation');
        }
        return executed;
      }
      if (poll < maxPolls) {
        await new Promise<void>((resolve) =>
          setTimeout(resolve, idempotencyPollIntervalMs),
        );
        const current = await state.getIdempotency(executionScope);
        if (current?.status === 'completed')
          return replayResult(request, current.result);
      }
    }
    return result(request, false, 'idempotency_in_progress');
  }

  async function authorizedApply(
    request: DataSurfaceServerActionRequest,
    context: DataSurfaceActionContext,
    token: DataSurfacePreviewTokenRecord | undefined,
    allowBackground: boolean,
  ): Promise<DataSurfaceActionResult> {
    const idempotencyKey = request.idempotencyKey;
    if (!idempotencyKey) return result(request, false, 'invalid_request');
    // Capture the immutable binding before any asynchronous authorization.
    // The host may reuse or mutate its request context after enqueue returns.
    const deferredPrincipalReference = Object.freeze({
      runAsUserId: context.principal.principal.runAsUserId,
      tenantId: context.principal.principal.tenantId,
      actsAsProfileId: context.principal.principal.actsAsProfileId ?? null,
      onBehalfOfUserId: context.principal.onBehalfOfUserId ?? null,
      ...(context.principal.agentClass
        ? { agentClass: context.principal.agentClass }
        : {}),
    });
    return runAsPrincipal(
      {
        ...context.principal,
        action: 'data_surface.action.apply',
        auditMetadata: {
          ...context.principal.auditMetadata,
          surfaceId: request.identity.surfaceId,
          actionId: request.actionId,
          requestId: request.requestId,
          idempotencyKey: request.idempotencyKey,
        },
      },
      async (run) => {
        const invocation = await resolveInvocation(request, run);
        if ('ok' in invocation) return invocation;
        if (token) {
          if (
            invocation.selection.revision !== token.revision ||
            invocation.selection.revision !== request.expectedRevision ||
            invocation.selection.queryFingerprint !== token.queryFingerprint ||
            fingerprint(canonicalSelection(request.selection)) !==
              token.selectionFingerprint ||
            actionFingerprint(invocation.action) !== token.actionFingerprint ||
            fingerprint(canonicalRowIds(invocation.selection.rowIds)) !==
              token.resolvedRowsFingerprint
          ) {
            return result(request, false, 'stale_preview');
          }
        } else if (invocation.action.confirmation === 'required') {
          return result(request, false, 'confirmation_required');
        } else if (invocation.selection.revision !== request.expectedRevision) {
          return result(request, false, 'stale_revision');
        }
        if (invocation.action.execution === 'background' && allowBackground) {
          if (!options.backgroundQueue) {
            return result(request, false, 'background_unavailable');
          }
          const queued = await options.backgroundQueue.enqueue({
            idempotencyKey,
            identity: request.identity,
            actionId: request.actionId,
            rowIds: invocation.selection.rowIds,
            run: () =>
              executeBackgroundOnce(
                request,
                context,
                token,
                deferredPrincipalReference,
              ),
          });
          return result(request, true, undefined, {
            accepted: invocation.selection.rowIds.length,
            skipped: 0,
            failed: 0,
            ...(queued.details ?? {}),
            background: true,
            jobId: queued.jobId,
            // A replayed apply has a new transport request id, while the
            // already-queued job still returns the original execution result.
            // Preserve that correlation id across the replay envelope.
            jobRequestId: request.requestId,
          });
        }
        return executeForeground(request, invocation);
      },
    );
  }

  async function apply(
    request: DataSurfaceServerActionRequest,
    context: DataSurfaceActionContext,
  ): Promise<DataSurfaceActionResult> {
    const invalid = validateRequest(request, 'apply');
    if (invalid) return result(request, false, invalid);
    const confirmationToken = request.confirmationToken;
    const idempotencyKey = request.idempotencyKey;
    if (!idempotencyKey) return result(request, false, 'invalid_request');
    const actorUserId = context.principal.principal.runAsUserId;
    const tenantId = context.principal.principal.tenantId;
    const onBehalfOfUserId = context.principal.onBehalfOfUserId ?? null;
    const actsAsProfileId = context.principal.principal.actsAsProfileId ?? null;
    const requestFingerprintValue = fingerprintRequest(request);
    const idempotencyScope = fingerprint({
      actorUserId,
      tenantId,
      onBehalfOfUserId,
      actsAsProfileId,
      identity: canonicalIdentity(request.identity),
      actionId: request.actionId,
      idempotencyKey,
    });
    const prior = await state.getIdempotency(idempotencyScope);
    if (prior && prior.requestFingerprint !== requestFingerprintValue)
      return result(request, false, 'idempotency_conflict');
    // A completed durable result is safe to replay from its actor/tenant-bound
    // idempotency scope even when the one-time confirmation has expired.
    if (prior?.status === 'completed')
      return replayResult(request, prior.result);

    let token: DataSurfacePreviewTokenRecord | undefined;
    if (confirmationToken) {
      token = await state.getToken(confirmationToken);
      if (!token || token.expiresAt <= now()) {
        return result(request, false, 'invalid_or_expired_confirmation');
      }
      if (
        token.actorUserId !== actorUserId ||
        token.tenantId !== tenantId ||
        token.onBehalfOfUserId !== onBehalfOfUserId ||
        token.actsAsProfileId !== actsAsProfileId ||
        token.identityKey !== identityKey(request.identity) ||
        token.actionId !== request.actionId ||
        token.requestFingerprint !== requestFingerprintValue
      ) {
        return result(request, false, 'confirmation_mismatch');
      }
      if (!(await state.markTokenConsumed(confirmationToken, idempotencyKey))) {
        return result(request, false, 'confirmation_replayed');
      }
    }
    // Ownership is an internal compare-and-set nonce. Keep it independent of
    // the injectable preview-token factory, which tests or callers may make
    // deterministic without weakening concurrent winner selection.
    const ownerToken = randomBytes(16).toString('base64url');
    const maxPolls = Math.max(
      1,
      Math.ceil(idempotencyWaitTimeoutMs / idempotencyPollIntervalMs),
    );
    for (let poll = 0; poll <= maxPolls; poll += 1) {
      const winner = await state.reserveIdempotency(idempotencyScope, {
        requestFingerprint: requestFingerprintValue,
        ownerToken,
        reservedAt: now(),
      });
      if (winner.requestFingerprint !== requestFingerprintValue)
        return result(request, false, 'idempotency_conflict');
      if (winner.status === 'completed')
        return replayResult(request, winner.result);
      if (winner.ownerToken === ownerToken) {
        let applied: DataSurfaceActionResult;
        try {
          applied = await authorizedApply(request, context, token, true);
        } catch (error) {
          await state.releaseIdempotency(idempotencyScope, ownerToken);
          throw error;
        }
        // A confirmation-required request without a token is a recoverable
        // precondition failure. Do not consume its idempotency key: the caller
        // may preview and retry with the same key.
        if (!applied.ok && applied.reason === 'confirmation_required') {
          await state.releaseIdempotency(idempotencyScope, ownerToken);
          return applied;
        }
        // Once execution returns, never release on a persistence failure: a
        // durable reservation is safer than allowing duplicate side effects.
        if (
          !(await state.completeIdempotency(
            idempotencyScope,
            ownerToken,
            applied,
          ))
        ) {
          throw new Error('Lost data-surface idempotency reservation');
        }
        return applied;
      }
      if (poll < maxPolls) {
        await new Promise<void>((resolve) =>
          setTimeout(resolve, idempotencyPollIntervalMs),
        );
        const current = await state.getIdempotency(idempotencyScope);
        if (current?.status === 'completed')
          return replayResult(request, current.result);
      }
    }
    return result(request, false, 'idempotency_in_progress');
  }

  return { preview, apply };
}
