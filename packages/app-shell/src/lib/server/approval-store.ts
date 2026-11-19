// Storage compatibility for installed Tricia databases. The shared authority
// owns decisions/consumption; this adapter keeps the existing ids and history.
import {
  type OwnerApproval,
  OwnerApprovalAuthority,
  type OwnerApprovalStore,
} from '@happyvertical/smrt-app-runtime';
import { getCurrentTenant } from '@happyvertical/smrt-tenancy';
import { TenantCollection } from '@happyvertical/smrt-users';
import { type Approval, ApprovalCollection } from '../objects/Approval.ts';
import { parseJson } from './approvals.ts';
import { getShellDb, shellProfile } from './host.ts';
import { isOwner, PolicyError } from './owner.ts';

/**
 * The tenant the approvals belong to. The desktop has one tenant (ambiguous
 * legacy ownership is refused). The hosted app has many: the tenant of the
 * verified request, never a lookup, so one owner's approvals are never
 * another's.
 */
async function approvalTenant(db: Awaited<ReturnType<typeof getShellDb>>) {
  if ((await shellProfile()) === 'cloud') {
    const tenantId = getCurrentTenant()?.tenantId;
    if (!tenantId) throw new PolicyError(401, 'sign in first');
    return { tenantId, hosted: true };
  }
  const tenants = await (await TenantCollection.create({ db })).list({
    limit: 2,
  });
  if (tenants.length !== 1 || !tenants[0].id)
    throw new Error('approval storage requires the single installation tenant');
  return { tenantId: tenants[0].id, hosted: false };
}

/** The shared authority over this deployment's approval rows. */
export async function shellApprovalAuthority() {
  const db = await getShellDb();
  const { tenantId, hosted } = await approvalTenant(db);
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
      // Hosted: a row of another tenant is not found, even by its id.
      if (
        hosted &&
        row &&
        (row as { tenantId?: unknown }).tenantId !== tenantId
      )
        return null;
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
      // Raw SQL bypasses the tenant interceptor: the hosted app names the
      // tenant itself, so a decision can only ever touch its own row.
      const changed = await db.query(
        `UPDATE approvals SET ${sets.join(', ')} WHERE id = ? AND status = ?${hosted ? ' AND tenant_id = ?' : ''} RETURNING id`,
        ...values,
        id,
        persisted(from),
        ...(hosted ? [tenantId] : []),
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
