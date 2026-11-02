import { getTestDatabase } from '@happyvertical/smrt-core';
import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  LearnerAuthorizationError,
  type LearnerAuthorizer,
  LearnerHistoryUnavailableError,
  LearnerValidationError,
  MAX_TUTOR_EXCHANGE_TEXT_CHARS,
  TutorConsentRequiredError,
  type TutorExchange,
  TutorExchangeCollection,
  TutorExchangeError,
  TutorRequestKeyConflictError,
  TutorSessionClosedError,
  TutorSessionClosure,
  TutorSessionCollection,
  TutorSessionService,
} from '../index.js';
import { learnerClasses, learnerFixture } from './learner-workflows.js';

/*
 * Behavior-to-test matrix (TutorSessionService, append-only):
 *  open/append/close/list happy path, ordering, sequence ........ 'lifecycle'
 *  authorizer actions, own flag, executor ....................... 'authorizer'
 *  idempotent open and append, changed replay refused ........... 'idempotency'
 *  closed session refused, close is idempotent .................. 'lifecycle'
 *  text cap/empty/role rules/voice consent ...................... 'validation'
 *  update/delete rejected on all three models ................... 'append-only'
 *  missing tables -> typed unavailable error .................... 'missing tables'
 *  sibling / other tenant / other learner's session ............. 'scoping'
 *  listForLearner scope, pagination, exchange bounds ............ 'listing'
 *  context hash only; no context text stored .................... 'lifecycle'
 */
const classes = [
  ...learnerClasses,
  'TutorSession',
  'TutorSessionClosure',
  'TutorExchange',
];
beforeAll(() => enableTenancy());
afterAll(() => disableTenancy());
const opened: DatabaseInterface[] = [];
afterEach(async () => {
  for (const db of opened.splice(0)) await db.close?.();
});

async function setup(extra = classes) {
  const db = await getTestDatabase({
    type: 'sqlite',
    url: ':memory:',
    classes: extra,
  });
  opened.push(db);
  const f = await learnerFixture(db);
  const calls: Array<Parameters<LearnerAuthorizer>[0]> = [];
  const service = new TutorSessionService(
    db,
    (call) => {
      calls.push(call);
      return call.own || call.relationshipTypeId === f.guardianType.id;
    },
    () => true,
  );
  const enrollmentId = String(f.enrollment.id);
  const lessonId = String(f.lesson.id);
  let n = 0;
  const key = () => `k-${++n}`;
  const open = (extra: Record<string, unknown> = {}) =>
    f.as(f.own, () => service.open({ ...f.own, requestKey: key(), ...extra }));
  const append = (
    sessionId: string,
    extra: Record<string, unknown> = {},
    actor: typeof f.own | typeof f.parent = f.own,
  ) =>
    f.as(actor, () =>
      service.append({
        ...actor,
        sessionId,
        requestKey: key(),
        role: 'learner',
        text: 'What is a numerator?',
        ...extra,
      }),
    );
  return { db, f, calls, service, enrollmentId, lessonId, open, append, key };
}

