import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ParticipationBanCollection,
  ParticipationPolicyCollection,
} from '@happyvertical/smrt-comments';
import { ObjectRegistry } from '@happyvertical/smrt-core';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import { withTenant } from '@happyvertical/smrt-tenancy';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PollCollection,
  PollVoteCollection,
  ReactionCollection,
} from './collections/index.js';
import { ParticipationRuntime } from './services.js';
import type {
  ParticipationDatabaseConfig,
  PollVisibility,
  ReactionKind,
  ServiceOptions,
} from './types.js';
import './models/Reaction.js';
import './models/Poll.js';
import { PollVote } from './models/PollVote.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const userId = '22222222-2222-4222-8222-222222222222';
const profileId = '33333333-3333-4333-8333-333333333333';
const recordId = '44444444-4444-4444-8444-444444444444';
const otherTenant = '55555555-5555-4555-8555-555555555555';
const secondProfile = '66666666-6666-4666-8666-666666666666';
const input = {
  recordType: 'app:Article',
  recordId,
  question: 'Next topic?',
  options: [
    { id: 'parks', label: 'Parks' },
    { id: 'roads', label: 'Roads' },
  ],
};
const classes = [
  'Reaction',
  'Poll',
  'PollVote',
  'ParticipationBan',
  'ParticipationPolicy',
  'ParticipationRateBucket',
];
describe.each([
  'sqlite',
  ...(process.env.SMRT_TEST_POSTGRES_URL ? ['postgres' as const] : []),
] as const)('%s reactions and polls', (dialect) => {
  const dbs: Awaited<ReturnType<typeof getTestDatabase>>[] = [];
  let database: ParticipationDatabaseConfig;
  const cleanups: Array<() => Promise<void>> = [];
  beforeEach(async () => {
    if (dialect === 'postgres') {
      const url = process.env.SMRT_TEST_POSTGRES_URL ?? '';
      const owner = await ParticipationRuntime.create({
        database: { type: 'postgres', url },
        actor: { tenantId, userId, profileId },
        authorizeRecord: async () => true,
        participation: { authorize: async () => ({ allowed: true }) },
      });
      const schema = `smrt_reactions_${crypto.randomUUID().replaceAll('-', '')}`;
      await owner.database.query(`CREATE SCHEMA "${schema}"`);
      const scoped = new URL(url);
      scoped.searchParams.set('options', `-c search_path=${schema}`);
      database = { type: 'postgres', url: scoped.href, cache: false };
      cleanups.push(async () => {
        try {
          await owner.database.query(`DROP SCHEMA "${schema}" CASCADE`);
        } finally {
          await owner.database.close?.();
        }
      });
    } else {
      const dir = await mkdtemp(join(tmpdir(), 'smrt-reactions-test-'));
      database = {
        type: 'sqlite',
        url: join(dir, 'test.sqlite'),
        cache: false as const,
      };
      cleanups.push(() => rm(dir, { recursive: true, force: true }));
    }
  });

  afterEach(async () => {
    for (const db of dbs.splice(0)) await db.close?.();
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });
  async function setup() {
    const snapshot = { planKey: 'member', eligibilityRecordDate: '2026-10-23' };
    const options: ServiceOptions = {
      database,
      actor: { tenantId, userId, profileId },
      authorizeRecord: async () => true,
      participation: {
        authorize: async () => ({ allowed: true, member: true, snapshot }),
      },
    };
    const runtime = await ParticipationRuntime.create(options);
    const db = await getTestDatabase({ db: runtime.database, classes });
    dbs.push(db);
    return {
      db,
      options,
      snapshot,
      polls: runtime.polls,
      reactions: runtime.reactions,
    };
  }
  async function makePoll(options: ServiceOptions) {
    const runtime = await ParticipationRuntime.create(options);
    dbs.push(runtime.database);
    return runtime.polls;
  }
  async function makeReaction(options: ServiceOptions) {
    const runtime = await ParticipationRuntime.create(options);
    dbs.push(runtime.database);
    return runtime.reactions;
  }

  if (dialect === 'sqlite')
    it('recovers an invalidated BUSY connection in the same process through a fresh owned runtime', async () => {
      const { db, options, polls } = await setup();
      const poll = await polls.create(input);
      const id = poll.id ?? '';
      const rival = await ParticipationRuntime.create(options);
      const collection = await withTenant({ tenantId }, () =>
        PollCollection.create({ db }),
      );
      if (!db.transaction) throw new Error('Transactions required.');
      try {
        await db.transaction(async (tx) => {
          await tx.query(
            `UPDATE "${collection.tableName}" SET closed = closed WHERE id = ? AND tenant_id = ?`,
            id,
            tenantId,
          );
          await expect(rival.polls.vote(id, 'parks')).rejects.toThrow(
            /SQLITE_BUSY|invalidated/,
          );
        });
        await expect(rival.database.query('SELECT 1')).rejects.toThrow(
          'invalidated',
        );
      } finally {
        await rival.database.close?.();
      }
      const recovered = await ParticipationRuntime.create(options);
      dbs.push(recovered.database);
      expect(recovered.database).not.toBe(rival.database);
      await recovered.polls.vote(id, 'parks');
      await recovered.polls.vote(id, 'parks');
      expect((await recovered.polls.results(id)).totalVotes).toBe(1);
    });
  it('sets unique desired reactions, tallies per actor/target/kind and retracts only own rows', async () => {
    const { options, reactions } = await setup();
    await reactions.setReaction(input.recordType, recordId, 'like', true);
    await reactions.setReaction(input.recordType, recordId, 'like', true);
    await reactions.setReaction(input.recordType, recordId, 'support', true);
    const second = await makeReaction({
      ...options,
      actor: {
        ...options.actor,
        userId: secondProfile,
        profileId: secondProfile,
      },
    });
    await second.setReaction(input.recordType, recordId, 'like', true);
    expect(
      (await reactions.tally(input.recordType, recordId)).find(
        (r) => r.kind === 'like',
      ),
    ).toEqual({ kind: 'like', count: 2, selected: true });
    await reactions.retract(input.recordType, recordId, 'like');
    await reactions.retract(input.recordType, recordId, 'like');
    expect(
      (await reactions.tally(input.recordType, recordId)).find(
        (r) => r.kind === 'like',
      ),
    ).toEqual({ kind: 'like', count: 1, selected: false });
    expect(
      (await reactions.tally(input.recordType, crypto.randomUUID())).every(
        (r) => r.count === 0,
      ),
    ).toBe(true);
    const foreign = await makeReaction({
      ...options,
      actor: { ...options.actor, tenantId: otherTenant },
    });
    expect(
      (await foreign.tally(input.recordType, recordId)).every(
        (r) => r.count === 0,
      ),
    ).toBe(true);
  });
  it('retains one choice and immutable snapshot through retry, close and reopen', async () => {
    const { db, options, polls, snapshot } = await setup();
    const poll = await polls.create({ ...input, visibility: 'after_vote' });
    const id = poll.id ?? '';
    expect((await polls.results(id)).results).toBeNull();
    await polls.vote(id, 'parks');
    snapshot.planKey = 'former';
    await polls.vote(id, 'parks');
    await expect(polls.vote(id, 'roads')).rejects.toThrow('already voted');
    expect((await polls.results(id)).results).toEqual({ parks: 1, roads: 0 });
    const rows = await withTenant({ tenantId }, async () =>
      (await PollVoteCollection.create({ db })).list({ where: { pollId: id } }),
    );
    expect(JSON.parse(rows[0].participationSnapshot).planKey).toBe('member');
    await polls.close(id);
    await polls.vote(id, 'parks');
    const second = await makePoll({
      ...options,
      actor: {
        ...options.actor,
        userId: secondProfile,
        profileId: secondProfile,
      },
    });
    await expect(second.vote(id, 'roads')).rejects.toThrow('not open');
    await polls.reopen(id);
    await second.vote(id, 'roads');
    expect((await polls.results(id)).totalVotes).toBe(2);
    expect(JSON.stringify(await polls.results(id))).not.toContain(profileId);
  });
  it('rejects direct changes to retained vote evidence and poll options', async () => {
    const { db, polls } = await setup();
    const poll = await polls.create(input);
    const id = poll.id ?? '';
    await polls.vote(id, 'parks');
    await withTenant({ tenantId }, async () => {
      const [vote] = await (await PollVoteCollection.create({ db })).list({
        where: { pollId: id },
      });
      const votes = await PollVoteCollection.create({ db });
      await expect(votes.delete(vote.id ?? '')).rejects.toThrow(
        'service write authority',
      );
      await expect(
        (await ReactionCollection.create({ db })).create({
          tenantId,
          metaType: input.recordType,
          metaId: recordId,
          actorProfileId: profileId,
          kind: 'like',
        }),
      ).rejects.toThrow('service write authority');
      await expect(
        (await PollCollection.create({ db })).create({
          tenantId,
          metaType: input.recordType,
          metaId: recordId,
          question: 'Bypass',
          optionsJson: JSON.stringify(input.options),
        }),
      ).rejects.toThrow('service write authority');
      vote.participationSnapshot = JSON.stringify({ planKey: 'tampered' });
      await expect(vote.save()).rejects.toThrow('service write authority');
      const current = await (await PollCollection.create({ db })).get(id);
      if (!current) throw new Error('missing poll');
      current.optionsJson = JSON.stringify([
        { id: 'changed', label: 'Changed' },
        input.options[1],
      ]);
      await expect(current.save()).rejects.toThrow('service write authority');
    });
    expect((await polls.results(id)).results).toEqual({ parks: 1, roads: 0 });
  });
  it('rolls back quota on a persistence failure and permits the same retry', async () => {
    const { db, polls } = await setup();
    await withTenant({ tenantId }, async () =>
      (await ParticipationPolicyCollection.create({ db })).create({
        tenantId,
        action: 'vote',
        maxActions: 1,
        windowSeconds: 60,
      }),
    );
    const poll = await polls.create(input);
    const id = poll.id ?? '';
    const failure = vi
      .spyOn(PollVote.prototype, 'save')
      .mockRejectedValueOnce(new Error('storage failure'));
    try {
      await expect(polls.vote(id, 'parks')).rejects.toThrow('storage failure');
    } finally {
      failure.mockRestore();
    }
    expect((await polls.results(id)).totalVotes).toBe(0);
    await polls.vote(id, 'parks');
    expect((await polls.results(id)).totalVotes).toBe(1);
  });
  if (dialect === 'postgres')
    it('arbitrates concurrent service instances, preserving one actor vote and reaction', async () => {
      const { options, polls, reactions } = await setup();
      const second = await makePoll(options);
      const poll = await polls.create(input);
      const id = poll.id ?? '';
      const votes = await Promise.allSettled([
        polls.vote(id, 'parks'),
        second.vote(id, 'parks'),
      ]);
      expect(
        votes.some((v) => v.status === 'fulfilled'),
        votes
          .map((v) =>
            v.status === 'rejected' ? String(v.reason?.message) : 'committed',
          )
          .join('; '),
      ).toBe(true);
      await second.vote(id, 'parks');
      expect((await polls.results(id)).totalVotes).toBe(1);
      const other = await makeReaction(options);
      await Promise.allSettled([
        reactions.setReaction(input.recordType, recordId, 'like', true),
        other.setReaction(input.recordType, recordId, 'like', true),
      ]);
      await other.setReaction(input.recordType, recordId, 'like', true);
      expect(
        (await reactions.tally(input.recordType, recordId)).find(
          (r) => r.kind === 'like',
        )?.count,
      ).toBe(1);
    });
  it('arbitrates independent sessions for unique votes/reactions and close versus vote', async () => {
    if (dialect === 'sqlite') {
      await sqliteProcessRace();
      return;
    }
    const dir = await mkdtemp(join(tmpdir(), 'smrt-reactions-'));
    const config = database;
    const base = {
      database: config,
      actor: { tenantId, userId, profileId },
      authorizeRecord: async () => true,
      participation: {
        authorize: async () => ({
          allowed: true,
          snapshot: { planKey: 'member' },
        }),
      },
    };
    let left = await ParticipationRuntime.create(base);
    await getTestDatabase({ db: left.database, classes });
    let right = await ParticipationRuntime.create(base);
    expect(left.database).not.toBe(right.database);
    async function reconnect() {
      await left.database.close?.();
      await right.database.close?.();
      left = await ParticipationRuntime.create(base);
      right = await ParticipationRuntime.create(base);
    }
    try {
      const poll = await left.polls.create(input);
      const id = poll.id ?? '';
      const raced = await Promise.allSettled([
        left.polls.vote(id, 'parks'),
        right.polls.vote(id, 'parks'),
      ]);
      expect(
        raced.some((r) => r.status === 'fulfilled'),
        raced
          .map((v) =>
            v.status === 'rejected' ? String(v.reason?.message) : 'committed',
          )
          .join('; '),
      ).toBe(true);
      await reconnect();
      await right.polls.vote(id, 'parks');
      expect((await left.polls.results(id)).totalVotes).toBe(1);
      const target = crypto.randomUUID();
      await Promise.allSettled([
        left.reactions.setReaction(input.recordType, target, 'like', true),
        right.reactions.setReaction(input.recordType, target, 'like', true),
      ]);
      await reconnect();
      await right.reactions.setReaction(input.recordType, target, 'like', true);
      expect(
        (await left.reactions.tally(input.recordType, target)).find(
          (r) => r.kind === 'like',
        )?.count,
      ).toBe(1);
      const closing = await left.polls.create(input);
      const closingId = closing.id ?? '';
      await Promise.allSettled([
        left.polls.vote(closingId, 'parks'),
        right.polls.close(closingId),
      ]);
      await reconnect();
      await right.polls.close(closingId);
      expect((await left.polls.results(closingId)).closed).toBe(true);
      expect(
        (await left.polls.results(closingId)).totalVotes,
      ).toBeLessThanOrEqual(1);
      const fresh = await ParticipationRuntime.create({
        ...base,
        actor: { ...base.actor, profileId: secondProfile },
      });
      try {
        await expect(fresh.polls.vote(closingId, 'roads')).rejects.toThrow(
          'not open',
        );
      } finally {
        await fresh.database.close?.();
      }
    } finally {
      await left.database.close?.();
      await right.database.close?.();
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('uses exact shared ban expiry/rate boundaries and rejects unknown stored policy', async () => {
    const { db, options, polls } = await setup();
    let now = new Date('2026-10-23T12:00:59.999Z');
    const service = await makeReaction({ ...options, now: () => now });
    await withTenant({ tenantId }, async () => {
      await (await ParticipationBanCollection.create({ db })).create({
        tenantId,
        actorUserId: userId,
        reason: 'short ban',
        expiresAt: new Date('2026-10-23T12:01:00Z'),
      });
      await (await ParticipationPolicyCollection.create({ db })).create({
        tenantId,
        action: 'react',
        maxActions: 1,
        windowSeconds: 60,
      });
    });
    await expect(
      service.setReaction(input.recordType, recordId, 'like', true),
    ).rejects.toThrow('banned');
    now = new Date('2026-10-23T12:01:00Z');
    await service.setReaction(input.recordType, recordId, 'like', true);
    now = new Date('2026-10-23T12:01:59.999Z');
    await expect(
      service.setReaction(input.recordType, recordId, 'love', true),
    ).rejects.toThrow('Rate limit');
    now = new Date('2026-10-23T12:02:00Z');
    await service.setReaction(input.recordType, recordId, 'love', true);
    await withTenant({ tenantId }, async () => {
      const policies = await ParticipationPolicyCollection.create({ db });
      await db.query(
        `UPDATE "${policies.tableName}" SET moderation_mode = ? WHERE tenant_id = ?`,
        'future-policy',
        tenantId,
      );
    });
    await expect(
      service.setReaction(input.recordType, recordId, 'celebrate', true),
    ).rejects.toThrow('Invalid participation policy');
    const poll = await polls.create(input);
    const denied = await makePoll({
      ...options,
      participation: {
        authorize: async () => ({ allowed: false, reason: 'inactive' }),
      },
    });
    await expect(denied.vote(poll.id ?? '', 'parks')).rejects.toThrow(
      'inactive',
    );
  });
  it('uses inclusive opens and exclusive closes; reopening does not override dates or leak pre-open results', async () => {
    const { options, polls } = await setup();
    let now = new Date('2026-10-23T12:00:00Z');
    const service = await makePoll({ ...options, now: () => now });
    const poll = await polls.create({
      ...input,
      opensAt: new Date('2026-10-23T12:01:00Z'),
      closesAt: new Date('2026-10-23T12:02:00Z'),
      visibility: 'after_close',
    });
    const id = poll.id ?? '';
    await expect(service.vote(id, 'parks')).rejects.toThrow('not open');
    expect((await service.results(id)).results).toBeNull();
    now = new Date('2026-10-23T12:01:00Z');
    await service.vote(id, 'parks');
    now = new Date('2026-10-23T12:02:00Z');
    const second = await makePoll({
      ...options,
      actor: { ...options.actor, profileId: secondProfile },
      now: () => now,
    });
    await service.reopen(id);
    await expect(second.vote(id, 'roads')).rejects.toThrow('not open');
    expect((await service.results(id)).results).toEqual({ parks: 1, roads: 0 });
  });
  it('fails closed for actor/context/ownership, unknown enum/options and upstream failure', async () => {
    const { options, polls, reactions } = await setup();
    await expect(
      makePoll({ ...options, actor: { ...options.actor, userId: '' } }),
    ).rejects.toThrow('Trusted actor');
    const poll = await polls.create(input);
    const id = poll.id ?? '';
    for (const actor of [
      { ...options.actor, tenantId: otherTenant },
      { ...options.actor, userId: secondProfile },
    ]) {
      const denied = await makePoll({
        ...options,
        actor,
        authorizeRecord: async (access) =>
          access.userId === userId && access.tenantId === tenantId,
      });
      await expect(denied.vote(id, 'parks')).rejects.toThrow();
      await expect(denied.close(id)).rejects.toThrow();
    }
    const deny = await makeReaction({
      ...options,
      authorizeRecord: async () => false,
    });
    await expect(
      deny.setReaction(input.recordType, recordId, 'like', true),
    ).rejects.toThrow('denied');
    await expect(
      reactions.setReaction(
        input.recordType,
        recordId,
        'unknown' as ReactionKind,
        true,
      ),
    ).rejects.toThrow('Invalid reaction');
    await expect(polls.vote(id, 'unknown')).rejects.toThrow(
      'Unknown poll option',
    );
    await expect(
      polls.create({ ...input, visibility: 'unknown' as PollVisibility }),
    ).rejects.toThrow('visibility');
    await expect(
      polls.create({ ...input, options: [input.options[0], input.options[0]] }),
    ).rejects.toThrow('unique');
    await expect(
      polls.create({ ...input, opensAt: new Date('invalid') }),
    ).rejects.toThrow('window');
    const offline = await makePoll({
      ...options,
      participation: {
        authorize: async () => {
          throw new Error('offline');
        },
      },
    });
    await expect(offline.vote(id, 'parks')).rejects.toThrow('offline');
    const missing = await makePoll({
      ...options,
      participation: { authorize: async () => ({ allowed: true }) },
    });
    await expect(missing.vote(id, 'parks')).rejects.toThrow('snapshot');
    expect((await polls.results(id)).totalVotes).toBe(0);
  });
  it('shares ban and quota storage; rejected snapshot rolls back quota and retries successfully', async () => {
    const { db, options, polls, reactions } = await setup();
    await withTenant({ tenantId }, async () => {
      const policies = await ParticipationPolicyCollection.create({ db });
      await policies.create({
        tenantId,
        action: 'vote',
        moderationMode: 'members_only',
        maxActions: 1,
        windowSeconds: 60,
      });
      await policies.create({
        tenantId,
        action: 'react',
        maxActions: 1,
        windowSeconds: 60,
      });
    });
    const poll = await polls.create(input);
    const id = poll.id ?? '';
    const missing = await makePoll({
      ...options,
      participation: {
        authorize: async () => ({ allowed: true, member: true }),
      },
    });
    await expect(missing.vote(id, 'parks')).rejects.toThrow('snapshot');
    await polls.vote(id, 'parks');
    await polls.vote(id, 'parks');
    const next = await polls.create(input);
    await expect(polls.vote(next.id ?? '', 'parks')).rejects.toThrow(
      'Rate limit',
    );
    await reactions.setReaction(input.recordType, recordId, 'like', true);
    await reactions.setReaction(input.recordType, recordId, 'like', true);
    await expect(
      reactions.setReaction(input.recordType, recordId, 'love', true),
    ).rejects.toThrow('Rate limit');
    await withTenant({ tenantId }, async () =>
      (await ParticipationBanCollection.create({ db })).create({
        tenantId,
        actorUserId: userId,
        reason: 'ban',
      }),
    );
    await expect(polls.vote(id, 'parks')).rejects.toThrow('banned');
    await expect(
      reactions.retract(input.recordType, recordId, 'like'),
    ).rejects.toThrow('banned');
  });
});

it('disables generated mutations on every participation model', () => {
  for (const model of ['Reaction', 'Poll', 'PollVote']) {
    const config = ObjectRegistry.getConfig(
      `@happyvertical/smrt-reactions:${model}`,
    );
    expect(config.api).toBe(false);
    expect(config.cli).toBe(false);
    expect(config.mcp).toBe(false);
  }
});
it.each([
  'duckdb',
  'json',
  'pglite',
  'future',
])('refuses %s before opening or authorizing anything', async (type) => {
  const authorizeRecord = vi.fn();
  const authorize = vi.fn();
  const dir = await mkdtemp(join(tmpdir(), 'smrt-reactions-denied-'));
  const url = join(dir, 'must-not-exist.db');
  try {
    await expect(
      ParticipationRuntime.create({
        // @ts-expect-error Unsupported runtime configuration is rejected at runtime too.
        database: { type, url },
        actor: { tenantId, userId, profileId },
        authorizeRecord,
        participation: { authorize },
      }),
    ).rejects.toThrow('SQLite/PostgreSQL');
    expect(authorizeRecord).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalled();
    expect(
      await import('node:fs/promises').then((fs) => fs.readdir(dir)),
    ).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function sqliteProcessRace() {
  const dir = await mkdtemp(join(tmpdir(), 'smrt-reactions-process-'));
  const database = {
    type: 'sqlite' as const,
    url: join(dir, 'race.sqlite'),
    cache: false as const,
  };
  const options: ServiceOptions = {
    database,
    actor: { tenantId, userId, profileId },
    authorizeRecord: async () => true,
    participation: {
      authorize: async () => ({
        allowed: true,
        snapshot: { planKey: 'member' },
      }),
    },
  };
  let runtime = await ParticipationRuntime.create(options);
  const worker = String.raw`
    import { once } from 'node:events';
    const { ParticipationRuntime } = await import(process.argv[1]);
    const args = JSON.parse(process.argv[2]);
    const runtime = await ParticipationRuntime.create({ database: args.database, actor: args.actor, authorizeRecord: async () => true, participation: { authorize: async () => ({ allowed: true, snapshot: { planKey: 'member' } }) } });
    process.stdout.write('RACE_READY\n');
    await once(process.stdin, 'data');
    try {
      if (args.operation === 'vote') await runtime.polls.vote(args.id, 'parks');
      else if (args.operation === 'close') await runtime.polls.close(args.id);
      else await runtime.reactions.setReaction('app:Article', args.id, 'like', true);
    } catch (error) { process.stderr.write(error.message); process.exitCode = 1; }
    finally { await runtime.database.close?.(); }
  `;
  async function race(operations: Array<{ operation: string; id: string }>) {
    const children = operations.map((op) => {
      const child = spawn(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          worker,
          pathToFileURL(resolve('dist/server.js')).href,
          JSON.stringify({ ...op, database, actor: options.actor }),
        ],
        { stdio: ['pipe', 'pipe', 'pipe'] },
      );
      let stderr = '';
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk);
      });
      const done = new Promise<number | null>((yes, no) => {
        child.on('error', no);
        child.on('exit', yes);
      });
      const ready = new Promise<void>((yes, no) => {
        child.stdout.on('data', (chunk) => {
          if (String(chunk).includes('RACE_READY')) yes();
        });
        child.on('error', no);
        child.on('exit', (code) =>
          no(new Error(`Race child exited before ready (${code}): ${stderr}`)),
        );
      });
      return { child, done, ready, error: () => stderr };
    });
    await Promise.all(children.map((c) => c.ready));
    for (const c of children) c.child.stdin.end('go\n');
    const codes = await Promise.all(children.map((c) => c.done));
    for (const [index, code] of codes.entries()) {
      expect([0, 1]).toContain(code);
      if (code !== 0) expect(children[index].error()).toContain('SQLITE_BUSY');
    }
    return codes;
  }
  try {
    await getTestDatabase({ db: runtime.database, classes });
    const poll = await runtime.polls.create(input);
    const id = poll.id ?? '';
    await runtime.database.close?.();
    await race([
      { operation: 'vote', id },
      { operation: 'vote', id },
    ]);
    runtime = await ParticipationRuntime.create(options);
    expect((await runtime.polls.results(id)).totalVotes).toBeLessThanOrEqual(1);
    await runtime.polls.vote(id, 'parks');
    await runtime.polls.vote(id, 'parks');
    expect((await runtime.polls.results(id)).totalVotes).toBe(1);
    const target = crypto.randomUUID();
    await runtime.database.close?.();
    await race([
      { operation: 'react', id: target },
      { operation: 'react', id: target },
    ]);
    runtime = await ParticipationRuntime.create(options);
    expect(
      (await runtime.reactions.tally(input.recordType, target)).find(
        (r) => r.kind === 'like',
      )?.count,
    ).toBeLessThanOrEqual(1);
    await runtime.reactions.setReaction(input.recordType, target, 'like', true);
    await runtime.reactions.setReaction(input.recordType, target, 'like', true);
    expect(
      (await runtime.reactions.tally(input.recordType, target)).find(
        (r) => r.kind === 'like',
      )?.count,
    ).toBe(1);
    const closing = await runtime.polls.create(input);
    const closingId = closing.id ?? '';
    await runtime.database.close?.();
    await race([
      { operation: 'vote', id: closingId },
      { operation: 'close', id: closingId },
    ]);
    runtime = await ParticipationRuntime.create(options);
    await runtime.polls.close(closingId);
    expect((await runtime.polls.results(closingId)).closed).toBe(true);
    expect(
      (await runtime.polls.results(closingId)).totalVotes,
    ).toBeLessThanOrEqual(1);
  } finally {
    await runtime.database.close?.();
    await rm(dir, { recursive: true, force: true });
  }
}

it('refuses adapter-shaped connection configurations without opening a database', async () => {
  const query = vi.fn();
  const dir = await mkdtemp(join(tmpdir(), 'smrt-reactions-adapter-'));
  const database = { type: 'sqlite' as const, url: join(dir, 'no.db'), query };
  try {
    await expect(
      ParticipationRuntime.create({
        database,
        actor: { tenantId, userId, profileId },
        authorizeRecord: async () => true,
        participation: { authorize: async () => ({ allowed: true }) },
      }),
    ).rejects.toThrow('owned SQLite/PostgreSQL');
    expect(query).not.toHaveBeenCalled();
    expect(
      await import('node:fs/promises').then((fs) => fs.readdir(dir)),
    ).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
