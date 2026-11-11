/** Durable, single-use holds for host tools. Never expose this authority to a model. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import {
  type ApprovalPrincipal,
  ApprovalService,
  defineApprovalKind,
} from '@happyvertical/smrt-approvals';
import { withTenant } from '@happyvertical/smrt-tenancy';
import {
  DEFAULT_ROLE_SLUGS,
  MembershipCollection,
  MembershipStatus,
  RoleCollection,
  UserCollection,
  UserStatus,
} from '@happyvertical/smrt-users';
import type { DatabaseInterface } from '@happyvertical/sql';
import { deepFrozenPlainCopy } from './plain-data.js';

export type OwnerApprovalStatus =
  | 'pending'
  | 'approved'
  | 'denied'
  | 'expired'
  | 'executing'
  | 'succeeded'
  | 'failed';

export interface OwnerApprovalActor {
  id: string;
  tenantId: string;
}

/** Server-owned snapshot. Arguments, identity and permission ceilings are immutable. */
export interface OwnerApprovalInput {
  tenantId: string;
  requestedBy: string;
  tool: string;
  callId: string;
  args: Record<string, unknown>;
  summary: string;
  /** Host recovery envelope (thread, principal, permission ceiling), never request-body authority. */
  context: Record<string, unknown>;
  ttlMs?: number;
  /** Trusted executor binding; independent of a tool's own context fingerprint. */
  continuation?: OwnerToolContinuation;
}

export interface OwnerApproval extends Omit<OwnerApprovalInput, 'ttlMs'> {
  id: string;
  status: OwnerApprovalStatus;
  createdAt: number;
  expiresAt: number;
  decidedBy: string | null;
  decidedAt: number | null;
  result?: unknown;
}

/** Implementations MUST atomically compare status and expiry, scoped to the tenant. */
export interface OwnerApprovalStore {
  /** Only legacy host stores with an established indefinite-hold contract opt in. */
  readonly supportsNonExpiring?: boolean;
  insert(record: OwnerApproval): Promise<void>;
  get(tenantId: string, id: string): Promise<OwnerApproval | null>;
  list(tenantId: string): Promise<OwnerApproval[]>;
  transition(
    tenantId: string,
    id: string,
    from: OwnerApprovalStatus,
    to: OwnerApprovalStatus,
    now: number,
    patch?: Pick<OwnerApproval, 'decidedBy' | 'decidedAt' | 'result'>,
  ): Promise<boolean>;
}

export class OwnerApprovalError extends Error {
  constructor(
    readonly code: 'forbidden' | 'not_found' | 'conflict' | 'invalid_request',
  ) {
    super(`Owner approval: ${code}`);
  }
}

/** Live direct membership in the built-in system owner role, plus an active user. */
export async function isApprovalOwner(
  db: DatabaseInterface,
  actor: OwnerApprovalActor,
): Promise<boolean> {
  if (!actor.id || !actor.tenantId) return false;
  return withTenant({ tenantId: actor.tenantId }, async () => {
    const user = await (await UserCollection.create({ db })).get(actor.id);
    if (!user || user.status !== UserStatus.ACTIVE) return false;
    const role = await (
      await RoleCollection.create({ db })
    ).findSystemRoleBySlug(DEFAULT_ROLE_SLUGS.OWNER);
    const membership = await (
      await MembershipCollection.create({ db })
    ).findByUserAndTenant(actor.id, actor.tenantId);
    return (
      !!role?.id &&
      membership?.status === MembershipStatus.ACTIVE &&
      membership.roleId === role.id
    );
  });
}

