import type { DatabaseInterface } from '@happyvertical/sql';
import { groupSharingDigest } from './group-sharing-hash.js';
import {
  LearnerAuthorizationError,
  LearnerHistoryUnavailableError,
  type LearnerRequest,
  LearnerService,
  LearnerValidationError,
} from './learner-service.js';
import { canonical } from './question-render.js';
import {
  DEFAULT_TUTOR_EXCHANGE_PAGE,
  DEFAULT_TUTOR_SESSION_PAGE,
  MAX_TUTOR_EXCHANGE_PAGE,
  MAX_TUTOR_EXCHANGE_TEXT_CHARS,
  MAX_TUTOR_SESSION_PAGE,
  MAX_TUTOR_TOOL_SUMMARY_CHARS,
  TUTOR_AUDIENCES,
  TUTOR_EXCHANGE_MARKERS,
  TUTOR_EXCHANGE_ROLES,
  TUTOR_SESSION_MODES,
  type TutorAudience,
  TutorConsentRequiredError,
  TutorExchangeError,
  type TutorExchangeMarker,
  type TutorExchangeRole,
  TutorRequestKeyConflictError,
  TutorSessionClosedError,
  type TutorSessionMode,
} from './tutor-contracts.js';
import {
  TutorExchangeCollection,
  TutorSessionClosureCollection,
  TutorSessionCollection,
} from './tutor-models.js';

type Row = Record<string, unknown>;
const KEY = /^[A-Za-z0-9._:@/-]{1,200}$/;
const HASH = /^[A-Za-z0-9_-]{8,128}$/;
const TABLES = ['tutor_sessions', 'tutor_session_closures', 'tutor_exchanges'];

export type TutorExchangeView = Readonly<{
  id: string;
  sessionId: string;
  sequence: number;
  role: TutorExchangeRole;
  text: string;
  actorUserId: string;
  lessonId: string | null;
  questionRevisionId: string | null;
  marker: TutorExchangeMarker;
  toolSummary: string;
  inputTokens: number;
  outputTokens: number;
  recordedAt: string;
}>;
export type TutorSessionView = Readonly<{
  id: string;
  learnerId: string;
  enrollmentId: string | null;
  lessonId: string | null;
  audience: TutorAudience;
  mode: TutorSessionMode;
  voiceConsent: boolean;
  openedByUserId: string;
  /** Digest of the context the tutor was given; never the context itself. */
  contextHash: string | null;
  openedAt: string;
  closedAt: string | null;
}>;
export type TutorSessionWithExchanges = TutorSessionView &
  Readonly<{
    exchanges: ReadonlyArray<TutorExchangeView>;
    /** True when more exchanges exist after the returned ones. */
    exchangesTruncated: boolean;
  }>;

export type OpenTutorSessionRequest = LearnerRequest & {
  requestKey: string;
  audience?: TutorAudience;
  mode?: TutorSessionMode;
  /** The host's recorded voice consent for this learner; required for voice. */
  voiceConsent?: boolean;
  enrollmentId?: string;
  lessonId?: string;
  /** `TutorContext.contextHash` of the context given to the tutor. */
  contextHash?: string;
};
export type AppendTutorExchangeRequest = LearnerRequest & {
  sessionId: string;
  requestKey: string;
  role: TutorExchangeRole;
  text: string;
  lessonId?: string;
  questionRevisionId?: string;
  marker?: TutorExchangeMarker;
  toolSummary?: string;
  inputTokens?: number;
  outputTokens?: number;
};
export type ListTutorSessionsRequest = LearnerRequest & {
  enrollmentId?: string;
  lessonId?: string;
  /** Restrict to one session and page its exchanges with `afterSequence`. */
  sessionId?: string;
  afterSequence?: number;
  limit?: number;
  cursor?: string;
  exchangeLimit?: number;
};

const iso = (value: unknown) => new Date(value as string | Date).toISOString();
const orNull = (value: unknown) =>
  value === null || value === undefined || value === '' ? null : String(value);