describe('TutorSessionService', () => {
  it('lifecycle: open, append in order, close, list', async () => {
    const s = await setup();
    const session = await s.open({
      enrollmentId: s.enrollmentId,
      lessonId: s.lessonId,
      contextHash: 'a'.repeat(64),
    });
    expect(session).toMatchObject({
      learnerId: s.f.own.learnerId,
      enrollmentId: s.enrollmentId,
      lessonId: s.lessonId,
      audience: 'learner',
      mode: 'chat',
      contextHash: 'a'.repeat(64),
      closedAt: null,
      changed: true,
      openedByUserId: s.f.own.actorUserId,
    });
    const one = await s.append(session.id);
    const two = await s.append(
      session.id,
      { role: 'tutor', text: 'The top number.', inputTokens: 10 },
      s.f.parent,
    );
    const three = await s.append(session.id, {
      role: 'system',
      text: 'noted',
      marker: 'flagged',
      toolSummary: 'lookup',
    });
    expect([one.sequence, two.sequence, three.sequence]).toEqual([1, 2, 3]);
    expect(one.lessonId).toBe(s.lessonId);
    expect(two).toMatchObject({
      actorUserId: s.f.parent.actorUserId,
      inputTokens: 10,
    });
    expect(three.marker).toBe('flagged');
    const closed = await s.f.as(s.f.own, () =>
      s.service.close({ ...s.f.own, sessionId: session.id }),
    );
    expect(closed.changed).toBe(true);
    expect(closed.closedAt).not.toBeNull();
    const again = await s.f.as(s.f.own, () =>
      s.service.close({ ...s.f.own, sessionId: session.id }),
    );
    expect(again.changed).toBe(false);
    expect(again.closedAt).toBe(closed.closedAt);
    expect(await s.db.list('tutor_session_closures', {})).toHaveLength(1);
    await expect(s.append(session.id)).rejects.toBeInstanceOf(
      TutorSessionClosedError,
    );
    const listed = await s.f.as(s.f.parent, () =>
      s.service.listForLearner({ ...s.f.parent }),
    );
    expect(listed.sessions).toHaveLength(1);
    expect(listed.sessions[0].closedAt).toBe(closed.closedAt);
    expect(listed.sessions[0].exchanges.map((e) => e.sequence)).toEqual([
      1, 2, 3,
    ]);
    expect(listed.sessions[0].exchanges.map((e) => e.role)).toEqual([
      'learner',
      'tutor',
      'system',
    ]);
    // Only ids and a digest are stored on the session, no context text.
    const row = (await s.db.list('tutor_sessions', {}))[0];
    expect(JSON.stringify(row)).not.toContain('Fractions');
  });

  it('authorizer: exchange and read actions, own flag, current executor', async () => {
    const s = await setup();
    const session = await s.open();
    await s.append(session.id, { role: 'tutor' }, s.f.parent);
    await s.f.as(s.f.parent, () => s.service.listForLearner({ ...s.f.parent }));
    const actions = new Set(s.calls.map((c) => `${c.action}:${c.own}`));
    expect(actions).toEqual(
      new Set([
        'education.tutor.exchange:true',
        'education.tutor.exchange:false',
        'education.tutor.read:false',
      ]),
    );
    expect(s.calls.every((c) => c.executor !== undefined)).toBe(true);
    // Denial fails closed on every operation.
    const deny = new TutorSessionService(
      s.db,
      () => false,
      () => true,
    );
    await expect(
      s.f.as(s.f.own, () => deny.open({ ...s.f.own, requestKey: 'x' })),
    ).rejects.toBeInstanceOf(LearnerAuthorizationError);
    await expect(
      s.f.as(s.f.own, () =>
        deny.append({
          ...s.f.own,
          sessionId: session.id,
          requestKey: 'x',
          role: 'learner',
          text: 'hi',
        }),
      ),
    ).rejects.toBeInstanceOf(LearnerAuthorizationError);
    await expect(
      s.f.as(s.f.own, () => deny.close({ ...s.f.own, sessionId: session.id })),
    ).rejects.toBeInstanceOf(LearnerAuthorizationError);
    await expect(
      s.f.as(s.f.own, () => deny.listForLearner({ ...s.f.own })),
    ).rejects.toBeInstanceOf(LearnerAuthorizationError);
    // A transaction asks with the transaction executor.
    const seen: unknown[] = [];
    const watch = new TutorSessionService(
      s.db,
      (call) => {
        seen.push(call.executor);
        return call.own;
      },
      () => true,
    );
    await s.f.as(s.f.own, () =>
      watch.withTransaction((service) =>
        service.open({ ...s.f.own, requestKey: 'tx-1' }),
      ),
    );
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((e) => e !== s.db)).toBe(true);
  });

  it('idempotency: replays return the stored row; changed payloads conflict', async () => {
    const s = await setup();
    const a = await s.open({ requestKey: 'open-1', mode: 'chat' });
    const b = await s.open({ requestKey: 'open-1', mode: 'chat' });
    expect(b.id).toBe(a.id);
    expect(b.changed).toBe(false);
    await expect(
      s.open({
        requestKey: 'open-1',
        audience: 'learner',
        mode: 'voice',
        voiceConsent: true,
      }),
    ).rejects.toBeInstanceOf(TutorRequestKeyConflictError);
    const first = await s.append(a.id, { requestKey: 'ex-1' });
    const replay = await s.append(a.id, { requestKey: 'ex-1' });
    expect(replay).toMatchObject({ id: first.id, sequence: 1, changed: false });
    await expect(
      s.append(a.id, { requestKey: 'ex-1', text: 'different' }),
    ).rejects.toBeInstanceOf(TutorRequestKeyConflictError);
    expect(await s.db.list('tutor_exchanges', {})).toHaveLength(1);
    // The same exchange key in another session is independent.
    const other = await s.open();
    expect((await s.append(other.id, { requestKey: 'ex-1' })).changed).toBe(
      true,
    );
    await expect(s.open({ requestKey: 'bad key!' })).rejects.toBeInstanceOf(
      LearnerValidationError,
    );
  });

  it('validation: text bounds, roles, voice consent, context references', async () => {
    const s = await setup();
    const session = await s.open({
      enrollmentId: s.enrollmentId,
      lessonId: s.lessonId,
    });
    await expect(
      s.append(session.id, {
        text: 'x'.repeat(MAX_TUTOR_EXCHANGE_TEXT_CHARS + 1),
      }),
    ).rejects.toBeInstanceOf(TutorExchangeError);
    await expect(s.append(session.id, { text: '   ' })).rejects.toBeInstanceOf(
      TutorExchangeError,
    );
    expect(
      (
        await s.append(session.id, {
          text: 'x'.repeat(MAX_TUTOR_EXCHANGE_TEXT_CHARS),
        })
      ).sequence,
    ).toBe(1);
    for (const bad of [
      { role: 'robot' },
      { marker: 'weird' },
      { inputTokens: -1 },
      { outputTokens: 1.5 },
      { toolSummary: 'x'.repeat(1001) },
      { lessonId: String(s.f.secondLesson.id) },
    ])
      await expect(s.append(session.id, bad)).rejects.toBeInstanceOf(
        TutorExchangeError,
      );
    await expect(
      s.append(session.id, { questionRevisionId: 'nope' }),
    ).rejects.toBeInstanceOf(LearnerAuthorizationError);
    // A guardian cannot speak as the learner.
    await expect(
      s.append(session.id, { role: 'learner' }, s.f.parent),
    ).rejects.toBeInstanceOf(LearnerAuthorizationError);
    // Voice needs recorded consent.
    await expect(s.open({ mode: 'voice' })).rejects.toBeInstanceOf(
      TutorConsentRequiredError,
    );
    const voice = await s.open({ mode: 'voice', voiceConsent: true });
    expect(voice).toMatchObject({ mode: 'voice', voiceConsent: true });
    // Guardian audience is never the learner's own session.
    await expect(s.open({ audience: 'guardian' })).rejects.toBeInstanceOf(
      LearnerAuthorizationError,
    );
    expect(
      (
        await s.f.as(s.f.parent, () =>
          s.service.open({
            ...s.f.parent,
            requestKey: 'g-1',
            audience: 'guardian',
          }),
        )
      ).audience,
    ).toBe('guardian');
    // Lesson outside the enrollment, lesson without enrollment, bad hash.
    await expect(
      s.open({
        enrollmentId: s.enrollmentId,
        lessonId: String(s.f.wrongLesson.id),
      }),
    ).rejects.toBeInstanceOf(LearnerAuthorizationError);
    await expect(s.open({ lessonId: s.lessonId })).rejects.toBeInstanceOf(
      LearnerValidationError,
    );
    await expect(s.open({ contextHash: 'no' })).rejects.toBeInstanceOf(
      LearnerValidationError,
    );
  });

  it('append-only: stored rows reject update and delete', async () => {
    const s = await setup();
    const session = await s.open();
    const ex = await s.append(session.id);
    await s.f.as(s.f.own, () =>
      s.service.close({ ...s.f.own, sessionId: session.id }),
    );
    await s.f.as(s.f.own, async () => {
      const sessions = await TutorSessionCollection.create({ db: s.db });
      const row = await sessions.get(session.id, { cache: false });
      if (!row) throw new Error('missing');
      row.mode = 'voice';
      await expect(row.save()).rejects.toThrow(/immutable/);
      await expect(row.delete()).rejects.toThrow(/immutable/);
      const exchanges = await TutorExchangeCollection.create({ db: s.db });
      const xr = (await exchanges.get(ex.id, {
        cache: false,
      })) as TutorExchange;
      xr.text = 'edited';
      await expect(xr.save()).rejects.toThrow(/immutable/);
      await expect(xr.delete()).rejects.toThrow(/immutable/);
      const closure = new TutorSessionClosure({
        db: s.db,
        ...(await s.db.list('tutor_session_closures', {}))[0],
      });
      await expect(closure.delete()).rejects.toThrow(/immutable/);
    });
    const stored = (await s.db.list('tutor_exchanges', {}))[0];
    expect(stored.text).toBe('What is a numerator?');
    // A second closure for one session cannot be stored.
    expect(await s.db.list('tutor_session_closures', {})).toHaveLength(1);
  });

  it('missing tables: typed unavailable error on every operation', async () => {
    const s = await setup(learnerClasses);
    for (const call of [
      () => s.service.open({ ...s.f.own, requestKey: 'k' }),
      () =>
        s.service.append({
          ...s.f.own,
          sessionId: 'x',
          requestKey: 'k',
          role: 'learner',
          text: 'hi',
        }),
      () => s.service.close({ ...s.f.own, sessionId: 'x' }),
      () => s.service.listForLearner({ ...s.f.own }),
    ])
      await expect(s.f.as(s.f.own, call)).rejects.toBeInstanceOf(
        LearnerHistoryUnavailableError,
      );
  });

  it('scoping: sibling, other tenant and other learners cannot reach a session', async () => {
    const s = await setup();
    const session = await s.open();
    const sibling = {
      tenantId: s.f.own.tenantId,
      actorUserId: String(s.f.bob.user.id),
      learnerId: String(s.f.sibling.id),
    };
    // Bob's own session is separate and invisible to Alice's reads.
    const bobs = await s.f.as(sibling, () =>
      s.service.open({ ...sibling, requestKey: 'bob-1' }),
    );
    const mine = await s.f.as(s.f.own, () =>
      s.service.listForLearner({ ...s.f.own }),
    );
    expect(mine.sessions.map((x) => x.id)).toEqual([session.id]);
    // Using Bob's session id under Alice's learner id finds nothing.
    await expect(s.append(bobs.id)).rejects.toBeInstanceOf(
      LearnerAuthorizationError,
    );
    await expect(
      s.f.as(s.f.own, () =>
        s.service.close({ ...s.f.own, sessionId: bobs.id }),
      ),
    ).rejects.toBeInstanceOf(LearnerAuthorizationError);
    // Bob cannot act on Alice's learner.
    const crossing = { ...sibling, learnerId: s.f.own.learnerId };
    await expect(
      s.f.as(crossing, () => s.service.listForLearner(crossing)),
    ).rejects.toBeInstanceOf(LearnerAuthorizationError);
    await expect(
      s.f.as(crossing, () =>
        s.service.append({
          ...crossing,
          sessionId: session.id,
          requestKey: 'z',
          role: 'tutor',
          text: 'hi',
        }),
      ),
    ).rejects.toBeInstanceOf(LearnerAuthorizationError);
    // Other tenant.
    const foreign = {
      tenantId: s.f.foreign.tenantId,
      actorUserId: String(s.f.stranger.user.id),
      learnerId: s.f.own.learnerId,
    };
    await expect(
      s.f.as(foreign, () => s.service.listForLearner(foreign)),
    ).rejects.toBeInstanceOf(LearnerAuthorizationError);
  });

  it('listing: newest first, paginated, exchange bounds and filters', async () => {
    const s = await setup();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const created = await s.open(
        i === 1 ? { enrollmentId: s.enrollmentId, lessonId: s.lessonId } : {},
      );
      ids.push(created.id);
      await new Promise((r) => setTimeout(r, 5));
    }
    for (let i = 0; i < 5; i++) await s.append(ids[2]);
    const page1 = await s.f.as(s.f.own, () =>
      s.service.listForLearner({ ...s.f.own, limit: 2, exchangeLimit: 3 }),
    );
    expect(page1.sessions.map((x) => x.id)).toEqual([ids[2], ids[1]]);
    expect(page1.sessions[0].exchanges).toHaveLength(3);
    expect(page1.sessions[0].exchangesTruncated).toBe(true);
    expect(page1.sessions[1].exchangesTruncated).toBe(false);
    expect(page1.nextCursor).toBe(ids[1]);
    const page2 = await s.f.as(s.f.own, () =>
      s.service.listForLearner({
        ...s.f.own,
        limit: 2,
        cursor: page1.nextCursor as string,
      }),
    );
    expect(page2.sessions.map((x) => x.id)).toEqual([ids[0]]);
    expect(page2.nextCursor).toBeNull();
    const rest = await s.f.as(s.f.own, () =>
      s.service.listForLearner({
        ...s.f.own,
        sessionId: ids[2],
        afterSequence: 3,
      }),
    );
    expect(rest.sessions[0].exchanges.map((e) => e.sequence)).toEqual([4, 5]);
    const byLesson = await s.f.as(s.f.own, () =>
      s.service.listForLearner({ ...s.f.own, lessonId: s.lessonId }),
    );
    expect(byLesson.sessions.map((x) => x.id)).toEqual([ids[1]]);
    for (const bad of [
      { limit: 0 },
      { limit: 51 },
      { exchangeLimit: 201 },
      { afterSequence: -1 },
    ])
      await expect(
        s.f.as(s.f.own, () => s.service.listForLearner({ ...s.f.own, ...bad })),
      ).rejects.toBeInstanceOf(LearnerValidationError);
    await expect(
      s.f.as(s.f.own, () =>
        s.service.listForLearner({ ...s.f.own, cursor: 'nope' }),
      ),
    ).rejects.toBeInstanceOf(LearnerValidationError);
  });
  it('guardian-audience sessions are invisible and immutable to the learner', async () => {
    const SENTINEL = 'SENTINEL-GUARDIAN-ANSWER-KEY-5521';
    const s = await setup();
    const guardianSession = await s.f.as(s.f.parent, () =>
      s.service.open({
        ...s.f.parent,
        requestKey: 'g-open',
        audience: 'guardian',
        enrollmentId: s.enrollmentId,
        lessonId: s.lessonId,
      }),
    );
    await s.append(
      guardianSession.id,
      { role: 'tutor', text: `Key: ${SENTINEL}` },
      s.f.parent,
    );
    const learnerSession = await s.open();
    const exchangesBefore = await s.db.list('tutor_exchanges', {});
    const read = (extra: Record<string, unknown> = {}) =>
      s.f.as(s.f.own, () => s.service.listForLearner({ ...s.f.own, ...extra }));
    for (const result of [
      await read(),
      await read({ sessionId: guardianSession.id }),
      await read({ lessonId: s.lessonId }),
      await read({ enrollmentId: s.enrollmentId }),
    ]) {
      expect(JSON.stringify(result)).not.toContain(SENTINEL);
      expect(result.sessions.map((x) => x.id)).not.toContain(
        guardianSession.id,
      );
    }
    expect((await read()).sessions.map((x) => x.id)).toContain(
      learnerSession.id,
    );
    await expect(s.append(guardianSession.id)).rejects.toBeInstanceOf(
      LearnerAuthorizationError,
    );
    await expect(
      s.f.as(s.f.own, () =>
        s.service.close({ ...s.f.own, sessionId: guardianSession.id }),
      ),
    ).rejects.toBeInstanceOf(LearnerAuthorizationError);
    expect(await s.db.list('tutor_exchanges', {})).toHaveLength(
      exchangesBefore.length,
    );
    expect(await s.db.list('tutor_session_closures', {})).toHaveLength(0);
    // The guardian still reads and closes it.
    const guardianView = await s.f.as(s.f.parent, () =>
      s.service.listForLearner({
        ...s.f.parent,
        sessionId: guardianSession.id,
      }),
    );
    expect(JSON.stringify(guardianView)).toContain(SENTINEL);
    await s.f.as(s.f.parent, () =>
      s.service.close({ ...s.f.parent, sessionId: guardianSession.id }),
    );
  });
});
