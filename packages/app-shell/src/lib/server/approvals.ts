// The approval gate. A risky builder command, app tool call or REST DELETE
// does not run: it becomes an `Approval` row for the owner. Only
// `decideApproval` (called from `Approval.decide`) ever passes the engine's
// `approved: true`; nothing taken from a request body can set it.

import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { OwnerApprovalError } from '@happyvertical/smrt-app-runtime';
import {
  ApprovalRequiredError,
  type Command,
  type Plan,
} from '../../engine/index.ts';
import { type Approval, ApprovalCollection } from '../objects/Approval.ts';
import { shellApprovalAuthority } from './approval-store.ts';
import { discardNow, publishApproved } from './drafts.ts';
import { publish } from './events.ts';
import { getHost, getShellDb } from './host.ts';
import { publicChangeResult } from './results.ts';

/** What an approval runs once the owner says yes. */
export type ApprovalAction =
  | {
      kind: 'command';
      command: Command;
      reviewedPreview?: Record<string, unknown>;
    }
  | { kind: 'tool'; name: string; args: Record<string, unknown> }
  | { kind: 'rest'; method: string; url: string; body?: string }
  | { kind: 'record-delete'; model: string; id: string }
  /** Publish the open draft; pinned to the digest of the preview the owner reviewed. */
  | {
      kind: 'publish-draft';
      draftId: string;
      draftName: string;
      digest: string;
    }
  /** Discard the open draft (a tool asked; the UI discards directly). */
  | { kind: 'discard-draft'; draftId: string; draftName: string };

/** The answer a refused-until-approved call gives instead of applying. */
export interface PendingApproval {
  status: 'pending_approval';
  approvalId: string;
  summary: string;
  preview: unknown;
}

// Out-of-band record of the approvals a call issued. `requestApproval` is the
// only writer, so a caller (the assistant's turn loop) can tell "this call
// became an Approval" from a tool result whose text merely looks like one.
const issuedScope = new AsyncLocalStorage<PendingApproval[]>();

/** Run `fn`, collecting every approval `requestApproval` issues inside it. */
export async function collectIssuedApprovals<T>(
  fn: () => Promise<T>,
): Promise<{ value: T; issued: PendingApproval[] }> {
  const issued: PendingApproval[] = [];
  const value = await issuedScope.run(issued, fn);
  return { value, issued };
}

export interface ApprovalView {
  id: string;
  status: Approval['status'];
  summary: string;
  preview: unknown;
  action: ApprovalAction | null;
  requestedBy: string;
  decidedBy: string;
  decidedAt: string;
  result: unknown;
  createdAt: string;
}

export interface ApprovalOutcome {
  id: string;
  status: Approval['status'];
  result?: unknown;
  error?: string;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function actionKey(action: ApprovalAction): string {
  return createHash('sha256').update(canonical(action)).digest('hex');
}

/** Read a legacy JSON column without breaking saved history on malformed text. */
export function parseJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The ORM may hydrate a timestamp-looking text column as a Date. */
function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value ?? '');
}

function view(row: Approval): ApprovalView {
  return {
    id: row.id as string,
    status:
      row.status === 'accepted' || row.status === 'executing'
        ? 'approved'
        : row.status,
    summary: row.summary,
    preview: parseJson(row.preview),
    action: parseJson(row.command) as ApprovalAction | null,
    requestedBy: row.requestedBy,
    decidedBy: row.decidedBy,
    decidedAt: iso(row.decidedAt),
    result:
      parseJson(row.command) &&
      (parseJson(row.command) as ApprovalAction).kind === 'command'
        ? publicChangeResult(parseJson(row.result))
        : parseJson(row.result),
    createdAt: iso(row.createdAt),
  };
}

async function approvals() {
  return ApprovalCollection.create({ db: await getShellDb() });
}

/**
 * Record a pending approval for `action`. An identical pending action reuses
 * its row, so retrying a refused call never piles up cards.
 */
export async function requestApproval(
  action: ApprovalAction,
  plan: Plan,
  requestedBy: string,
): Promise<PendingApproval> {
  const key = actionKey(action);
  const coll = await approvals();
  const existing = (
    await coll.list({ where: { actionKey: key, status: 'pending' }, limit: 1 })
  )[0];
  const row =
    existing ??
    (await (async () => {
      const { authority, tenantId } = await shellApprovalAuthority();
      const saved = await authority.request({
        tenantId,
        requestedBy,
        tool: 'shell.action',
        callId: key,
        // Definitions may nest more deeply than a tool argument envelope.
        // Keep their already-validated JSON as inert data, as the legacy table does.
        args: { action: JSON.stringify(action) },
        summary: plan.summary,
        context: {
          preview: JSON.stringify({
            ...(plan.preview ?? {}),
            ...(plan.affectedMethods
              ? { affectedMethods: plan.affectedMethods }
              : {}),
          }),
        },
      });
      const created = (await coll.get(saved.id))!;
      publish({
        type: 'approval',
        id: saved.id,
        status: 'pending',
        summary: plan.summary,
      });
      return created;
    })());
  const v = view(row);
  const pending: PendingApproval = {
    status: 'pending_approval',
    approvalId: v.id,
    summary: v.summary,
    preview: v.preview,
  };
  issuedScope.getStore()?.push(pending);
  return pending;
}

/** One approval as stored, or null. */
export async function getApprovalView(
  id: string,
): Promise<ApprovalView | null> {
  const row = await (await approvals()).get(id);
  return row ? view(row) : null;
}