/** Host authority. Owner check is mandatory and evaluated for every list/decision. */
export class OwnerApprovalAuthority {
  constructor(
    private readonly store: OwnerApprovalStore,
    private readonly isOwner: (actor: OwnerApprovalActor) => Promise<boolean>,
    private readonly now: () => number = Date.now,
    // Compatibility for existing host stores with non-expiring requests.
    // The canonical SQLite ledger retains its own bounded TTL policy.
    private readonly options: {
      nonExpiring?: boolean;
      maxInputChars?: number;
    } = {},
  ) {
    if (
      options.maxInputChars !== undefined &&
      (!Number.isSafeInteger(options.maxInputChars) ||
        options.maxInputChars < 1024 ||
        options.maxInputChars > 16_000_000)
    )
      throw new OwnerApprovalError('invalid_request');
    if (options.nonExpiring && !store.supportsNonExpiring)
      throw new OwnerApprovalError('invalid_request');
  }

  async request(input: OwnerApprovalInput): Promise<OwnerApproval> {
    const copy = deepFrozenPlainCopy(input) as OwnerApprovalInput;
    const ttl = copy.ttlMs ?? 15 * 60_000;
    if (
      ![
        copy.tenantId,
        copy.requestedBy,
        copy.tool,
        copy.callId,
        copy.summary,
      ].every((v) => typeof v === 'string' && v.trim() && v.length <= 4000) ||
      !Number.isSafeInteger(ttl) ||
      ttl < 60_000 ||
      ttl > 24 * 60 * 60_000 ||
      !copy.args ||
      Array.isArray(copy.args) ||
      typeof copy.args !== 'object' ||
      !copy.context ||
      Array.isArray(copy.context) ||
      typeof copy.context !== 'object' ||
      JSON.stringify(copy).length > (this.options.maxInputChars ?? 128_000)
    )
      throw new OwnerApprovalError('invalid_request');
    const { ttlMs: _, ...data } = copy;
    const createdAt = this.now();
    const record: OwnerApproval = {
      ...data,
      id: randomUUID(),
      status: 'pending',
      createdAt,
      expiresAt: this.options.nonExpiring
        ? Number.MAX_SAFE_INTEGER
        : createdAt + ttl,
      decidedBy: null,
      decidedAt: null,
    };
    await this.store.insert(record);
    return record;
  }

  /** Snapshot caller-owned identity before the live owner check can yield. */
  async authorize(actor: OwnerApprovalActor): Promise<OwnerApprovalActor> {
    const snapshot = deepFrozenPlainCopy(actor) as OwnerApprovalActor;
    if (
      !snapshot ||
      typeof snapshot.id !== 'string' ||
      !snapshot.id ||
      typeof snapshot.tenantId !== 'string' ||
      !snapshot.tenantId ||
      !(await this.isOwner(snapshot))
    )
      throw new OwnerApprovalError('forbidden');
    return snapshot;
  }

  /** Internal trusted-host read; callers must check thread access before presenting it. */
  async get(tenantId: string, id: string): Promise<OwnerApproval | null> {
    let record = await this.store.get(tenantId, id);
    if (
      (record?.status === 'pending' || record?.status === 'approved') &&
      record.expiresAt <= this.now()
    ) {
      await this.store.transition(
        tenantId,
        id,
        record.status,
        'expired',
        this.now(),
      );
      record = await this.store.get(tenantId, id);
    }
    return record;
  }

  async list(
    actor: OwnerApprovalActor,
    pendingOnly = true,
  ): Promise<OwnerApproval[]> {
    actor = await this.authorize(actor);
    const records = await this.store.list(actor.tenantId);
    const fresh = await Promise.all(
      records.map((r) => this.get(actor.tenantId, r.id)),
    );
    return fresh.filter(
      (r): r is OwnerApproval =>
        !!r && (!pendingOnly || r.status === 'pending'),
    );
  }

  async decide(
    actor: OwnerApprovalActor,
    id: string,
    approve: boolean,
  ): Promise<OwnerApproval> {
    if (typeof approve !== 'boolean')
      throw new OwnerApprovalError('invalid_request');
    actor = await this.authorize(actor);
    const record = await this.get(actor.tenantId, id);
    if (!record) throw new OwnerApprovalError('not_found');
    const now = this.now();
    if (
      !(await this.store.transition(
        actor.tenantId,
        id,
        'pending',
        approve ? 'approved' : 'denied',
        now,
        { decidedBy: actor.id, decidedAt: now },
      ))
    )
      throw new OwnerApprovalError('conflict');
    return (await this.get(actor.tenantId, id))!;
  }

