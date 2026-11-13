// Storage compatibility for installed Tricia databases. The shared authority
// owns decisions/consumption; this adapter keeps the existing ids and history.
import {
  type OwnerApproval,
  OwnerApprovalAuthority,
  type OwnerApprovalStore,
} from '@happyvertical/smrt-app-runtime';
import { TenantCollection } from '@happyvertical/smrt-users';
import { type Approval, ApprovalCollection } from '../objects/Approval.ts';
import { parseJson } from './approvals.ts';
import { getShellDb } from './host.ts';
import { isOwner } from './owner.ts';

/** The local product has one tenant. Refuse ambiguous legacy ownership. */
export async function shellApprovalAuthority() {
  const db = await getShellDb();
  const tenants = await (await TenantCollection.create({ db })).list({
    limit: 2,
  });
  if (tenants.length !== 1 || !tenants[0].id)
    throw new Error('approval storage requires the single installation tenant');
  const tenantId = tenants[0].id;
  const collection = await ApprovalCollection.create({ db });
  const record = (row: Approval): OwnerApproval => ({
    id: row.id as string,
    tenantId,
    requestedBy: row.requestedBy,
    tool: 'shell.action',
    callId: row.actionKey,
    args: { action: row.command },
    summary: row.summary,
    context: { preview: row.preview },
    createdAt: new Date(row.createdAt).getTime(),
    expiresAt: Number.MAX_SAFE_INTEGER,
    // Old approved rows without results may have crashed during execution.
    // Never replay those. New decisions use accepted until consume succeeds.
    status:
      row.status === 'accepted'
        ? 'approved'
        : row.status === 'approved'
          ? row.result
            ? 'succeeded'
            : 'executing'
          : row.status,
    decidedBy: row.decidedBy || null,
    decidedAt: row.decidedAt ? new Date(row.decidedAt).getTime() : null,
    ...(row.result ? { result: parseJson(row.result) } : {}),
  });
  const store: OwnerApprovalStore = {
    supportsNonExpiring: true,
    async insert(value) {
      if (value.tenantId !== tenantId)
        throw new Error('foreign approval tenant');
      const row = await collection.create({
        id: value.id,
        command: String(value.args.action),
        actionKey: value.callId,
        summary: value.summary,
        preview: String(value.context.preview),
        status: 'pending',
        requestedBy: value.requestedBy,
        createdAt: new Date(value.createdAt).toISOString(),
      });
      await row.save();
    },
    async get(tenant, id) {
      if (tenant !== tenantId) return null;
      const row = await collection.get(id);
      return row ? record(row) : null;
    },
    async list(tenant) {
      return tenant === tenantId
        ? (await collection.list({ limit: 500 })).map(record)
        : [];
    },
    async transition(tenant, id, from, to, now, patch) {
      if (tenant !== tenantId) return false;
      const persisted = (state: string) =>
        state === 'approved'
          ? 'accepted'
          : state === 'succeeded'
            ? 'approved'
            : state;
      // One conditional statement on the same database is the cross-process
      // authority, including consumption BEFORE any host effect.
      const sets = ['status = ?'];
      const values: unknown[] = [persisted(to)];
      if (from === 'pending') {
        sets.push('decided_by = ?', 'decided_at = ?');
        values.push(patch?.decidedBy ?? '', new Date(now).toISOString());
      }
      if (to === 'succeeded' || to === 'failed') {
        sets.push('result = ?');
        values.push(JSON.stringify(patch?.result ?? null));
      }
      const changed = await db.query(
        `UPDATE approvals SET ${sets.join(', ')} WHERE id = ? AND status = ? RETURNING id`,
        ...values,
        id,
        persisted(from),
      );
      return changed.rows.length === 1;
    },
  };
  return {
    tenantId,
    authority: new OwnerApprovalAuthority(store, isOwner, Date.now, {
      nonExpiring: true,
      maxInputChars: 4_000_000,
    }),
  };
}
