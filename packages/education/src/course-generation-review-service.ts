import type { DatabaseInterface } from '@happyvertical/sql';
import {
  CourseArchivedError,
  type CourseAuthoringActor,
  CourseAuthoringAuthorizationError,
  type CourseAuthoringAuthorizer,
  CourseAuthoringError,
  CourseAuthoringValidationError,
  CourseNotFoundError,
  CourseRequestKeyConflictError,
  type CourseRevisionView,
  CourseStaleHeadError,
} from './course-authoring-contracts.js';
import { CourseRevisionCollection } from './course-authoring-models.js';
import {
  COURSE_GENERATION_TERMINAL,
  type CourseGenerationEventView,
  CourseGenerationInProgressError,
  type CourseGenerationLimits,
  CourseGenerationNotFoundError,
  CourseGenerationOutputError,
  type CourseGenerationStatus,
  type CourseGenerationUsageView,
  type CourseGenerationView,
  CourseGeneratorNotConfiguredError,
  type CourseGeneratorRequest,
  type CourseMaterialGenerator,
  type CourseProposalDecisionKind,
  CourseProposalFieldError,
  CourseProposalNotFoundError,
  type CourseProposalView,
} from './course-generation-contracts.js';
import {
  CourseGenerationEventCollection,
  CourseGenerationJobCollection,
  CourseProposalCollection,
  CourseProposalDecisionCollection,
} from './course-generation-models.js';
import {
  applyProposalFields,
  draftFromRevision,
  type ProposalFieldPlan,
  planProposal,
  validateCourseGenerationOutput,
} from './course-generation-output.js';
import {
  COURSE_FINDING_RESOLUTIONS,
  COURSE_REVIEW_CONCERNS,
  COURSE_REVIEW_DISCLAIMER,
  COURSE_REVIEW_SECTIONS,
  COURSE_REVIEW_TARGET_KINDS,
  CourseFindingNotFoundError,
  type CourseFindingResolutionKind,
  CourseFindingResolvedError,
  type CourseReviewContext,
  type CourseReviewContextInput,
  type CourseReviewFindingInput,
  type CourseReviewFindingView,
  CourseReviewNotFoundError,
  CourseReviewTargetError,
  type CourseReviewView,
  HumanVerificationRequiredError,
} from './course-review-contracts.js';
import { courseReviewContextDigest } from './course-review-digest.js';
import {
  createCourseReferenceGuard,
  createReviewBackedReleaseGate,
} from './course-review-gate.js';
import {
  CourseFindingResolutionCollection,
  CourseReviewCollection,
  CourseReviewFindingCollection,
  CourseReviewOutdatedMarkerCollection,
} from './course-review-models.js';
import { groupSharingDigest } from './group-sharing-hash.js';
import {
  QuestionAuthoringService,
  type QuestionAuthoringServiceOptions,
} from './question-authoring-service.js';

const NAMESPACE = 'smrt.education.course-generation-review.v1';
const KEY_PATTERN = /^[A-Za-z0-9._:@/-]{1,200}$/;
const DEFAULT_LIMITS: CourseGenerationLimits = {
  timeoutMs: 120_000,
  maxOutputBytes: 400_000,
};

type Tx = DatabaseInterface;
type Row = Record<string, unknown>;

const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v).sort(([a], [b]) => a.localeCompare(b)),
        )
      : v,
  );
