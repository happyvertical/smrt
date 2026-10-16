import {
  digestRunOnceContent,
  type SmrtClassOptions,
} from '@happyvertical/smrt-core';
import { withTenant } from '@happyvertical/smrt-tenancy';
import {
  ParticipationBanCollection,
  ParticipationPolicyCollection,
  ParticipationRateBucketCollection,
} from '../collections/ParticipationCollection.js';
import type { ParticipationPolicy } from '../models/ParticipationPolicy.js';
import {
  type ParticipationAuthorizer,
  type ParticipationDecision,
  ParticipationDeniedError,
  type ParticipationRequest,
} from '../participation-contract.js';

type Database = ParticipationRateBucketCollection['db'];
const canonical = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    ? value.toLowerCase()
    : value;

/** Shared generic policy, ban, and transactional quota enforcement. */
export class ParticipationService {
  constructor(
    private readonly options: {
      db: SmrtClassOptions['db'];
      entitlement?: ParticipationAuthorizer;
      /** Trusted clock for deterministic fixed-window boundaries. */
      now?: () => Date;
    },
  ) {}

  private normalize(request: ParticipationRequest): ParticipationRequest {
    if (
      !request ||
      !['comment', 'react', 'vote', 'report'].includes(request.action) ||
      [
        request.tenantId,
        request.actorUserId,
        request.recordType,
        request.recordId,
      ].some((value) => typeof value !== 'string' || !value.trim())
    ) {
      throw new TypeError('Invalid participation request.');
    }
    return {
      ...request,
      tenantId: canonical(request.tenantId),
      actorUserId: canonical(request.actorUserId),
      recordId: canonical(request.recordId),
    };
  }

  private async evaluate(
    request: ParticipationRequest,
    db: SmrtClassOptions['db'],
  ) {
    const now = (this.options.now?.() ?? new Date()).getTime();
    if (!Number.isFinite(now))
      throw new TypeError('Invalid participation clock.');
    const policies = await ParticipationPolicyCollection.create({ db });
    const rows = await policies.list({
      where: { tenantId: request.tenantId, action: request.action },
    });
    const exact = rows.filter(
      (p) =>
        p.recordType === request.recordType && p.recordId === request.recordId,
    );
    const defaults = rows.filter(
      (p) => p.recordType === '' && p.recordId === '',
    );
    if (exact.length > 1 || defaults.length > 1)
      throw new ParticipationDeniedError('Ambiguous participation policy.');
    const policy = exact[0] ?? defaults[0];
    if (
      policy &&
      (!['open', 'pre_moderated', 'members_only', 'closed'].includes(
        policy.moderationMode,
      ) ||
        !Number.isSafeInteger(policy.maxActions) ||
        policy.maxActions < 0 ||
        !Number.isSafeInteger(policy.windowSeconds) ||
        policy.windowSeconds < 0 ||
        (policy.maxActions > 0 && policy.windowSeconds < 1))
    ) {
      throw new ParticipationDeniedError('Invalid participation policy.');
    }
    if (policy?.moderationMode === 'closed')
      throw new ParticipationDeniedError('Participation is closed.');
    const bans = await ParticipationBanCollection.create({ db });
    for (const ban of await bans.list({
      where: { tenantId: request.tenantId, actorUserId: request.actorUserId },
    })) {
      if (
        (ban.recordType === '' && ban.recordId === '') ||
        (ban.recordType === request.recordType &&
          ban.recordId === request.recordId)
      ) {
        const expiry =
          ban.expiresAt === null ? null : new Date(ban.expiresAt).getTime();
        if (expiry === null || !Number.isFinite(expiry) || expiry > now)
          throw new ParticipationDeniedError('Actor is banned.');
      }
    }
    const decision = this.options.entitlement
      ? await this.options.entitlement.authorize(request)
      : { allowed: true };
    if (
      decision?.allowed !== true ||
      (policy?.moderationMode === 'members_only' && decision.member !== true)
    ) {
      throw new ParticipationDeniedError(
        decision?.reason ?? 'Membership required.',
      );
    }
    if (
      decision.initialCommentStatus !== undefined &&
      !['visible', 'pending'].includes(decision.initialCommentStatus)
    )
      throw new ParticipationDeniedError('Invalid moderation decision.');
    return {
      policy,
      now,
      decision: {
        ...decision,
        initialCommentStatus:
          policy?.moderationMode === 'pre_moderated'
            ? ('pending' as const)
            : decision.initialCommentStatus,
      },
    };
  }

  /** Checks current permission without consuming quota (including keyed replays). */
  async authorize(input: ParticipationRequest): Promise<ParticipationDecision> {
    const request = this.normalize(input);
    return withTenant(
      { tenantId: request.tenantId },
      async () => (await this.evaluate(request, this.options.db)).decision,
    );
  }

  private async reserve(
    db: Database,
    request: ParticipationRequest,
    policy: ParticipationPolicy | undefined,
    now: number,
  ) {
    if (!policy?.maxActions) return;
    const buckets = await ParticipationRateBucketCollection.create({ db });
    const bucketKey = digestRunOnceContent({
      actor: request.actorUserId,
      action: request.action,
      recordType: policy.recordType,
      recordId: policy.recordId,
      windowSeconds: policy.windowSeconds,
      window: Math.floor(now / (policy.windowSeconds * 1000)),
    });
    const table = `"${buckets.tableName.replace(/"/g, '""')}"`;
    const id = crypto.randomUUID();
    // One bounded atomic upsert arbitrates all service instances and processes.
    // The supplied transaction also owns the guarded mutation; failures release quota.
    const result = await db.query(
      `INSERT INTO ${table} (id, slug, context, tenant_id, bucket_key, action_count) VALUES (?, ?, '', ?, ?, 1) ON CONFLICT (tenant_id, bucket_key) DO UPDATE SET action_count = ${table}.action_count + 1 WHERE ${table}.action_count < ? RETURNING action_count`,
      id,
      id,
      request.tenantId,
      bucketKey,
      policy.maxActions,
    );
    if (result.rows.length !== 1)
      throw new ParticipationDeniedError('Rate limit exceeded.');
  }

  /** Run one new mutation atomically with its reservation. Caller owns retry identity. */
  async execute<T>(
    input: ParticipationRequest,
    work: (db: Database, decision: ParticipationDecision) => Promise<T>,
  ): Promise<T> {
    const request = this.normalize(input);
    return withTenant({ tenantId: request.tenantId }, async () => {
      const collection = await ParticipationRateBucketCollection.create({
        db: this.options.db,
      });
      if (!collection.db.transaction)
        throw new Error('Participation requires transactions.');
      return collection.db.transaction((tx) =>
        this.executeInTransaction(tx, request, work),
      );
    });
  }

  /** Compose with an existing caller-owned transaction; propagate failures to roll it back. */
  async executeInTransaction<T>(
    tx: Database,
    input: ParticipationRequest,
    work: (db: Database, decision: ParticipationDecision) => Promise<T>,
  ): Promise<T> {
    const request = this.normalize(input);
    return withTenant({ tenantId: request.tenantId }, async () => {
      const { policy, now, decision } = await this.evaluate(request, tx);
      await this.reserve(tx, request, policy, now);
      return work(tx, decision);
    });
  }
}
