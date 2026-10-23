import {
  ParticipationDeniedError,
  ParticipationService,
} from '@happyvertical/smrt-comments/participation';
import {
  ObjectRegistry,
  type SmrtClassOptions,
} from '@happyvertical/smrt-core';
import { withTenant } from '@happyvertical/smrt-tenancy';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import {
  PollCollection,
  PollVoteCollection,
  ReactionCollection,
} from './collections/index.js';
import type { Poll } from './models/Poll.js';
import {
  type CreatePollInput,
  type PollProjection,
  REACTION_KINDS,
  type ReactionKind,
  type ServiceOptions,
} from './types.js';
import { withParticipationWrite } from './write-authority.js';

type Database = PollCollection['db'];
type RuntimeOptions = Omit<ServiceOptions, 'database'> & {
  db: DatabaseInterface;
  backend: 'sqlite' | 'postgres';
};
const runtimeToken = Symbol('participation-runtime');
const canonical = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    ? value.toLowerCase()
    : value;
const table = (name: string) => `"${name.replace(/"/g, '""')}"`;
class ParticipationBoundary {
  protected readonly options: RuntimeOptions;
  readonly #backend: 'sqlite' | 'postgres';
  constructor(options: RuntimeOptions, token: symbol) {
    if (token !== runtimeToken)
      throw new TypeError('Use ParticipationRuntime.create.');
    this.#backend = options.backend;
    if (
      !options.actor ||
      [
        options.actor.tenantId,
        options.actor.userId,
        options.actor.profileId,
      ].some((v) => typeof v !== 'string' || !v.trim()) ||
      !options.participation?.authorize ||
      typeof options.authorizeRecord !== 'function'
    )
      throw new TypeError(
        'Trusted actor, record authorizer and participation authorizer are required.',
      );
    this.options = {
      ...options,
      actor: {
        tenantId: canonical(options.actor.tenantId),
        userId: canonical(options.actor.userId),
        profileId: canonical(options.actor.profileId),
      },
    };
  }
  protected async access(
    recordType: string,
    recordId: string,
    action: 'read' | 'react' | 'vote' | 'manage',
  ) {
    if (
      !recordType?.trim() ||
      !recordId?.trim() ||
      (await this.options.authorizeRecord({
        ...this.options.actor,
        recordType,
        recordId,
        action,
      })) !== true
    )
      throw new ParticipationDeniedError('Record access denied.');
  }
  protected request(
    recordType: string,
    recordId: string,
    action: 'react' | 'vote',
  ) {
    return {
      tenantId: this.options.actor.tenantId,
      actorUserId: this.options.actor.userId,
      recordType,
      recordId,
      action,
    };
  }
  protected guard(db: SmrtClassOptions['db'] = this.options.db) {
    return new ParticipationService({
      db,
      entitlement: this.options.participation,
      now: this.options.now,
    });
  }
  protected scoped<T>(work: () => Promise<T>) {
    if (!['sqlite', 'postgres'].includes(this.#backend))
      throw new TypeError('Unsupported participation backend.');
    return withTenant({ tenantId: this.options.actor.tenantId }, work);
  }
}

class ReactionService extends ParticipationBoundary {
  /** Explicit desired state is retry-safe; retraction applies only to the authenticated profile. */
  async setReaction(
    recordType: string,
    recordId: string,
    kind: ReactionKind,
    active: boolean,
  ): Promise<void> {
    if (!REACTION_KINDS.includes(kind) || typeof active !== 'boolean')
      throw new TypeError('Invalid reaction.');
    recordId = canonical(recordId);
    recordType =
      (await ObjectRegistry.resolveQualifiedNameAsync(recordType)) ??
      recordType;
    await this.access(recordType, recordId, 'react');
    await this.scoped(async () => {
      const { tenantId, profileId } = this.options.actor;
      const request = this.request(recordType, recordId, 'react');
      // Current bans and entitlement apply even to replay/retraction.
      await this.guard().authorize(request);
      const collection = await ReactionCollection.create({
        db: this.options.db,
      });
      if (!collection.db.transaction)
        throw new Error('Reactions require transactions.');
      await collection.db.transaction(async (tx) => {
        const scoped = await ReactionCollection.create({ db: tx });
        const existing = await scoped.list({
          where: {
            tenantId,
            metaType: recordType,
            metaId: recordId,
            actorProfileId: profileId,
            kind,
          },
        });
        if (!active) {
          await this.guard(tx).authorize(request);
          await tx.query(
            `DELETE FROM ${table(scoped.tableName)} WHERE tenant_id = ? AND meta_type = ? AND meta_id = ? AND actor_profile_id = ? AND kind = ?`,
            tenantId,
            recordType,
            recordId,
            profileId,
            kind,
          );
          return;
        }
        if (existing.length) {
          await this.guard(tx).authorize(request);
          return;
        }
        // Arbitrate identity before reserving quota: a concurrent replay must
        // not commit a reservation for an insert that lost uniqueness.
        const id = crypto.randomUUID();
        const inserted = await tx.query(
          `INSERT INTO ${table(scoped.tableName)} (id, slug, context, role, tenant_id, meta_type, meta_id, actor_profile_id, kind) VALUES (?, ?, '', 'default', ?, ?, ?, ?, ?) ON CONFLICT (tenant_id, meta_type, meta_id, actor_profile_id, kind) DO NOTHING RETURNING id`,
          id,
          id,
          tenantId,
          recordType,
          recordId,
          profileId,
          kind,
        );
        if (inserted.rows.length === 0) {
          await this.guard(tx).authorize(request);
          return;
        }
        // Authorization/reservation failure rolls this candidate insert back
        // with the owned transaction, including any transactional change feed.
        await this.guard(tx).executeInTransaction(
          tx,
          request,
          async () => undefined,
        );
      });
    });
  }
  retract(recordType: string, recordId: string, kind: ReactionKind) {
    return this.setReaction(recordType, recordId, kind, false);
  }
  async tally(recordType: string, recordId: string) {
    recordId = canonical(recordId);
    recordType =
      (await ObjectRegistry.resolveQualifiedNameAsync(recordType)) ??
      recordType;
    await this.access(recordType, recordId, 'read');
    return this.scoped(async () => {
      const collection = await ReactionCollection.create({
        db: this.options.db,
      });
      const where = {
        tenantId: this.options.actor.tenantId,
        metaType: recordType,
        metaId: recordId,
      };
      const own = await collection.list({
        where: { ...where, actorProfileId: this.options.actor.profileId },
      });
      return Promise.all(
        REACTION_KINDS.map(async (kind) => ({
          kind,
          count: await collection.count({ where: { ...where, kind } }),
          selected: own.some((r) => r.kind === kind),
        })),
      );
    });
  }
}

class PollService extends ParticipationBoundary {
  private time() {
    const value = (this.options.now?.() ?? new Date()).getTime();
    if (!Number.isFinite(value)) throw new TypeError('Invalid clock.');
    return value;
  }
  private isClosed(poll: Poll) {
    const now = this.time();
    const opens =
      poll.opensAt === null ? null : new Date(poll.opensAt).getTime();
    const closes =
      poll.closesAt === null ? null : new Date(poll.closesAt).getTime();
    if (
      (opens !== null && !Number.isFinite(opens)) ||
      (closes !== null && !Number.isFinite(closes))
    )
      throw new TypeError('Invalid poll window.');
    return (
      poll.closed ||
      (opens !== null && now < opens) ||
      (closes !== null && now >= closes)
    );
  }
  private async load(
    db: SmrtClassOptions['db'],
    id: string,
    action: 'read' | 'vote' | 'manage',
  ) {
    const poll = await (await PollCollection.create({ db })).get(canonical(id));
    if (!poll?.id || canonical(poll.tenantId) !== this.options.actor.tenantId)
      throw new ParticipationDeniedError('Poll unavailable.');
    await this.access(poll.metaType, poll.metaId, action);
    if (
      !['always', 'after_vote', 'after_close'].includes(poll.visibility) ||
      poll.oneVotePerActor !== true ||
      typeof poll.anonymousTally !== 'boolean'
    )
      throw new TypeError('Invalid poll policy.');
    poll.pollOptions; // Validate stored options before any projection or mutation.
    return poll;
  }
  private async locked<T>(
    pollId: string,
    action: 'vote' | 'manage',
    work: (tx: Database, poll: Poll) => Promise<T>,
  ) {
    return this.scoped(async () => {
      const collection = await PollCollection.create({ db: this.options.db });
      if (!collection.db.transaction)
        throw new Error('Polls require transactions.');
      return collection.db.transaction(async (tx) => {
        const scoped = await PollCollection.create({ db: tx });
        await tx.query(
          `UPDATE ${table(scoped.tableName)} SET closed = closed WHERE id = ? AND tenant_id = ?`,
          canonical(pollId),
          this.options.actor.tenantId,
        );
        return work(tx, await this.load(tx, pollId, action));
      });
    });
  }
  async create(input: CreatePollInput): Promise<Poll> {
    await this.access(input.recordType, input.recordId, 'manage');
    if (
      !input.question?.trim() ||
      !Array.isArray(input.options) ||
      input.options.length < 2 ||
      input.options.length > 50 ||
      input.options.some(
        (o) =>
          !o ||
          typeof o.id !== 'string' ||
          !o.id.trim() ||
          typeof o.label !== 'string' ||
          !o.label.trim(),
      ) ||
      new Set(input.options.map((o) => o.id)).size !== input.options.length
    )
      throw new TypeError('Poll requires a question and 2–50 unique options.');
    if (
      input.visibility !== undefined &&
      !['always', 'after_vote', 'after_close'].includes(input.visibility)
    )
      throw new TypeError('Invalid poll visibility.');
    if (
      input.anonymousTally !== undefined &&
      typeof input.anonymousTally !== 'boolean'
    )
      throw new TypeError('Invalid tally policy.');
    for (const date of [input.opensAt, input.closesAt])
      if (
        date != null &&
        (!(date instanceof Date) || !Number.isFinite(date.getTime()))
      )
        throw new TypeError('Invalid poll window.');
    if (input.opensAt && input.closesAt && input.opensAt >= input.closesAt)
      throw new TypeError('Poll closesAt must follow opensAt.');
    return this.scoped(async () => {
      const collection = await PollCollection.create({ db: this.options.db });
      if (!collection.db.transaction)
        throw new Error('Polls require transactions.');
      return collection.db.transaction((tx) =>
        withParticipationWrite(tx, async () =>
          (await PollCollection.create({ db: tx })).create({
            tenantId: this.options.actor.tenantId,
            metaType: input.recordType,
            metaId: canonical(input.recordId),
            question: input.question.trim(),
            optionsJson: JSON.stringify(
              input.options.map((o) => ({ id: o.id, label: o.label.trim() })),
            ),
            opensAt: input.opensAt ?? null,
            closesAt: input.closesAt ?? null,
            visibility: input.visibility ?? 'always',
            anonymousTally: input.anonymousTally ?? true,
          }),
        ),
      );
    });
  }
  async setClosed(pollId: string, closed: boolean): Promise<void> {
    if (typeof closed !== 'boolean')
      throw new TypeError('Invalid closed state.');
    await this.locked(pollId, 'manage', async (tx, poll) => {
      const collection = await PollCollection.create({ db: tx });
      await tx.query(
        `UPDATE ${table(collection.tableName)} SET closed = ? WHERE id = ? AND tenant_id = ?`,
        closed,
        poll.id,
        this.options.actor.tenantId,
      );
    });
  }
  close(pollId: string) {
    return this.setClosed(pollId, true);
  }
  reopen(pollId: string) {
    return this.setClosed(pollId, false);
  }
  /** Immutable first choice; identical retry reauthorizes but never replaces evidence. */
  async vote(pollId: string, optionId: string): Promise<void> {
    if (typeof optionId !== 'string' || !optionId.trim())
      throw new TypeError('Option required.');
    await this.locked(pollId, 'vote', async (tx, poll) => {
      if (!poll.pollOptions.some((o) => o.id === optionId))
        throw new TypeError('Unknown poll option.');
      const request = this.request(poll.metaType, poll.metaId, 'vote');
      const guard = this.guard(tx);
      await guard.authorize(request);
      const votes = await PollVoteCollection.create({ db: tx });
      const where = {
        tenantId: this.options.actor.tenantId,
        pollId: poll.id ?? pollId,
        actorProfileId: this.options.actor.profileId,
      };
      const [existing] = await votes.list({ where });
      if (existing) {
        if (existing.optionId !== optionId)
          throw new ParticipationDeniedError('Actor already voted.');
        return;
      }
      if (this.isClosed(poll))
        throw new ParticipationDeniedError('Poll is not open.');
      await guard.executeInTransaction(
        tx,
        request,
        async (guarded, decision) => {
          if (
            !decision.snapshot ||
            typeof decision.snapshot !== 'object' ||
            Array.isArray(decision.snapshot)
          )
            throw new ParticipationDeniedError(
              'Participation snapshot required.',
            );
          // Serialize now: subsequent changes to the host object cannot alter retained evidence.
          const snapshot = JSON.stringify(decision.snapshot);
          const retained: unknown = snapshot ? JSON.parse(snapshot) : null;
          if (
            !retained ||
            typeof retained !== 'object' ||
            Array.isArray(retained) ||
            Object.keys(retained).length === 0
          )
            throw new ParticipationDeniedError(
              'Participation snapshot required.',
            );
          await withParticipationWrite(guarded, async () =>
            (await PollVoteCollection.create({ db: guarded })).create({
              ...where,
              optionId,
              participationSnapshot: snapshot,
            }),
          );
        },
      );
    });
  }
  /** Authorized aggregate projection never includes voter IDs or snapshots. */
  async results(pollId: string): Promise<PollProjection> {
    return this.scoped(async () => {
      const poll = await this.load(this.options.db, pollId, 'read');
      const votes = await PollVoteCollection.create({ db: this.options.db });
      const where = { tenantId: this.options.actor.tenantId, pollId: poll.id };
      const [own] = await votes.list({
        where: { ...where, actorProfileId: this.options.actor.profileId },
        limit: 1,
      });
      const selectedOptionId = own?.optionId ?? null;
      const closed = this.isClosed(poll);
      const visible =
        poll.visibility === 'always' ||
        (poll.visibility === 'after_vote' && selectedOptionId !== null) ||
        (poll.visibility === 'after_close' &&
          (poll.closed ||
            (poll.closesAt !== null &&
              this.time() >= new Date(poll.closesAt).getTime())));
      const results = visible
        ? Object.fromEntries(
            await Promise.all(
              poll.pollOptions.map(async (o) => [
                o.id,
                await votes.count({ where: { ...where, optionId: o.id } }),
              ]),
            ),
          )
        : null;
      return {
        id: poll.id ?? pollId,
        question: poll.question,
        options: poll.pollOptions,
        closed,
        selectedOptionId,
        results,
        totalVotes: visible ? await votes.count({ where }) : null,
      };
    });
  }
}

/** One owned connection shared by both services and exposed for host migrations. */
export class ParticipationRuntime {
  readonly #database: DatabaseInterface;
  readonly reactions: ReactionService;
  readonly polls: PollService;
  private constructor(options: RuntimeOptions, token: symbol) {
    if (token !== runtimeToken)
      throw new TypeError('Use ParticipationRuntime.create.');
    this.#database = options.db;
    this.reactions = new ReactionService(options, runtimeToken);
    this.polls = new PollService(options, runtimeToken);
  }
  get database(): DatabaseInterface {
    return this.#database;
  }
  static async create(options: ServiceOptions): Promise<ParticipationRuntime> {
    const config = options?.database;
    const keys = new Set([
      'type',
      'url',
      'cache',
      'dbid',
      'authToken',
      'encryptionKey',
      'transactionQueueTimeout',
      'max',
      'connectionTimeoutMillis',
      'idleTimeoutMillis',
    ]);
    if (
      !config ||
      !['sqlite', 'postgres'].includes(config.type) ||
      typeof config.url !== 'string' ||
      !config.url.trim() ||
      (config.cache !== undefined && config.cache !== false) ||
      Object.keys(config).some((key) => !keys.has(key))
    )
      throw new TypeError(
        'Participation supports owned SQLite/PostgreSQL configurations only; DuckDB is blocked by SDK #1452.',
      );
    if (
      !options.actor ||
      [
        options.actor.tenantId,
        options.actor.userId,
        options.actor.profileId,
      ].some((v) => typeof v !== 'string' || !v.trim()) ||
      typeof options.authorizeRecord !== 'function' ||
      typeof options.participation?.authorize !== 'function'
    )
      throw new TypeError(
        'Trusted actor, record authorizer and participation authorizer are required.',
      );
    const db = await getDatabase({ ...config, cache: false });
    return new ParticipationRuntime(
      { ...options, db, backend: config.type },
      runtimeToken,
    );
  }
}
export type { PollService, ReactionService };