const digest = (value: unknown) => groupSharingDigest(canonical(value));
function derived(...parts: string[]): string {
  const hex = groupSharingDigest(JSON.stringify([NAMESPACE, ...parts]));
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
function requireKey(value: unknown, what = 'request key'): string {
  if (typeof value !== 'string' || !KEY_PATTERN.test(value))
    throw new CourseAuthoringValidationError(`Invalid ${what}`);
  return value;
}
function boundedText(
  value: unknown,
  what: string,
  max: number,
  required = false,
) {
  if (value === undefined || value === null || value === '') {
    if (required)
      throw new CourseAuthoringValidationError(`${what} is required`);
    return '';
  }
  if (
    typeof value !== 'string' ||
    value.length > max ||
    (required && !value.trim())
  )
    throw new CourseAuthoringValidationError(`Invalid ${what}`);
  return value;
}
const iso = (date: unknown) => new Date(date as string | Date).toISOString();
const orNull = (value: unknown) => (value ? String(value) : null);
const numOrNull = (value: unknown) =>
  value === null || value === undefined ? null : Number(value);

function normalizeUsage(usage: unknown) {
  const raw: Record<string, number> = {};
  if (usage && typeof usage === 'object' && !Array.isArray(usage))
    for (const [key, value] of Object.entries(usage).slice(0, 20))
      if (
        key.length <= 64 &&
        typeof value === 'number' &&
        Number.isFinite(value)
      )
        raw[key] = value;
  const pick = (...names: string[]) => {
    for (const name of names) if (name in raw) return raw[name];
    return null;
  };
  const whole = (value: number | null) =>
    value !== null && Number.isSafeInteger(value) && value >= 0 ? value : null;
  const cost = pick('cost', 'costUsd', 'cost_usd');
  return {
    raw,
    inputTokens: whole(
      pick('inputTokens', 'input_tokens', 'promptTokens', 'prompt_tokens'),
    ),
    outputTokens: whole(
      pick(
        'outputTokens',
        'output_tokens',
        'completionTokens',
        'completion_tokens',
      ),
    ),
    cost,
    costCurrency:
      cost !== null && ('costUsd' in raw || 'cost_usd' in raw) ? 'USD' : null,
  };
}

export interface CourseGenerationReviewServiceOptions
  extends QuestionAuthoringServiceOptions {
  /** Host-supplied generation port; without it `runGeneration` fails closed. */
  generator?: CourseMaterialGenerator;
  generationLimits?: Partial<CourseGenerationLimits>;
}

/**
 * Generation proposals and revision-bound educational review (SMRT #4516).
 * It extends `QuestionAuthoringService`, so it adds only the generation and
 * review operations and uses the same authorizer, tenancy checks and CAS save
 * path. Its release gate and discard guard default to the review-backed ones.
 */
export class CourseGenerationReviewService extends QuestionAuthoringService {
  private readonly generator: CourseMaterialGenerator | undefined;
  private readonly limits: CourseGenerationLimits;

  constructor(
    db: DatabaseInterface,
    authorizer: CourseAuthoringAuthorizer,
    options: CourseGenerationReviewServiceOptions = {},
  ) {
    super(db, authorizer, {
      ...options,
      releaseReviewGate:
        options.releaseReviewGate ?? createReviewBackedReleaseGate(),
      referenceGuard: createCourseReferenceGuard(
        options.referenceGuard ? [options.referenceGuard] : [],
      ),
    });
    this.generator = options.generator;
    this.limits = { ...DEFAULT_LIMITS, ...options.generationLimits };
  }

  // -- generation -----------------------------------------------------------

  private async baseView(
    tx: Tx,
    tenantId: string,
    courseId: string,
    revisionId: string,
  ): Promise<CourseRevisionView> {
    const revision = await (
      await CourseRevisionCollection.create({ db: tx })
    ).get({ id: revisionId, tenantId, courseId }, { cache: false });
    if (!revision) throw new CourseNotFoundError();
    return this.revisionView(tx, tenantId, revision);
  }

  /** Provider-facing snapshot: no keys, assets or personal-use lesson bodies. */
  private material(view: CourseRevisionView) {
    return {
      title: view.title,
      summary: view.summary,
      subject: view.subject,
      theme: view.theme,
      levelMin: view.levelMin,
      levelMax: view.levelMax,
      objectives: view.objectives,
      sections: view.sections.map((section) => ({
        sectionKey: section.sectionKey,
        title: section.title,
        lessons: section.lessons.map((lesson) => ({
          lessonKey: lesson.lessonKey,
          title: lesson.title,
          lessonType: lesson.lessonType,
          estimatedMinutes: lesson.estimatedMinutes,
          difficulty: lesson.difficulty,
          ...(lesson.licenseKind === 'personal-use-copy'
            ? { bodyWithheld: true }
            : { body: lesson.body }),
        })),
      })),
    };
  }

  private async jobRow(tx: Tx, tenantId: string, jobId: string): Promise<Row> {
    const row =
      typeof jobId === 'string' && jobId
        ? await tx.get('course_generation_jobs', {
            id: jobId,
            tenant_id: tenantId,
          })
        : null;
    if (!row) throw new CourseGenerationNotFoundError();
    return row as Row;
  }

  private async jobEvents(tx: Tx, tenantId: string, jobId: string) {
    return (
      (await tx.list('course_generation_events', {
        tenant_id: tenantId,
        job_id: jobId,
      })) as Row[]
    ).sort((a, b) => Number(a.sequence) - Number(b.sequence));
  }

  private usageView(row: Row): CourseGenerationUsageView {
    return {
      inputTokens: numOrNull(row.input_tokens),
      outputTokens: numOrNull(row.output_tokens),
      cost: numOrNull(row.cost),
      costCurrency: orNull(row.cost_currency),
      raw: JSON.parse(String(row.usage_json || '{}')),
    };
  }

  private eventView(row: Row): CourseGenerationEventView {
    return {
      sequence: Number(row.sequence),
      status: String(row.status) as CourseGenerationStatus,
      provider: String(row.provider ?? ''),
      model: String(row.model ?? ''),
      version: String(row.version ?? ''),
      responseModel: String(row.response_model ?? ''),
      usage: this.usageView(row),
      errorCode: orNull(row.error_code),
      detail: String(row.detail ?? ''),
      proposalId: orNull(row.proposal_id),
      resultRevisionId: orNull(row.result_revision_id),
      actorUserId: String(row.actor_user_id),
      delegatingGuardianUserId: orNull(row.delegating_guardian_user_id),
      recordedAt: iso(row.recorded_at),
    };
  }

  private async generationView(
    tx: Tx,
    job: Row,
  ): Promise<CourseGenerationView> {
    const events = await this.jobEvents(
      tx,
      String(job.tenant_id),
      String(job.id),
    );
    const latest = events.at(-1) as Row;
    const running = [...events].reverse().find((e) => e.provider) ?? latest;
    return {
      jobId: String(job.id),
      courseId: String(job.course_id),
      baseRevisionId: String(job.base_revision_id),
      requestKey: String(job.request_key),
      instruction: String(job.instruction),
      status: String(latest.status) as CourseGenerationStatus,
      provider: String(running.provider ?? ''),
      model: String(running.model ?? ''),
      usage: this.usageView(latest),
      errorCode: orNull(latest.error_code),
      proposalId: orNull(latest.proposal_id),
      resultRevisionId: orNull(latest.result_revision_id),
      requestedByUserId: String(job.requested_by_user_id),
      delegatingGuardianUserId: orNull(job.delegating_guardian_user_id),
      events: events.map((e) => this.eventView(e)),
    };
  }

  private async appendEvent(
    tx: Tx,
    actor: CourseAuthoringActor,
    job: Row,
    sequence: number,
    fields: {
      status: CourseGenerationStatus;
      requestKey?: string;
      provider?: string;
      model?: string;
      version?: string;
      responseModel?: string;
      usage?: ReturnType<typeof normalizeUsage>;
      errorCode?: string;
      detail?: string;
      proposalId?: string;
      resultRevisionId?: string;
    },
  ) {
    const usage = fields.usage;
    await (await CourseGenerationEventCollection.create({ db: tx })).create({
      _insertOnly: true,
      tenantId: actor.tenantId,
      jobId: String(job.id),
      courseId: String(job.course_id),
      sequence,
      status: fields.status,
      provider: fields.provider ?? '',
      model: fields.model ?? '',
      version: fields.version ?? '',
      responseModel: fields.responseModel ?? '',
      inputTokens: usage?.inputTokens ?? null,
      outputTokens: usage?.outputTokens ?? null,
      cost: usage?.cost ?? null,
      costCurrency: usage?.costCurrency ?? null,
      usageJson: JSON.stringify(usage?.raw ?? {}),
      errorCode: fields.errorCode ?? null,
      detail: fields.detail ?? '',
      proposalId: fields.proposalId ?? null,
      resultRevisionId: fields.resultRevisionId ?? null,
      actorUserId: actor.actorUserId,
      delegatingGuardianUserId: actor.delegatingGuardianUserId ?? '',
      requestKey: fields.requestKey ?? '',
      recordedAt: new Date(),
    });
  }

  /**
   * Records a generation request against the draft head the caller saw. A
   * retried key returns the existing job and its proposal; the same key with
   * different input is a typed conflict. Nothing is generated or written to the
   * draft here.
   */
  async requestGeneration(
    request: CourseAuthoringActor & {
      courseId: string;
      expectedHeadRevisionId: string;
      requestKey: string;
      instruction?: string;
    },
  ): Promise<CourseGenerationView> {
    const requestKey = requireKey(request.requestKey);
    const expected = requireKey(
      request.expectedHeadRevisionId,
      'expected head',
    );
    const instruction = boundedText(request.instruction, 'instruction', 4000);
    const payloadDigest = digest({
      courseId: request.courseId,
      expected,
      instruction,
    });
    return this.run(async (tx) => {
      await this.authorize(
        tx,
        request,
        'education.course.generate',
        'request-generation',
        { courseId: request.courseId },
      );
      await this.writableDraft(tx, request.tenantId, request.courseId);
      const existing = await tx.get('course_generation_jobs', {
        tenant_id: request.tenantId,
        request_key: requestKey,
      });
      if (existing) {
        if (existing.payload_digest !== payloadDigest)
          throw new CourseRequestKeyConflictError();
        return this.generationView(tx, existing as Row);
      }
      if (
        (await this.state(tx, request.tenantId, request.courseId)) ===
        'archived'
      )
        throw new CourseArchivedError();
      await this.lockHead(tx, request.tenantId, request.courseId);
      const head = await this.headView(tx, request.tenantId, request.courseId);
      if (head.headRevisionId !== expected)
        throw new CourseStaleHeadError(head.headRevisionId);
      const view = await this.baseView(
        tx,
        request.tenantId,
        request.courseId,
        expected,
      );
      const job = (await (
        await CourseGenerationJobCollection.create({ db: tx })
      ).create({
        _insertOnly: true,
        id: derived('job', request.tenantId, requestKey),
        tenantId: request.tenantId,
        courseId: request.courseId,
        baseRevisionId: expected,
        requestKey,
        payloadDigest,
        instruction,
        inputJson: JSON.stringify({ material: this.material(view) }),
        requestedByUserId: request.actorUserId,
        delegatingGuardianUserId: request.delegatingGuardianUserId ?? '',
        recordedAt: new Date(),
      })) as unknown as Row;
      const row = (await tx.get('course_generation_jobs', {
        id: String(job.id),
        tenant_id: request.tenantId,
      })) as Row;
      await this.appendEvent(tx, request, row, 1, {
        status: 'queued',
        requestKey,
      });
      return this.generationView(tx, row);
    });
  }

  /**
   * Runs a queued job through the injected generator outside any transaction,
   * then records the outcome. Success writes a new draft revision holding only
   * additions and fills; conflicting proposals wait for an explicit decision.
   * Failure, timeout, cancellation, a stale head or invalid output leave the
   * head unchanged and keep the input.
   */
  async runGeneration(
    request: CourseAuthoringActor & { jobId: string },
  ): Promise<CourseGenerationView> {
    const generator = this.generator;
    if (!generator) throw new CourseGeneratorNotConfiguredError();
    const identity = {
      provider: generator.identity.provider,
      model: generator.identity.model,
      version: generator.identity.version,
    };
    const started = await this.run(async (tx) => {
      const job = await this.jobRow(tx, request.tenantId, request.jobId);
      await this.authorize(
        tx,
        request,
        'education.course.generate',
        'run-generation',
        { courseId: String(job.course_id) },
      );
      await this.writableDraft(tx, request.tenantId, String(job.course_id));
      const events = await this.jobEvents(tx, request.tenantId, String(job.id));
      const latest = events.at(-1) as Row;
      if (COURSE_GENERATION_TERMINAL.includes(String(latest.status) as never))
        return { done: await this.generationView(tx, job) };
      if (latest.status === 'running')
        throw new CourseGenerationInProgressError();
      await this.appendEvent(tx, request, job, Number(latest.sequence) + 1, {
        status: 'running',
        ...identity,
      });
      const input = JSON.parse(String(job.input_json)) as { material: unknown };
      return {
        courseId: String(job.course_id),
        generatorRequest: {
          tenantId: request.tenantId,
          courseId: String(job.course_id),
          jobId: String(job.id),
          instruction: String(job.instruction),
          material: input.material,
        } satisfies CourseGeneratorRequest,
      };
    });
    if ('done' in started && started.done) return started.done;
    const { courseId, generatorRequest } = started as {
      courseId: string;
      generatorRequest: CourseGeneratorRequest;
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.limits.timeoutMs);
    let result: Awaited<
      ReturnType<CourseMaterialGenerator['generate']>
    > | null = null;
    let failure: { code: string } | null = null;
    try {
      result = await generator.generate(generatorRequest, {
        signal: controller.signal,
        maxOutputBytes: this.limits.maxOutputBytes,
      });
      if (
        JSON.stringify(result?.output ?? null).length >
        this.limits.maxOutputBytes
      )
        failure = { code: 'output-too-large' };
    } catch {
      failure = {
        code: controller.signal.aborted ? 'provider-timeout' : 'provider-error',
      };
    } finally {
      clearTimeout(timer);
    }
    const usage = normalizeUsage(result?.usage);
    const responseModel =
      typeof result?.responseModel === 'string'
        ? result.responseModel.slice(0, 200)
        : '';
    const outcome = {
      ...identity,
      responseModel,
      usage,
    };

    const finish = (skipAuthorization: boolean, error?: CourseAuthoringError) =>
      this.run(async (tx) => {
        const job = await this.jobRow(tx, request.tenantId, request.jobId);
        if (!skipAuthorization)
          await this.authorize(
            tx,
            request,
            'education.course.generate',
            'run-generation',
            { courseId },
          );
        const events = await this.jobEvents(
          tx,
          request.tenantId,
          String(job.id),
        );
        const latest = events.at(-1) as Row;
        // A cancellation (or another terminal state) wins; the output is dropped.
        if (COURSE_GENERATION_TERMINAL.includes(String(latest.status) as never))
          return this.generationView(tx, job);
        const sequence = Number(latest.sequence) + 1;
        const fail = async (errorCode: string, detail = '') => {
          await this.appendEvent(tx, request, job, sequence, {
            status: 'failed',
            ...outcome,
            errorCode,
            detail,
          });
          return this.generationView(tx, job);
        };
        if (error) return fail(error.code);
        if (failure) return fail(failure.code);
        await this.lockHead(tx, request.tenantId, courseId);
        const head = await this.headView(tx, request.tenantId, courseId);
        if (head.headRevisionId !== String(job.base_revision_id))
          return fail('stale-head');
        const base = await this.baseView(
          tx,
          request.tenantId,
          courseId,
          String(job.base_revision_id),
        );
        let proposal: ReturnType<typeof validateCourseGenerationOutput>;
        try {
          proposal = validateCourseGenerationOutput(
            result?.output,
            new Set(
              base.sections.flatMap((s) => s.lessons.map((l) => l.lessonKey)),
            ),
          );
        } catch (e) {
          if (e instanceof CourseGenerationOutputError)
            return fail(e.code, e.path);
          throw e;
        }
        const plan = planProposal(base, proposal);
        const draft = draftFromRevision(base);
        applyProposalFields(
          draft,
          plan.filter((p) => p.status === 'added' || p.status === 'filled'),
          { jobId: String(job.id) },
        );
        draft.provenance = 'generated';
        const saved = await this.saveDraftIn(tx, {
          tenantId: request.tenantId,
          actorUserId: request.actorUserId,
          ...(request.delegatingGuardianUserId
            ? { delegatingGuardianUserId: request.delegatingGuardianUserId }
            : {}),
          courseId,
          expectedHeadRevisionId: String(job.base_revision_id),
          requestKey: `gen:${digest(String(job.id)).slice(0, 40)}`,
          draft,
        });
        const proposalId = derived('proposal', String(job.id));
        await (await CourseProposalCollection.create({ db: tx })).create({
          _insertOnly: true,
          id: proposalId,
          tenantId: request.tenantId,
          jobId: String(job.id),
          courseId,
          baseRevisionId: String(job.base_revision_id),
          resultRevisionId: saved.revisionId,
          rationale: proposal.rationale,
          proposalJson: JSON.stringify(proposal),
          planJson: JSON.stringify(plan),
          recordedAt: new Date(),
        });
        await this.appendEvent(tx, request, job, sequence, {
          status: 'succeeded',
          ...outcome,
          proposalId,
          resultRevisionId: saved.revisionId,
        });
        return this.generationView(tx, job);
      });

    try {
      return await finish(false);
    } catch (error) {
      if (error instanceof CourseAuthoringAuthorizationError)
        return finish(
          true,
          new CourseAuthoringError('authorization-revoked', 'revoked'),
        );
      if (error instanceof CourseAuthoringError) return finish(true, error);
      throw error;
    }
  }

  /** Cancels a queued or running job; a finished job is returned unchanged. */
  async cancelGeneration(
    request: CourseAuthoringActor & { jobId: string; requestKey: string },
  ): Promise<CourseGenerationView> {
    const requestKey = requireKey(request.requestKey);
    return this.run(async (tx) => {
      const job = await this.jobRow(tx, request.tenantId, request.jobId);
      await this.authorize(
        tx,
        request,
        'education.course.generate',
        'cancel-generation',
        { courseId: String(job.course_id) },
      );
      await this.writableDraft(tx, request.tenantId, String(job.course_id));
      const events = await this.jobEvents(tx, request.tenantId, String(job.id));
      const latest = events.at(-1) as Row;
      if (!COURSE_GENERATION_TERMINAL.includes(String(latest.status) as never))
        await this.appendEvent(tx, request, job, Number(latest.sequence) + 1, {
          status: 'cancelled',
          requestKey,
        });
      return this.generationView(tx, job);
    });
  }

  async getGeneration(
    request: CourseAuthoringActor & { jobId: string },
  ): Promise<CourseGenerationView> {
    return this.run(async (tx) => {
      const job = await this.jobRow(tx, request.tenantId, request.jobId);
      await this.authorize(
        tx,
        request,
        'education.course.read-draft',
        'read-generation',
        { courseId: String(job.course_id) },
      );
      return this.generationView(tx, job);
    });
  }

  private currentValue(view: CourseRevisionView, field: string): unknown {
    if (field.startsWith('course.')) {
      const value = (view as unknown as Row)[field.slice(7)];
      return Array.isArray(value) && !value.length ? null : value || null;
    }
    if (field.startsWith('lesson:')) {
      const dot = field.lastIndexOf('.');
      const lesson = view.sections
        .flatMap((s) => s.lessons)
        .find((l) => l.lessonKey === field.slice(7, dot));
      const value = lesson && (lesson as unknown as Row)[field.slice(dot + 1)];
      return value || null;
    }
    return null;
  }

  private async proposalView(
    tx: Tx,
    tenantId: string,
    proposal: Row,
  ): Promise<CourseProposalView> {
    const courseId = String(proposal.course_id);
    const head = await this.headView(tx, tenantId, courseId);
    const current = await this.baseView(
      tx,
      tenantId,
      courseId,
      head.headRevisionId,
    );
    const decided = new Map<string, CourseProposalDecisionKind>();
    for (const row of (await tx.list('course_proposal_decisions', {
      tenant_id: tenantId,
      proposal_id: String(proposal.id),
    })) as Row[])
      for (const f of JSON.parse(String(row.fields_json)) as string[])
        decided.set(f, String(row.decision) as CourseProposalDecisionKind);
    const plan = JSON.parse(String(proposal.plan_json)) as ProposalFieldPlan[];
    return {
      proposalId: String(proposal.id),
      jobId: String(proposal.job_id),
      courseId,
      baseRevisionId: String(proposal.base_revision_id),
      resultRevisionId: String(proposal.result_revision_id),
      rationale: String(proposal.rationale),
      fields: plan.map((p) => ({
        field: p.field,
        status: p.status,
        supplied: p.supplied,
        proposed: p.proposed,
        current: this.currentValue(current, p.field),
        decision: decided.get(p.field) ?? null,
      })),
    };
  }

  private async proposalRow(
    tx: Tx,
    tenantId: string,
    courseId: string,
    id: string,
  ) {
    const row =
      typeof id === 'string' && id
        ? await tx.get('course_proposals', {
            id,
            tenant_id: tenantId,
            course_id: courseId,
          })
        : null;
    if (!row) throw new CourseProposalNotFoundError();
    return row as Row;
  }

  /** Supplied-versus-proposed comparison, per field, against the current head. */
  async getProposal(
    request: CourseAuthoringActor & { courseId: string; proposalId: string },
  ): Promise<CourseProposalView> {
    return this.run(async (tx) => {
      await this.authorize(
        tx,
        request,
        'education.course.read-draft',
        'read-generation',
        { courseId: request.courseId },
      );
      await this.writableDraft(tx, request.tenantId, request.courseId);
      return this.proposalView(
        tx,
        request.tenantId,
        await this.proposalRow(
          tx,
          request.tenantId,
          request.courseId,
          request.proposalId,
        ),
      );
    });
  }

  /**
   * Explicitly accepts or rejects conflicting proposal fields. Accepting appends
   * a new draft revision on the expected head (compare and swap); supplied
   * content is replaced only by this recorded decision.
   */
  async decideProposal(
    request: CourseAuthoringActor & {
      courseId: string;
      proposalId: string;
      expectedHeadRevisionId: string;
      decision: 'accept' | 'reject';
      fields: string[];
      requestKey: string;
    },
  ): Promise<CourseProposalView & { headRevisionId: string }> {
    const requestKey = requireKey(request.requestKey);
    const expected = requireKey(
      request.expectedHeadRevisionId,
      'expected head',
    );
    if (request.decision !== 'accept' && request.decision !== 'reject')
      throw new CourseAuthoringValidationError('Invalid decision');
    if (
      !Array.isArray(request.fields) ||
      !request.fields.length ||
      request.fields.length > 100 ||
      request.fields.some((f) => typeof f !== 'string' || !f || f.length > 200)
    )
      throw new CourseAuthoringValidationError('Invalid fields');
    const fields = [...new Set(request.fields)].sort();
    const payloadDigest = digest({
      proposalId: request.proposalId,
      expected,
      decision: request.decision,
      fields,
    });
    return this.run(async (tx) => {
      await this.authorize(
        tx,
        request,
        'education.course.generate',
        'accept-proposal',
        { courseId: request.courseId },
      );
      await this.writableDraft(tx, request.tenantId, request.courseId);
      const proposal = await this.proposalRow(
        tx,
        request.tenantId,
        request.courseId,
        request.proposalId,
      );
      const withHead = async () => ({
        ...(await this.proposalView(tx, request.tenantId, proposal)),
        headRevisionId: (
          await this.headView(tx, request.tenantId, request.courseId)
        ).headRevisionId,
      });
      const replay = await tx.get('course_proposal_decisions', {
        tenant_id: request.tenantId,
        proposal_id: request.proposalId,
        request_key: requestKey,
      });
      if (replay) {
        if (replay.payload_digest !== payloadDigest)
          throw new CourseRequestKeyConflictError();
        return withHead();
      }
      await this.lockHead(tx, request.tenantId, request.courseId);
      const view = await this.proposalView(tx, request.tenantId, proposal);
      const decidable = new Set(
        view.fields
          .filter((f) => f.status === 'conflict' && !f.decision)
          .map((f) => f.field),
      );
      const bad = fields.filter((f) => !decidable.has(f));
      if (bad.length) throw new CourseProposalFieldError(bad);
      let resultRevisionId: string | null = null;
      if (request.decision === 'accept') {
        const head = await this.headView(
          tx,
          request.tenantId,
          request.courseId,
        );
        if (head.headRevisionId !== expected)
          throw new CourseStaleHeadError(head.headRevisionId);
        const current = await this.baseView(
          tx,
          request.tenantId,
          request.courseId,
          expected,
        );
        const draft = draftFromRevision(current);
        const plan = (
          JSON.parse(String(proposal.plan_json)) as ProposalFieldPlan[]
        ).filter((p) => fields.includes(p.field));
        const { missing } = applyProposalFields(draft, plan, {
          jobId: String(proposal.job_id),
        });
        if (missing.length) throw new CourseProposalFieldError(missing);
        draft.provenance = 'edited';
        resultRevisionId = (
          await this.saveDraftIn(tx, {
            tenantId: request.tenantId,
            actorUserId: request.actorUserId,
            ...(request.delegatingGuardianUserId
              ? { delegatingGuardianUserId: request.delegatingGuardianUserId }
              : {}),
            courseId: request.courseId,
            expectedHeadRevisionId: expected,
            requestKey: `acc:${digest([request.proposalId, requestKey]).slice(0, 40)}`,
            draft,
          })
        ).revisionId;
      }
      await (await CourseProposalDecisionCollection.create({ db: tx })).create({
        _insertOnly: true,
        tenantId: request.tenantId,
        proposalId: request.proposalId,
        courseId: request.courseId,
        decision: request.decision === 'accept' ? 'accepted' : 'rejected',
        fieldsJson: JSON.stringify(fields),
        resultRevisionId,
        actorUserId: request.actorUserId,
        delegatingGuardianUserId: request.delegatingGuardianUserId ?? '',
        requestKey,
        payloadDigest,
        recordedAt: new Date(),
      });
      return withHead();
    });
  }

  // -- educational review ---------------------------------------------------

  private normalizeFindings(
    value: unknown,
    hasLearner: boolean,
  ): CourseReviewFindingInput[] {
    if (!Array.isArray(value) || value.length > 200)
      throw new CourseAuthoringValidationError('Invalid findings');
    const allowed = [
      'section',
      'target',
      'concern',
      'explanation',
      'suggestedChange',
      'uncertain',
      'humanVerificationRequired',
      'blocking',
    ];
    return value.map((raw) => {
      if (
        !raw ||
        typeof raw !== 'object' ||
        Object.keys(raw).some((k) => !allowed.includes(k))
      )
        throw new CourseAuthoringValidationError('Invalid finding');
      const f = raw as CourseReviewFindingInput;
      const target = f.target as CourseReviewFindingInput['target'];
      if (
        !COURSE_REVIEW_SECTIONS.includes(f.section) ||
        !COURSE_REVIEW_CONCERNS.includes(f.concern) ||
        !target ||
        typeof target !== 'object' ||
        Object.keys(target).some(
          (k) => !['kind', 'id', 'field', 'region'].includes(k),
        ) ||
        !COURSE_REVIEW_TARGET_KINDS.includes(target.kind) ||
        (f.section === 'individual-learner' && !hasLearner)
      )
        throw new CourseAuthoringValidationError('Invalid finding');
      for (const flag of [
        'uncertain',
        'humanVerificationRequired',
        'blocking',
      ] as const)
        if (f[flag] !== undefined && typeof f[flag] !== 'boolean')
          throw new CourseAuthoringValidationError('Invalid finding');
      return {
        section: f.section,
        target: {
          kind: target.kind,
          id: boundedText(target.id, 'finding target', 200, true),
          field: boundedText(target.field, 'finding field', 100, true),
          ...(target.region === undefined
            ? {}
            : { region: boundedText(target.region, 'finding region', 500) }),
        },
        concern: f.concern,
        explanation: boundedText(f.explanation, 'explanation', 4000, true),
        suggestedChange: boundedText(
          f.suggestedChange,
          'suggested change',
          4000,
        ),
        uncertain: f.uncertain === true,
        humanVerificationRequired: f.humanVerificationRequired === true,
        blocking: f.blocking === true,
      };
    });
  }

  private reviewContext(
    revision: Row,
    input: CourseReviewContextInput | undefined,
  ): CourseReviewContext {
    if (input !== undefined && (!input || typeof input !== 'object'))
      throw new CourseAuthoringValidationError('Invalid review context');
    const extra = Object.keys(input ?? {}).filter(
      (k) => k !== 'learnerId' && k !== 'evidenceSnapshotRef',
    );
    const learnerId = input?.learnerId;
    const ref = input?.evidenceSnapshotRef;
    if (extra.length || (learnerId === undefined) !== (ref === undefined))
      throw new CourseAuthoringValidationError(
        'A learner review needs the learner and its evidence snapshot reference',
      );
    return {
      levelMin: Number(revision.level_min),
      levelMax: Number(revision.level_max),
      theme: String(revision.theme),
      learnerId:
        learnerId === undefined
          ? null
          : boundedText(learnerId, 'learner', 200, true),
      evidenceSnapshotRef:
        ref === undefined
          ? null
          : boundedText(ref, 'evidence snapshot reference', 500, true),
    };
  }

  private async reviewView(
    tx: Tx,
    tenantId: string,
    review: Row,
    head: string,
  ): Promise<CourseReviewView> {
    const findings = (
      (await tx.list('course_review_findings', {
        tenant_id: tenantId,
        review_id: String(review.id),
      })) as Row[]
    ).sort((a, b) => Number(a.ordinal) - Number(b.ordinal));
    const resolutions = new Map(
      (
        (await tx.list('course_finding_resolutions', {
          tenant_id: tenantId,
          review_id: String(review.id),
        })) as Row[]
      ).map((r) => [String(r.finding_id), r]),
    );
    let unresolvedBlocking = 0;
    const views = findings.map((f): CourseReviewFindingView => {
      const r = resolutions.get(String(f.id));
      if ((f.blocking || f.human_verification_required) && !r)
        unresolvedBlocking++;
      return {
        id: String(f.id),
        ordinal: Number(f.ordinal),
        section: String(f.section) as CourseReviewFindingView['section'],
        target: {
          kind: String(f.target_kind) as never,
          id: String(f.target_id),
          field: String(f.target_field),
          region: String(f.target_region ?? ''),
        },
        concern: String(f.concern) as never,
        explanation: String(f.explanation),
        suggestedChange: String(f.suggested_change ?? ''),
        uncertain: Boolean(f.uncertain),
        humanVerificationRequired: Boolean(f.human_verification_required),
        blocking: Boolean(f.blocking),
        resolution: r
          ? {
              resolution: String(r.resolution) as CourseFindingResolutionKind,
              note: String(r.note ?? ''),
              actorUserId: String(r.actor_user_id),
              delegatingGuardianUserId: orNull(r.delegating_guardian_user_id),
              recordedAt: iso(r.recorded_at),
            }
          : null,
      };
    });
    const context = JSON.parse(
      String(review.context_json),
    ) as CourseReviewContext;
    const marker = await tx.get('course_review_outdated_markers', {
      tenant_id: tenantId,
      review_id: String(review.id),
    });
    let outdated: CourseReviewView['outdated'] = null;
    if (marker)
      outdated = {
        reason: String(marker.reason) as never,
        supersedingRevisionId: orNull(marker.superseding_revision_id),
      };
    else if (head !== String(review.revision_id))
      outdated = { reason: 'revision-changed', supersedingRevisionId: head };
    else if (
      courseReviewContextDigest(context) !== String(review.context_digest)
    )
      outdated = { reason: 'context-changed', supersedingRevisionId: null };
    return {
      id: String(review.id),
      courseId: String(review.course_id),
      revisionId: String(review.revision_id),
      sequence: Number(review.sequence),
      context,
      contextDigest: String(review.context_digest),
      disclaimer: String(review.disclaimer),
      reviewerKind: String(review.reviewer_kind) as 'guardian' | 'agent',
      reviewerProvider: String(review.reviewer_provider ?? ''),
      reviewerModel: String(review.reviewer_model ?? ''),
      authorUserId: String(review.author_user_id),
      delegatingGuardianUserId: orNull(review.delegating_guardian_user_id),
      recordedAt: iso(review.recorded_at),
      sections: {
        generalLevel: {
          summary: String(review.general_summary ?? ''),
          findings: views.filter((f) => f.section === 'general-level'),
        },
        individualLearner: context.learnerId
          ? {
              summary: String(review.learner_summary ?? ''),
              findings: views.filter((f) => f.section === 'individual-learner'),
            }
          : null,
      },
      outdated,
      unresolvedBlocking,
    };
  }

  /** Revision ids a finding may point at: the course revision, its lessons and questions. */
  private targetIds(view: CourseRevisionView) {
    const lessons = view.sections.flatMap((s) => s.lessons);
    return {
      'course-revision': new Set([view.id]),
      'lesson-revision': new Set(lessons.map((l) => l.id)),
      'question-revision': new Set(
        lessons.flatMap((l) => l.questions.map((q) => q.questionRevisionId)),
      ),
    } as const;
  }

  /**
   * Records an educational review of one exact revision, authored by the
   * caller (a guardian, or an agent for its delegating guardian). The review
   * has no score; level target and theme come from the revision, and a learner
   * review must name the evidence snapshot it used.
   */
  async recordReview(
    request: CourseAuthoringActor & {
      courseId: string;
      revisionId: string;
      requestKey: string;
      context?: CourseReviewContextInput;
      generalSummary?: string;
      learnerSummary?: string;
      findings: CourseReviewFindingInput[];
      reviewer?: { provider?: string; model?: string };
    },
  ): Promise<CourseReviewView> {
    const requestKey = requireKey(request.requestKey);
    const revisionId = requireKey(request.revisionId, 'revision');
    const known = [
      'courseId',
      'revisionId',
      'requestKey',
      'context',
      'generalSummary',
      'learnerSummary',
      'findings',
      'reviewer',
      'tenantId',
      'actorUserId',
      'delegatingGuardianUserId',
    ];
    if (Object.keys(request).some((k) => !known.includes(k)))
      throw new CourseAuthoringValidationError('Unsupported review member');
    const hasLearner = request.context?.learnerId !== undefined;
    const findings = this.normalizeFindings(request.findings, hasLearner);
    const generalSummary = boundedText(request.generalSummary, 'summary', 8000);
    const learnerSummary = boundedText(
      request.learnerSummary,
      'learner summary',
      8000,
    );
    if (learnerSummary && !hasLearner)
      throw new CourseAuthoringValidationError(
        'A learner summary needs a learner context',
      );
    const reviewer = {
      provider: boundedText(
        request.reviewer?.provider,
        'reviewer provider',
        200,
      ),
      model: boundedText(request.reviewer?.model, 'reviewer model', 200),
    };
    const payloadDigest = digest({
      courseId: request.courseId,
      revisionId,
      context: request.context ?? null,
      generalSummary,
      learnerSummary,
      findings,
      reviewer,
    });
    return this.run(async (tx) => {
      await this.authorize(
        tx,
        request,
        'education.course.review',
        'record-review',
        {
          courseId: request.courseId,
          ...(request.context?.learnerId
            ? { learnerId: String(request.context.learnerId) }
            : {}),
        },
      );
      await this.writableDraft(tx, request.tenantId, request.courseId);
      const replay = await tx.get('course_reviews', {
        tenant_id: request.tenantId,
        course_id: request.courseId,
        request_key: requestKey,
      });
      if (replay) {
        if (replay.payload_digest !== payloadDigest)
          throw new CourseRequestKeyConflictError();
        return this.reviewView(
          tx,
          request.tenantId,
          replay as Row,
          (await this.headView(tx, request.tenantId, request.courseId))
            .headRevisionId,
        );
      }
      const revision = (await tx.get('course_revisions', {
        id: revisionId,
        tenant_id: request.tenantId,
        course_id: request.courseId,
      })) as Row | null;
      if (!revision) throw new CourseNotFoundError();
      const context = this.reviewContext(revision, request.context);
      if (
        context.learnerId &&
        !(await tx.get('learners', {
          id: context.learnerId,
          tenant_id: request.tenantId,
        }))
      )
        throw new CourseNotFoundError();
      const view = await this.baseView(
        tx,
        request.tenantId,
        request.courseId,
        revisionId,
      );
      const targets = this.targetIds(view);
      for (const f of findings)
        if (!targets[f.target.kind].has(f.target.id))
          throw new CourseReviewTargetError(f.target.id);
      await this.lockHead(tx, request.tenantId, request.courseId);
      const sequence =
        (
          await tx.list('course_reviews', {
            tenant_id: request.tenantId,
            course_id: request.courseId,
            revision_id: revisionId,
          })
        ).length + 1;
      const review = await (
        await CourseReviewCollection.create({ db: tx })
      ).create({
        _insertOnly: true,
        tenantId: request.tenantId,
        courseId: request.courseId,
        revisionId,
        sequence,
        contextJson: JSON.stringify(context),
        contextDigest: courseReviewContextDigest(context),
        disclaimer: COURSE_REVIEW_DISCLAIMER,
        generalSummary,
        learnerSummary,
        reviewerKind: request.delegatingGuardianUserId ? 'agent' : 'guardian',
        reviewerProvider: reviewer.provider,
        reviewerModel: reviewer.model,
        authorUserId: request.actorUserId,
        delegatingGuardianUserId: request.delegatingGuardianUserId ?? '',
        requestKey,
        payloadDigest,
        recordedAt: new Date(),
      });
      const findingRows = await CourseReviewFindingCollection.create({
        db: tx,
      });
      let ordinal = 0;
      for (const f of findings)
        await findingRows.create({
          _insertOnly: true,
          tenantId: request.tenantId,
          reviewId: String(review.id),
          courseId: request.courseId,
          revisionId,
          ordinal: ordinal++,
          section: f.section,
          targetKind: f.target.kind,
          targetId: f.target.id,
          targetField: f.target.field,
          targetRegion: f.target.region ?? '',
          concern: f.concern,
          explanation: f.explanation,
          suggestedChange: f.suggestedChange ?? '',
          uncertain: f.uncertain === true,
          humanVerificationRequired: f.humanVerificationRequired === true,
          blocking: f.blocking === true,
          recordedAt: new Date(),
        });
      const row = (await tx.get('course_reviews', {
        id: String(review.id),
        tenant_id: request.tenantId,
      })) as Row;
      return this.reviewView(
        tx,
        request.tenantId,
        row,
        (await this.headView(tx, request.tenantId, request.courseId))
          .headRevisionId,
      );
    });
  }

  /** Reviews of a course, newest first, with findings, resolutions and outdated state. */
  async listReviews(
    request: CourseAuthoringActor & { courseId: string; revisionId?: string },
  ): Promise<CourseReviewView[]> {
    return this.run(async (tx) => {
      await this.authorize(
        tx,
        request,
        'education.course.read-draft',
        'read-review',
        {
          courseId: request.courseId,
        },
      );
      await this.writableDraft(tx, request.tenantId, request.courseId);
      const head = (await this.headView(tx, request.tenantId, request.courseId))
        .headRevisionId;
      const rows = (await tx.list('course_reviews', {
        tenant_id: request.tenantId,
        course_id: request.courseId,
        ...(request.revisionId ? { revision_id: request.revisionId } : {}),
      })) as Row[];
      rows.sort(
        (a, b) =>
          new Date(b.recorded_at as string).getTime() -
            new Date(a.recorded_at as string).getTime() ||
          Number(b.sequence) - Number(a.sequence),
      );
      const views: CourseReviewView[] = [];
      for (const row of rows)
        views.push(await this.reviewView(tx, request.tenantId, row, head));
      return views;
    });
  }

  async getReview(
    request: CourseAuthoringActor & { courseId: string; reviewId: string },
  ): Promise<CourseReviewView> {
    return this.run(async (tx) => {
      await this.authorize(
        tx,
        request,
        'education.course.read-draft',
        'read-review',
        {
          courseId: request.courseId,
        },
      );
      await this.writableDraft(tx, request.tenantId, request.courseId);
      const row =
        typeof request.reviewId === 'string' && request.reviewId
          ? await tx.get('course_reviews', {
              id: request.reviewId,
              tenant_id: request.tenantId,
              course_id: request.courseId,
            })
          : null;
      if (!row) throw new CourseReviewNotFoundError();
      return this.reviewView(
        tx,
        request.tenantId,
        row as Row,
        (await this.headView(tx, request.tenantId, request.courseId))
          .headRevisionId,
      );
    });
  }

  private async markOutdated(
    tx: Tx,
    actor: CourseAuthoringActor,
    review: Row,
    marker: {
      reason: 'revision-changed' | 'context-changed';
      supersedingRevisionId?: string;
      newContextDigest?: string;
    },
  ): Promise<boolean> {
    if (
      await tx.get('course_review_outdated_markers', {
        tenant_id: actor.tenantId,
        review_id: String(review.id),
      })
    )
      return false;
    await (
      await CourseReviewOutdatedMarkerCollection.create({ db: tx })
    ).create({
      _insertOnly: true,
      tenantId: actor.tenantId,
      reviewId: String(review.id),
      courseId: String(review.course_id),
      reason: marker.reason,
      supersedingRevisionId: marker.supersedingRevisionId ?? null,
      newContextDigest: marker.newContextDigest ?? '',
      actorUserId: actor.actorUserId,
      recordedAt: new Date(),
    });
    return true;
  }

  /** A new draft revision makes every review of an earlier revision outdated. */
  protected override async onDraftRevisionAppended(
    tx: Tx,
    actor: CourseAuthoringActor,
    revision: { courseId: string; revisionId: string },
  ): Promise<void> {
    const reviews = (await tx.list('course_reviews', {
      tenant_id: actor.tenantId,
      course_id: revision.courseId,
    })) as Row[];
    for (const review of reviews)
      if (String(review.revision_id) !== revision.revisionId)
        await this.markOutdated(tx, actor, review, {
          reason: 'revision-changed',
          supersedingRevisionId: revision.revisionId,
        });
  }

  /**
   * Records that a learner's evidence snapshot changed: learner reviews of this
   * course that used a different snapshot become outdated.
   */
  async noteContextChange(
    request: CourseAuthoringActor & {
      courseId: string;
      learnerId: string;
      evidenceSnapshotRef: string;
      requestKey: string;
    },
  ): Promise<{ outdatedReviewIds: string[] }> {
    requireKey(request.requestKey);
    const learnerId = boundedText(request.learnerId, 'learner', 200, true);
    const ref = boundedText(
      request.evidenceSnapshotRef,
      'evidence snapshot reference',
      500,
      true,
    );
    return this.run(async (tx) => {
      await this.authorize(
        tx,
        request,
        'education.course.review',
        'note-context-change',
        {
          courseId: request.courseId,
          learnerId,
        },
      );
      await this.writableDraft(tx, request.tenantId, request.courseId);
      if (
        !(await tx.get('learners', {
          id: learnerId,
          tenant_id: request.tenantId,
        }))
      )
        throw new CourseNotFoundError();
      const outdatedReviewIds: string[] = [];
      for (const review of (await tx.list('course_reviews', {
        tenant_id: request.tenantId,
        course_id: request.courseId,
      })) as Row[]) {
        const context = JSON.parse(
          String(review.context_json),
        ) as CourseReviewContext;
        if (
          context.learnerId !== learnerId ||
          context.evidenceSnapshotRef === ref
        )
          continue;
        if (
          await this.markOutdated(tx, request, review, {
            reason: 'context-changed',
            newContextDigest: courseReviewContextDigest({
              ...context,
              evidenceSnapshotRef: ref,
            }),
          })
        )
          outdatedReviewIds.push(String(review.id));
      }
      return { outdatedReviewIds };
    });
  }

  /**
   * Resolves one finding. Only a person may resolve a finding flagged for human
   * verification; a delegated agent is refused. Release stays blocked while any
   * blocking or human-verification finding is unresolved.
   */
  async resolveFinding(
    request: CourseAuthoringActor & {
      courseId: string;
      findingId: string;
      resolution: CourseFindingResolutionKind;
      note?: string;
      requestKey: string;
    },
  ): Promise<CourseReviewView> {
    const requestKey = requireKey(request.requestKey);
    if (!COURSE_FINDING_RESOLUTIONS.includes(request.resolution))
      throw new CourseAuthoringValidationError('Invalid resolution');
    const note = boundedText(request.note, 'note', 2000);
    const payloadDigest = digest({
      findingId: request.findingId,
      resolution: request.resolution,
      note,
    });
    return this.run(async (tx) => {
      await this.authorize(
        tx,
        request,
        'education.course.review',
        'resolve-finding',
        {
          courseId: request.courseId,
        },
      );
      await this.writableDraft(tx, request.tenantId, request.courseId);
      const finding =
        typeof request.findingId === 'string' && request.findingId
          ? ((await tx.get('course_review_findings', {
              id: request.findingId,
              tenant_id: request.tenantId,
              course_id: request.courseId,
            })) as Row | null)
          : null;
      if (!finding) throw new CourseFindingNotFoundError();
      const reviewRow = (await tx.get('course_reviews', {
        id: String(finding.review_id),
        tenant_id: request.tenantId,
      })) as Row;
      const view = async () =>
        this.reviewView(
          tx,
          request.tenantId,
          reviewRow,
          (await this.headView(tx, request.tenantId, request.courseId))
            .headRevisionId,
        );
      const existing = await tx.get('course_finding_resolutions', {
        tenant_id: request.tenantId,
        finding_id: String(finding.id),
      });
      if (existing) {
        if (
          existing.request_key === requestKey &&
          existing.payload_digest === payloadDigest
        )
          return view();
        if (existing.request_key === requestKey)
          throw new CourseRequestKeyConflictError();
        throw new CourseFindingResolvedError();
      }
      if (
        finding.human_verification_required &&
        request.delegatingGuardianUserId
      )
        throw new HumanVerificationRequiredError();
      await (await CourseFindingResolutionCollection.create({ db: tx })).create(
        {
          _insertOnly: true,
          tenantId: request.tenantId,
          findingId: String(finding.id),
          reviewId: String(finding.review_id),
          courseId: request.courseId,
          resolution: request.resolution,
          note,
          actorUserId: request.actorUserId,
          delegatingGuardianUserId: request.delegatingGuardianUserId ?? '',
          requestKey,
          payloadDigest,
          recordedAt: new Date(),
        },
      );
      return view();
    });
  }
}