function sessionView(row: Row, closedAt: unknown): TutorSessionView {
  return {
    id: String(row.id),
    learnerId: String(row.learner_id),
    enrollmentId: orNull(row.enrollment_id),
    lessonId: orNull(row.lesson_id),
    audience: String(row.audience) as TutorAudience,
    mode: String(row.mode) as TutorSessionMode,
    voiceConsent: row.voice_consent === true || Number(row.voice_consent) === 1,
    openedByUserId: String(row.opened_by_user_id),
    contextHash: orNull(row.context_hash),
    openedAt: iso(row.opened_at),
    closedAt: closedAt ? iso(closedAt) : null,
  };
}
function exchangeView(row: Row): TutorExchangeView {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    sequence: Number(row.sequence),
    role: String(row.role) as TutorExchangeRole,
    text: String(row.text),
    actorUserId: String(row.actor_user_id),
    lessonId: orNull(row.lesson_id),
    questionRevisionId: orNull(row.question_revision_id),
    marker: String(row.marker) as TutorExchangeMarker,
    toolSummary: String(row.tool_summary ?? ''),
    inputTokens: Number(row.input_tokens ?? 0),
    outputTokens: Number(row.output_tokens ?? 0),
    recordedAt: iso(row.recorded_at),
  };
}
function key(value: unknown): string {
  if (typeof value !== 'string' || !KEY.test(value))
    throw new LearnerValidationError('A valid request key is required');
  return value;
}
function count(value: unknown, name: string): number {
  const n = value ?? 0;
  if (!Number.isSafeInteger(n) || (n as number) < 0)
    throw new TutorExchangeError(`Invalid ${name}`);
  return n as number;
}

/**
 * Append-only tutor transcripts. No AI call happens here: the host owns the
 * model call and the spend ceiling, and records what was said. Actions:
 * `education.tutor.exchange` (open, append, close) and `education.tutor.read`
 * (listForLearner), decided by the host authorizer with the same actor, tenant
 * and guardian-relationship checks as `LearnerService`.
 */
export class TutorSessionService extends LearnerService {
  protected override createTransactionService(db: DatabaseInterface): this {
    return new TutorSessionService(
      db,
      this.authorize,
      this.authorizeCatalog,
    ) as this;
  }

  private async requireTables(db: DatabaseInterface) {
    for (const table of TABLES)
      if (!(await db.tableExists(table)))
        throw new LearnerHistoryUnavailableError(table);
  }

  private async session(request: LearnerRequest, sessionId: string) {
    if (typeof sessionId !== 'string' || !sessionId)
      throw new LearnerAuthorizationError();
    const row = (await this.db.get('tutor_sessions', {
      id: sessionId,
      tenant_id: request.tenantId,
      learner_id: request.learnerId,
    })) as Row | null;
    if (!row) throw new LearnerAuthorizationError();
    return row;
  }

  private async closure(request: LearnerRequest, sessionId: string) {
    return (await this.db.get('tutor_session_closures', {
      tenant_id: request.tenantId,
      session_id: sessionId,
    })) as Row | null;
  }

  /** Opens a session; a replay of the same request key returns the same one. */
  async open(
    request: OpenTutorSessionRequest,
  ): Promise<TutorSessionView & { changed: boolean }> {
    return this.mutate(async (service) => {
      await service.requireTables(service.db);
      const requestKey = key(request.requestKey);
      const audience = request.audience ?? 'learner';
      const mode = request.mode ?? 'chat';
      if (
        !TUTOR_AUDIENCES.includes(audience) ||
        !TUTOR_SESSION_MODES.includes(mode)
      )
        throw new LearnerValidationError('Invalid tutor session');
      if (mode === 'voice' && request.voiceConsent !== true)
        throw new TutorConsentRequiredError();
      if (request.lessonId && !request.enrollmentId)
        throw new LearnerValidationError('A tutor lesson needs its enrollment');
      if (request.contextHash !== undefined && !HASH.test(request.contextHash))
        throw new LearnerValidationError('Invalid tutor context hash');
      const learner = await service.requireActor(
        request,
        'education.tutor.exchange',
      );
      if (audience === 'guardian' && learner.userId === request.actorUserId)
        throw new LearnerAuthorizationError();
      if (request.enrollmentId) {
        const enrollment = await service.requireEnrollment(
          request as LearnerRequest & { enrollmentId: string },
          'education.tutor.exchange',
        );
        if (
          request.lessonId &&
          !(await service.lessonInScope(request, enrollment, request.lessonId))
        )
          throw new LearnerAuthorizationError();
      }
      const requestDigest = groupSharingDigest(
        canonical({
          audience,
          mode,
          voiceConsent: mode === 'voice',
          enrollmentId: request.enrollmentId ?? null,
          lessonId: request.lessonId ?? null,
          contextHash: request.contextHash ?? null,
        }),
      );
      const existing = (await service.db.get('tutor_sessions', {
        tenant_id: request.tenantId,
        learner_id: request.learnerId,
        request_key: requestKey,
      })) as Row | null;
      if (existing) {
        if (existing.request_digest !== requestDigest)
          throw new TutorRequestKeyConflictError();
        const closed = await service.closure(request, String(existing.id));
        return { ...sessionView(existing, closed?.closed_at), changed: false };
      }
      const created = await (
        await TutorSessionCollection.create({ db: service.db })
      ).create({
        tenantId: request.tenantId,
        learnerId: request.learnerId,
        enrollmentId: request.enrollmentId ?? null,
        lessonId: request.lessonId ?? null,
        audience,
        mode,
        voiceConsent: mode === 'voice',
        openedByUserId: request.actorUserId,
        requestKey,
        requestDigest,
        contextHash: request.contextHash ?? null,
        openedAt: new Date(),
      });
      const row = (await service.db.get('tutor_sessions', {
        id: String(created.id),
        tenant_id: request.tenantId,
      })) as Row;
      return { ...sessionView(row, null), changed: true };
    });
  }