  /** Claim BEFORE effects. No retry after a crash or partial external effect. */
  async consume(tenantId: string, id: string): Promise<OwnerApproval> {
    const record = await this.get(tenantId, id);
    if (!record) throw new OwnerApprovalError('not_found');
    if (
      !(await this.store.transition(
        tenantId,
        id,
        'approved',
        'executing',
        this.now(),
      ))
    )
      throw new OwnerApprovalError('conflict');
    return { ...record, status: 'executing' };
  }

  async complete(
    tenantId: string,
    id: string,
    ok: boolean,
    result: unknown,
  ): Promise<void> {
    const value = JSON.stringify(result ?? null);
    if (
      !(await this.store.transition(
        tenantId,
        id,
        'executing',
        ok ? 'succeeded' : 'failed',
        this.now(),
        {
          decidedBy: null,
          decidedAt: null,
          result:
            value.length <= 64_000 ? JSON.parse(value) : { truncated: true },
        },
      ))
    )
      throw new OwnerApprovalError('conflict');
  }

  /** Poll storage so waits also observe decisions from another process/authority. */
  async wait(
    tenantId: string,
    id: string,
    signal?: AbortSignal,
    options?: { settled?: boolean },
  ): Promise<OwnerApproval | null> {
    while (!signal?.aborted) {
      const record = await this.get(tenantId, id);
      if (
        !record ||
        !(options?.settled
          ? ['pending', 'approved', 'executing'].includes(record.status)
          : record.status === 'pending')
      )
        return record;
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', finish);
          resolve();
        };
        const timer = setTimeout(finish, 100);
        signal?.addEventListener('abort', finish, { once: true });
        if (signal?.aborted) finish();
      });
    }
    return null;
  }
}

const TABLE = '_smrt_owner_tool_holds';
const DECIDE_PERMISSION = 'runtime.owner-approval.decide';

/** SQLite envelope adapter. ApprovalService remains the only decision/consumption authority.
 * Application migrations must include smrt-approvals before this adapter is used.
 * Only the host envelope is a runtime system table; no duplicate approval model/ledger.
 */
