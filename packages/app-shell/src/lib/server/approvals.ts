// The approval gate. A risky builder command, app tool call or REST DELETE
// does not run: it becomes an `Approval` row for the owner. Only
// `decideApproval` (called from `Approval.decide`) ever passes the engine's
// `approved: true`; nothing taken from a request body can set it.
import { createHash } from 'node:crypto';
import type { Command, Plan } from '../../engine/index.ts';
import { type Approval, ApprovalCollection } from '../objects/Approval.ts';
import { publish } from './events.ts';
import { getHost, getShellDb } from './host.ts';

/** What an approval runs once the owner says yes. */
export type ApprovalAction =
  | { kind: 'command'; command: Command }
  | { kind: 'tool'; name: string; args: Record<string, unknown> }
  | { kind: 'rest'; method: string; url: string; body?: string }
  | { kind: 'record-delete'; model: string; id: string };

/** The answer a refused-until-approved call gives instead of applying. */
export interface PendingApproval {
  status: 'pending_approval';
  approvalId: string;
  summary: string;
  preview: unknown;
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

const MAX_RESULT_CHARS = 64_000;

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

function parseJson(text: string): unknown {
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
    status: row.status,
    summary: row.summary,
    preview: parseJson(row.preview),
    action: parseJson(row.command) as ApprovalAction | null,
    requestedBy: row.requestedBy,
    decidedBy: row.decidedBy,
    decidedAt: iso(row.decidedAt),
    result: parseJson(row.result),
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
      const created = await coll.create({
        command: JSON.stringify(action),
        actionKey: key,
        summary: plan.summary,
        preview: JSON.stringify({
          ...(plan.preview ? { preview: plan.preview } : {}),
          ...(plan.affectedMethods
            ? { affectedMethods: plan.affectedMethods }
            : {}),
        }),
        status: 'pending',
        requestedBy,
        createdAt: new Date().toISOString(),
      });
      await created.save();
      publish({
        type: 'approval',
        id: created.id as string,
        status: 'pending',
        summary: plan.summary,
      });
      return created;
    })());
  const v = view(row);
  return {
    status: 'pending_approval',
    approvalId: v.id,
    summary: v.summary,
    preview: v.preview,
  };
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

const inFlight = new Set<string>();

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
  return false;
}

/**
 * Decide an approval. CALL ONLY FROM `Approval.decide` (which has checked the
 * owner): this is the single place the engine's `approved: true` is set.
 */
export async function decideApproval(
  id: string,
  approve: boolean,
  decidedBy: string,
): Promise<ApprovalOutcome> {
  const coll = await approvals();
  const row = await coll.get(id);
  if (!row) throw new Error('approval not found');
  if (row.status !== 'pending' || inFlight.has(id))
    throw new Error(`approval is already ${row.status}`);
  inFlight.add(id);
  try {
    const decidedAt = new Date().toISOString();
    if (!approve) {
      row.status = 'denied';
      row.decidedBy = decidedBy;
      row.decidedAt = decidedAt;
      await row.save();
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
    // Mark it taken before running anything: a second decide sees "approved".
    row.status = 'approved';
    row.decidedBy = decidedBy;
    row.decidedAt = decidedAt;
    await row.save();
    let result: unknown;
    let error: string | undefined;
    try {
      const host = await getHost();
      if (action.kind === 'command')
        result = await host.execute(action.command, {
          author: row.requestedBy || decidedBy,
          approved: true,
        });
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
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    row.status = error === undefined ? 'approved' : 'failed';
    const text = JSON.stringify(error === undefined ? result : { error });
    row.result =
      text.length > MAX_RESULT_CHARS
        ? JSON.stringify({ truncated: true })
        : (text ?? '');
    await row.save();
    publish({
      type: 'approval',
      id,
      status: row.status,
      summary: row.summary,
    });
    return error === undefined
      ? { id, status: 'approved', result }
      : { id, status: 'failed', error };
  } finally {
    inFlight.delete(id);
  }
}