  /**
   * Appends one exchange. `role: 'learner'` is accepted only from the learner
   * themself; a guardian may append `tutor` or `system` rows. Text must be
   * non-empty and at most `MAX_TUTOR_EXCHANGE_TEXT_CHARS`. A replay of a
   * request key returns the stored row; an append to a closed session is
   * refused with `TutorSessionClosedError`.
   */
  async append(
    request: AppendTutorExchangeRequest,
  ): Promise<TutorExchangeView & { changed: boolean }> {
    return this.mutate(async (service) => {
      await service.requireTables(service.db);
      const requestKey = key(request.requestKey);
      if (!TUTOR_EXCHANGE_ROLES.includes(request.role))
        throw new TutorExchangeError('Invalid tutor exchange role');
      const marker = request.marker ?? 'none';
      if (!TUTOR_EXCHANGE_MARKERS.includes(marker))
        throw new TutorExchangeError('Invalid tutor exchange marker');
      if (
        typeof request.text !== 'string' ||
        !request.text.trim() ||
        request.text.length > MAX_TUTOR_EXCHANGE_TEXT_CHARS
      )
        throw new TutorExchangeError(
          `Tutor exchange text must be 1 to ${MAX_TUTOR_EXCHANGE_TEXT_CHARS} characters`,
        );
      const toolSummary = request.toolSummary ?? '';
      if (
        typeof toolSummary !== 'string' ||
        toolSummary.length > MAX_TUTOR_TOOL_SUMMARY_CHARS
      )
        throw new TutorExchangeError('Invalid tutor tool summary');
      const inputTokens = count(request.inputTokens, 'input tokens');
      const outputTokens = count(request.outputTokens, 'output tokens');
      const learner = await service.requireActor(
        request,
        'education.tutor.exchange',
      );
      if (request.role === 'learner' && learner.userId !== request.actorUserId)
        throw new LearnerAuthorizationError();
      const session = await service.session(request, request.sessionId);
      if (
        String(session.audience) === 'guardian' &&
        learner.userId === request.actorUserId
      )
        throw new LearnerAuthorizationError();
      if (
        request.lessonId !== undefined &&
        request.lessonId !== orNull(session.lesson_id)
      )
        throw new TutorExchangeError('Exchange lesson must match the session');
      if (
        request.questionRevisionId !== undefined &&
        (!(await service.db.tableExists('question_revisions')) ||
          !(await service.db.get('question_revisions', {
            id: request.questionRevisionId,
            tenant_id: request.tenantId,
          })))
      )
        throw new LearnerAuthorizationError();
      const requestDigest = groupSharingDigest(
        canonical({
          role: request.role,
          text: request.text,
          lessonId: request.lessonId ?? null,
          questionRevisionId: request.questionRevisionId ?? null,
          marker,
          toolSummary,
          inputTokens,
          outputTokens,
          actor: request.actorUserId,
        }),
      );
      const replay = (await service.db.get('tutor_exchanges', {
        tenant_id: request.tenantId,
        session_id: request.sessionId,
        request_key: requestKey,
      })) as Row | null;
      if (replay) {
        if (replay.request_digest !== requestDigest)
          throw new TutorRequestKeyConflictError();
        return { ...exchangeView(replay), changed: false };
      }
      if (await service.closure(request, request.sessionId))
        throw new TutorSessionClosedError();
      const existing = (await service.db.list('tutor_exchanges', {
        tenant_id: request.tenantId,
        session_id: request.sessionId,
      })) as Row[];
      const sequence =
        existing.reduce((max, row) => Math.max(max, Number(row.sequence)), 0) +
        1;
      const created = await (
        await TutorExchangeCollection.create({ db: service.db })
      ).create({
        tenantId: request.tenantId,
        sessionId: request.sessionId,
        learnerId: request.learnerId,
        sequence,
        role: request.role,
        text: request.text,
        actorUserId: request.actorUserId,
        lessonId: request.lessonId ?? orNull(session.lesson_id),
        questionRevisionId: request.questionRevisionId ?? null,
        marker,
        toolSummary,
        inputTokens,
        outputTokens,
        requestKey,
        requestDigest,
        recordedAt: new Date(),
      });
      const row = (await service.db.get('tutor_exchanges', {
        id: String(created.id),
        tenant_id: request.tenantId,
      })) as Row;
      return { ...exchangeView(row), changed: true };
    });
  }