export async function createSqliteOwnerApprovalStore(
  db: DatabaseInterface,
  now: () => number = Date.now,
): Promise<OwnerApprovalStore> {
  const service = new ApprovalService({ db, now: () => new Date(now()) });
  await db.query(`CREATE TABLE IF NOT EXISTS ${TABLE} (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, gate_id TEXT,
    execution_status TEXT, record TEXT NOT NULL, result TEXT
  )`);
  const principal = (
    tenantId: string,
    id: string,
    type: ApprovalPrincipal['type'] = 'service',
  ): ApprovalPrincipal => ({
    tenantId,
    id,
    type,
    can: (slug) => slug === DECIDE_PERMISSION,
  });
  const kind = (record: OwnerApproval) =>
    defineApprovalKind({
      key: `runtime.owner-tool.ttl-${record.expiresAt - record.createdAt}`,
      subject: '@happyvertical/smrt-app-runtime:OwnerToolHold',
      permission: DECIDE_PERMISSION,
      selfApprovalPermission: DECIDE_PERMISSION,
      defaults: {
        requiredApprovals: 1,
        ttlMs: record.expiresAt - record.createdAt,
      },
    });
  const hash = (record: OwnerApproval) =>
    createHash('sha256').update(JSON.stringify(record)).digest('hex');
  const rowFor = async (tenantId: string, id: string) =>
    (
      await db.query(
        `SELECT * FROM ${TABLE} WHERE tenant_id = ? AND id = ? AND gate_id IS NOT NULL`,
        tenantId,
        id,
      )
    ).rows[0];
  const read = async (
    row: Record<string, unknown>,
  ): Promise<OwnerApproval | null> => {
    const record = JSON.parse(String(row.record)) as OwnerApproval;
    kind(record); // Re-register the same fixed rules after a process restart.
    const actor = principal(record.tenantId, record.requestedBy);
    const request = await service.getRequest(actor, String(row.gate_id));
    if (!request) return null;
    const events = await service.listEvents(actor, String(row.gate_id));
    const decision = events.find(
      (event) => event.type === 'approved' || event.type === 'rejected',
    );
    const status: OwnerApprovalStatus =
      request.status === 'rejected'
        ? 'denied'
        : request.status === 'expired'
          ? 'expired'
          : request.status === 'approved'
            ? ((row.execution_status as OwnerApprovalStatus | null) ??
              (request.isConsumed() ? 'executing' : 'approved'))
            : 'pending';
    return {
      ...record,
      expiresAt: request.expiresAtMs(),
      status,
      decidedBy: decision?.actorId ?? null,
      decidedAt: request.decidedAt
        ? new Date(request.decidedAt).getTime()
        : null,
      ...(row.result == null ? {} : { result: JSON.parse(String(row.result)) }),
    };
  };
  return {
    async insert(record) {
      // An unlinked envelope can never be listed, decided or consumed.
      await db.query(
        `INSERT INTO ${TABLE} (id, tenant_id, record) VALUES (?, ?, ?)`,
        record.id,
        record.tenantId,
        JSON.stringify(record),
      );
      const gate = await service.requestApproval(
        principal(record.tenantId, record.requestedBy, 'agent'),
        {
          kind: kind(record),
          subjectId: record.id,
          subjectRevisionHash: hash(record),
          requestKey: record.id,
          summary: record.summary,
        },
      );
      if (!gate.request || gate.outcome === 'refused')
        throw new OwnerApprovalError('invalid_request');
      await db.query(
        `UPDATE ${TABLE} SET gate_id = ? WHERE tenant_id = ? AND id = ?`,
        gate.request.id,
        record.tenantId,
        record.id,
      );
    },
    async get(tenantId, id) {
      const row = await rowFor(tenantId, id);
      return row ? read(row) : null;
    },
    async list(tenantId) {
      const rows = (
        await db.query(
          `SELECT * FROM ${TABLE} WHERE tenant_id = ? AND gate_id IS NOT NULL ORDER BY id`,
          tenantId,
        )
      ).rows;
      const records = await Promise.all(rows.map(read));
      return records.filter(
        (record): record is OwnerApproval => record !== null,
      );
    },
    async transition(tenantId, id, from, to, _now, patch) {
      const row = await rowFor(tenantId, id);
      if (!row) return false;
      const record = JSON.parse(String(row.record)) as OwnerApproval;
      kind(record);
      const gateId = String(row.gate_id);
      const actor = principal(
        tenantId,
        patch?.decidedBy ?? record.requestedBy,
        patch?.decidedBy ? 'human' : 'service',
      );
      if (to === 'expired' && (from === 'pending' || from === 'approved')) {
        return (await service.expire(actor, gateId)).outcome === 'transitioned';
      }
      if (from === 'pending') {
        const outcome =
          to === 'expired'
            ? await service.expire(actor, gateId)
            : await service.decide(actor, gateId, {
                decision: to === 'approved' ? 'approve' : 'reject',
                reason: 'Owner denied the tool call.',
              });
        return outcome.outcome === 'transitioned';
      }
      if (from === 'approved' && to === 'executing') {
        return (
          (await service.consume(actor, gateId, hash(record))).outcome ===
          'transitioned'
        );
      }
      if (from !== 'executing' || (to !== 'succeeded' && to !== 'failed'))
        return false;
      const request = await service.getRequest(actor, gateId);
      if (!request?.isConsumed()) return false;
      return (
        (
          await db.query(
            `UPDATE ${TABLE} SET execution_status = ?, result = ?
        WHERE tenant_id = ? AND id = ? AND execution_status IS NULL RETURNING id`,
            to,
            JSON.stringify(patch?.result ?? null),
            tenantId,
            id,
          )
        ).rows.length === 1
      );
    },
  };
}