export async function listApprovalViews(
  filter: { status?: Approval['status'] } = {},
): Promise<ApprovalView[]> {
  const coll = await approvals();
  const rows = await coll.list({
    ...(filter.status ? { where: { status: filter.status } } : {}),
    limit: 500,
  });
  return rows.map(view).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export async function pendingApprovalCount(): Promise<number> {
  return (await listApprovalViews({ status: 'pending' })).length;
}

function isAction(v: unknown): v is ApprovalAction {
  const a = v as ApprovalAction | null;
  if (!a || typeof a !== 'object') return false;
  if (a.kind === 'command')
    return !!a.command && typeof a.command.type === 'string';
  if (a.kind === 'tool')
    return typeof a.name === 'string' && typeof a.args === 'object';
  if (a.kind === 'rest')
    return typeof a.method === 'string' && typeof a.url === 'string';
  if (a.kind === 'record-delete')
    return typeof a.model === 'string' && typeof a.id === 'string';
  if (a.kind === 'publish-draft')
    return (
      typeof a.draftId === 'string' &&
      typeof a.digest === 'string' &&
      typeof a.draftName === 'string'
    );
  if (a.kind === 'discard-draft')
    return typeof a.draftId === 'string' && typeof a.draftName === 'string';
  return false;
}

/**
 * Decide an approval. CALL ONLY FROM `Approval.decide` (which has checked the
 * owner): this is the single place the engine's `approved: true` is set.
 */
/** The failure text when the host RETURNED an error instead of throwing. */
export function returnedFailure(
  kind: string,
  result: unknown,
): string | undefined {
  const r = result as
    | {
        isError?: boolean;
        content?: unknown;
        status?: number;
        body?: string;
      }
    | null
    | undefined;
  if (kind === 'tool' && r?.isError) {
    const first = Array.isArray(r.content)
      ? (r.content[0] as { text?: string } | undefined)
      : undefined;
    return first?.text?.slice(0, 500) || 'the tool reported an error';
  }
  if (kind === 'rest' && typeof r?.status === 'number') {
    if (r.status < 200 || r.status > 299) {
      return `the request failed with status ${r.status}`;
    }
  }
  return undefined;
}

export async function decideApproval(
  id: string,
  approve: boolean,
  decidedBy: string,
): Promise<ApprovalOutcome> {
  const coll = await approvals();
  const row = await coll.get(id);
  if (!row) throw new Error('approval not found');
  if (row.status !== 'pending')
    throw new Error(`approval is already ${row.status}`);
  const { authority, tenantId } = await shellApprovalAuthority();
  try {
    if (!approve) {
      await authority.decide({ id: decidedBy, tenantId }, id, false);
      publish({
        type: 'approval',
        id,
        status: 'denied',
        summary: row.summary,
      });
      return { id, status: 'denied' };
    }
    const action = parseJson(row.command);
    if (!isAction(action)) throw new Error('the stored action is invalid');
    await authority.decide({ id: decidedBy, tenantId }, id, true);
    await authority.consume(tenantId, id);
    let result: unknown;
    let error: string | undefined;
    try {
      // Approvals only ever run against the LIVE host: the draft host
      // approves its own risky changes (autoApprove), so none is ever asked.
      const host = await getHost();
      if (action.kind === 'publish-draft')
        result = await publishApproved(action, (live, draft, o) =>
          live.publishDraft(draft, {
            author: row.requestedBy || decidedBy,
            approved: true,
            expect: o.expect,
            draftName: o.draftName,
          }),
        );
      else if (action.kind === 'discard-draft')
        result = await discardNow(action.draftId);
      else if (action.kind === 'command')
        result = publicChangeResult(
          await host.execute(action.command, {
            author: row.requestedBy || decidedBy,
            approved: true,
            reviewedPreview:
              action.reviewedPreview ??
              (parseJson(row.preview) as Record<string, unknown>),
          }),
        );
      else if (action.kind === 'tool')
        result = await host.callAppTool(action.name, action.args, {
          approved: true,
        });
      else if (action.kind === 'record-delete')
        result = await host.remove(action.model, action.id);
      else
        result = await host.rest(
          { method: action.method, url: action.url, body: action.body },
          { approved: true },
        );
      // The host reports some failures by returning them (a tool's isError,
      // a non-2xx REST response) instead of throwing: they did not apply.
      if (error === undefined) error = returnedFailure(action.kind, result);
    } catch (e) {
      if (e instanceof ApprovalRequiredError && action.kind === 'command') {
        const pending = await requestApproval(
          { ...action, reviewedPreview: e.plan.preview },
          {
            ...e.plan,
            preview: {
              ...(parseJson(row.preview) as Record<string, unknown>),
              ...e.plan.preview,
            },
          },
          row.requestedBy || decidedBy,
        );
        result = pending;
        error =
          'The affected record counts increased. Review the new approval before applying this change.';
      } else error = e instanceof Error ? e.message : String(e);
    }
    row.status = error === undefined ? 'approved' : 'failed';
    await authority.complete(
      tenantId,
      id,
      error === undefined,
      error === undefined
        ? result
        : { error, ...(result ? { pending: result } : {}) },
    );
    publish({
      type: 'approval',
      id,
      status: row.status,
      summary: row.summary,
    });
    return error === undefined
      ? { id, status: 'approved', result }
      : { id, status: 'failed', error };
  } catch (error) {
    if (error instanceof OwnerApprovalError && error.code === 'conflict')
      throw new Error('approval is already decided');
    throw error;
  }
}