  /** Closes a session by appending a closure; closing twice is a no-op. */
  async close(
    request: LearnerRequest & { sessionId: string },
  ): Promise<TutorSessionView & { changed: boolean }> {
    return this.mutate(async (service) => {
      await service.requireTables(service.db);
      const learner = await service.requireActor(
        request,
        'education.tutor.exchange',
      );
      const session = await service.session(request, request.sessionId);
      if (
        String(session.audience) === 'guardian' &&
        learner.userId === request.actorUserId
      )
        throw new LearnerAuthorizationError();
      const existing = await service.closure(request, request.sessionId);
      if (existing)
        return { ...sessionView(session, existing.closed_at), changed: false };
      await (
        await TutorSessionClosureCollection.create({ db: service.db })
      ).create({
        tenantId: request.tenantId,
        sessionId: request.sessionId,
        learnerId: request.learnerId,
        actorUserId: request.actorUserId,
        closedAt: new Date(),
      });
      const closed = (await service.closure(request, request.sessionId)) as Row;
      return { ...sessionView(session, closed.closed_at), changed: true };
    });
  }

  /**
   * The learner's own sessions, newest first, with a bounded number of
   * exchanges each (first by sequence). `limit` (default 20, max 50) and
   * `cursor` page sessions; `exchangeLimit` (default 50, max 200) bounds
   * exchanges, and `sessionId` + `afterSequence` page one session's exchanges.
   * Guardians read through the host's `education.tutor.read` decision.
   */
  async listForLearner(request: ListTutorSessionsRequest): Promise<{
    sessions: TutorSessionWithExchanges[];
    nextCursor: string | null;
  }> {
    await this.requireTables(this.db);
    const limit = request.limit ?? DEFAULT_TUTOR_SESSION_PAGE;
    const exchangeLimit = request.exchangeLimit ?? DEFAULT_TUTOR_EXCHANGE_PAGE;
    const after = request.afterSequence ?? 0;
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > MAX_TUTOR_SESSION_PAGE ||
      !Number.isSafeInteger(exchangeLimit) ||
      exchangeLimit < 1 ||
      exchangeLimit > MAX_TUTOR_EXCHANGE_PAGE ||
      !Number.isSafeInteger(after) ||
      after < 0
    )
      throw new LearnerValidationError('Invalid tutor list bounds');
    const reader = await this.requireActor(request, 'education.tutor.read');
    if (request.enrollmentId)
      await this.requireEnrollment(
        request as LearnerRequest & { enrollmentId: string },
        'education.tutor.read',
      );
    const where: Record<string, unknown> = {
      tenant_id: request.tenantId,
      learner_id: request.learnerId,
    };
    if (request.enrollmentId) where.enrollment_id = request.enrollmentId;
    if (request.lessonId) where.lesson_id = request.lessonId;
    if (request.sessionId) where.id = request.sessionId;
    // Guardian-audience transcripts may quote answer keys; the learner never
    // reads them (fail closed: they look like missing sessions).
    const rows = (
      (await this.db.list('tutor_sessions', where)) as Row[]
    ).filter(
      (row) =>
        !(
          String(row.audience) === 'guardian' &&
          reader.userId === request.actorUserId
        ),
    );
    rows.sort(
      (a, b) =>
        new Date(b.opened_at as string).getTime() -
          new Date(a.opened_at as string).getTime() ||
        String(b.id).localeCompare(String(a.id)),
    );
    let start = 0;
    if (request.cursor) {
      const index = rows.findIndex((row) => String(row.id) === request.cursor);
      if (index < 0) throw new LearnerValidationError('Invalid tutor cursor');
      start = index + 1;
    }
    const page = rows.slice(start, start + limit);
    const sessions: TutorSessionWithExchanges[] = [];
    for (const row of page) {
      const closed = (await this.db.get('tutor_session_closures', {
        tenant_id: request.tenantId,
        session_id: String(row.id),
      })) as Row | null;
      const exchanges = (
        (await this.db.list('tutor_exchanges', {
          tenant_id: request.tenantId,
          learner_id: request.learnerId,
          session_id: String(row.id),
        })) as Row[]
      )
        .filter((e) => Number(e.sequence) > after)
        .sort((a, b) => Number(a.sequence) - Number(b.sequence));
      sessions.push({
        ...sessionView(row, closed?.closed_at),
        exchanges: exchanges.slice(0, exchangeLimit).map(exchangeView),
        exchangesTruncated: exchanges.length > exchangeLimit,
      });
    }
    return {
      sessions,
      nextCursor:
        start + limit < rows.length ? String(page[page.length - 1].id) : null,
    };
  }
}