/** Saved caller authority can only shrink when the registered executor resumes it. */
export interface OwnerToolContinuation {
  executor: string;
  principal: {
    id: string;
    tenantId: string;
    permissions: string[];
    allowedTools: string[];
  };
  consumption: 'executor' | 'continuation';
}

/** No second ledger: this dispatches the canonical authority's durable envelopes. */
export class OwnerApprovalContinuations {
  private readonly callers = new AsyncLocalStorage<
    OwnerToolContinuation['principal']
  >();
  constructor(
    readonly authority: OwnerApprovalAuthority,
    private readonly executors: Readonly<
      Record<string, (record: OwnerApproval) => Promise<unknown>>
    >,
  ) {}

  capture<T>(
    principal: OwnerToolContinuation['principal'],
    work: () => Promise<T>,
  ): Promise<T> {
    return this.callers.run(
      deepFrozenPlainCopy(principal) as typeof principal,
      work,
    );
  }

  /** Adapt native-hold tools without changing their pinned args/context or consuming twice. */
  adapter(
    executor: string,
    consumption: OwnerToolContinuation['consumption'] = 'executor',
  ) {
    const authority = this.authority;
    return {
      request: async (input: OwnerApprovalInput) => {
        const principal = this.callers.getStore();
        if (
          !principal ||
          principal.id !== input.requestedBy ||
          principal.tenantId !== input.tenantId ||
          !principal.allowedTools.includes(input.tool)
        )
          throw new OwnerApprovalError('forbidden');
        return authority.request({
          ...input,
          continuation: { executor, consumption, principal },
        });
      },
      get: authority.get.bind(authority),
      consume: authority.consume.bind(authority),
      complete: authority.complete.bind(authority),
    };
  }

  /** Result reads are scoped to the requesting principal, including after restart. */
  async outcome(actor: OwnerApprovalActor, id: string): Promise<OwnerApproval> {
    actor = deepFrozenPlainCopy(actor) as OwnerApprovalActor;
    const record = await this.authority.get(actor.tenantId, id);
    if (!record || record.requestedBy !== actor.id)
      throw new OwnerApprovalError('not_found');
    return record;
  }

  async decide(
    actor: OwnerApprovalActor,
    id: string,
    approve: boolean,
  ): Promise<OwnerApproval> {
    actor = await this.authority.authorize(actor);
    const record = await this.authority.get(actor.tenantId, id);
    const binding = record?.continuation;
    if (!record || !binding || !this.executors[binding.executor])
      throw new OwnerApprovalError('not_found');
    const decision = await this.authority.decide(actor, id, approve);
    if (decision.status !== 'approved') return decision;
    return this.resume(actor, id);
  }

  /** Resume an approved, unconsumed call after a process restart. Never retry executing calls. */
  async resume(actor: OwnerApprovalActor, id: string): Promise<OwnerApproval> {
    actor = await this.authority.authorize(actor);
    const record = await this.authority.get(actor.tenantId, id);
    const binding = record?.continuation;
    const execute = binding && this.executors[binding.executor];
    if (!record || !binding || !execute || record.status !== 'approved')
      throw new OwnerApprovalError('conflict');
    if (binding.consumption === 'continuation')
      await this.authority.consume(actor.tenantId, id);
    try {
      const result = await this.capture(binding.principal, () =>
        execute(record),
      );
      if (binding.consumption === 'continuation')
        await this.authority.complete(actor.tenantId, id, true, result);
    } catch (error) {
      // Native tools own consumption and completion. Fail closed if validation refused before effects.
      const fresh = await this.authority.get(actor.tenantId, id);
      if (fresh?.status === 'approved')
        await this.authority.consume(actor.tenantId, id);
      if (
        fresh?.status === 'approved' ||
        (binding.consumption === 'continuation' &&
          fresh?.status === 'executing')
      )
        await this.authority.complete(actor.tenantId, id, false, {
          error: 'Approved call refused or failed.',
        });
      throw error;
    }
    return (await this.authority.get(actor.tenantId, id))!;
  }
}
