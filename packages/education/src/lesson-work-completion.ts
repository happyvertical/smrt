import {
  crossPackageRef,
  foreignKey,
  SmrtCollection,
  SmrtObject,
  type SmrtSaveOptions,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import {
  WorkAssessmentRevisionCollection,
  type WorkAttempt,
  WorkAttemptCollection,
} from './lesson-work-models.js';

/** Immutable parent judgment; assessment and feedback release remain independent. */
@TenantScoped({ mode: 'required' })
@smrt({
  api: false,
  mcp: false,
  cli: false,
  tableName: 'workbook_completion_decisions',
  conflictColumns: ['tenant_id', 'activity_id', 'request_key'],
  indexes: [
    {
      name: 'workbook_completion_decisions_attempt_unique',
      columns: ['tenantId', 'activityId', 'attemptId'],
      unique: true,
    },
  ],
})
export class WorkCompletionDecision extends SmrtObject {
  @tenantId() tenantId = '';
  @foreignKey('Learner', { required: true, requiredFor: 'identity' })
  learnerId = '';
  @foreignKey('LessonActivity', { required: true, requiredFor: 'identity' })
  activityId = '';
  @foreignKey('WorkAttempt', { required: true, requiredFor: 'identity' })
  attemptId = '';
  @foreignKey('Submission', { required: true, requiredFor: 'identity' })
  submissionId = '';
  @foreignKey('WorkAssessmentRevision', { nullable: true }) feedbackHeadId:
    | string
    | null = null;
  @crossPackageRef('@happyvertical/smrt-users:User', {
    required: true,
    requiredFor: 'identity',
  })
  actorUserId = '';
  requestKey = '';
  recordedAt = new Date();

  constructor(options: Record<string, unknown> = {}) {
    super(options);
    for (const [key, value] of Object.entries(options))
      if (Object.hasOwn(this, key))
        (this as unknown as Record<string, unknown>)[key] = value;
  }

  override async delete(): Promise<void> {
    throw new Error('Lesson work completion history is immutable');
  }

  override async save(options?: SmrtSaveOptions): Promise<this> {
    if (this.id && (await this.db.get(this.tableName, { id: this.id })))
      throw new Error('Lesson work completion history is immutable');
    if (
      !this.tenantId.trim() ||
      !this.actorUserId ||
      typeof this.requestKey !== 'string' ||
      !this.requestKey.trim() ||
      this.requestKey.length > 200 ||
      Array.from(this.requestKey).some((character) => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127;
      })
    )
      throw new Error(
        'Lesson work completion requires tenant, actor and request key',
      );
    const owner = { tenant_id: this.tenantId, learner_id: this.learnerId };
    const activity = await this.db.get('workbook_activities', {
      ...owner,
      id: this.activityId,
    });
    const submission = await this.db.get('submissions', {
      ...owner,
      id: this.submissionId,
    });
    if (
      !activity ||
      !submission ||
      !(await this.db.get('learners', {
        id: this.learnerId,
        tenant_id: this.tenantId,
      })) ||
      !(await this.db.get('workbook_attempts', {
        ...owner,
        id: this.attemptId,
        activity_id: this.activityId,
        submission_id: this.submissionId,
      })) ||
      submission.lesson_id !== activity.lesson_id ||
      !(await this.db.get('lesson_progress', {
        ...owner,
        id: submission.progress_id,
        enrollment_id: activity.enrollment_id,
        lesson_id: activity.lesson_id,
      })) ||
      !(await this.db.get('memberships', {
        tenant_id: this.tenantId,
        user_id: this.actorUserId,
        status: 'active',
      }))
    )
      throw new Error('Lesson work completion ownership mismatch');
    if (
      this.feedbackHeadId !== null &&
      !(await this.db.get('workbook_assessment_revisions', {
        ...owner,
        id: this.feedbackHeadId,
        attempt_id: this.attemptId,
      }))
    )
      throw new Error('Lesson work completion feedback head mismatch');
    this.recordedAt = new Date();
    this.requireInsertOnSave();
    return super.save(options);
  }
}

export class WorkCompletionDecisionCollection extends SmrtCollection<WorkCompletionDecision> {
  static readonly _itemClass = WorkCompletionDecision;
}

/** Internal owning read. Callers must authorize the exact scope on this executor. */
export async function readWorkCompletion(
  db: DatabaseInterface,
  scope: { tenantId: string; learnerId: string; activityId: string },
): Promise<{
  currentAttempt: WorkAttempt | null;
  feedbackHeadId: string | null;
  decision: WorkCompletionDecision | null;
  decisions: WorkCompletionDecision[];
  completion: { status: 'doing' | 'complete'; completedAt: Date | null };
  attempts: WorkAttempt[];
}> {
  if (!scope.tenantId || !scope.learnerId || !scope.activityId)
    throw new Error('Lesson work completion requires exact scope');
  const attempts = (await db.tableExists('workbook_attempts'))
    ? await (await WorkAttemptCollection.create({ db })).list({
        where: scope,
      })
    : [];
  const byId = new Map(
    attempts.map((attempt) => [String(attempt.id), attempt]),
  );
  const episodes = new Map<string, WorkAttempt[]>();
  for (const attempt of attempts) {
    const episode = episodes.get(attempt.episodeId) ?? [];
    episode.push(attempt);
    episodes.set(attempt.episodeId, episode);
  }
  const leaves: WorkAttempt[] = [];
  for (const episode of episodes.values()) {
    const predecessors = new Set(
      episode.flatMap((attempt) =>
        attempt.previousAttemptId ? [attempt.previousAttemptId] : [],
      ),
    );
    const episodeLeaves = episode.filter(
      (attempt) => !predecessors.has(String(attempt.id)),
    );
    if (episodeLeaves.length !== 1)
      throw new Error('Lesson work current attempt is ambiguous');
    const leaf = episodeLeaves[0];
    const visited = new Set<string>();
    let ancestor: WorkAttempt | null = leaf;
    while (ancestor) {
      const id = String(ancestor.id);
      if (visited.has(id))
        throw new Error('Lesson work attempt ancestry is cyclic');
      if (ancestor.episodeId !== leaf.episodeId)
        throw new Error(
          'Lesson work attempt ancestry crosses practice episodes',
        );
      visited.add(id);
      const previous: string | null = ancestor.previousAttemptId;
      ancestor = previous ? (byId.get(previous) ?? null) : null;
      if (previous && !ancestor)
        throw new Error('Lesson work attempt ancestry is incomplete');
    }
    if (visited.size !== episode.length)
      throw new Error('Lesson work attempt ancestry is disconnected');
    leaves.push(leaf);
  }
  // Separate independent practice episodes retain capture order. Within each
  // episode the successor chain, rather than timestamp ties, determines its leaf.
  leaves.sort(
    (a, b) =>
      new Date(b.capturedAt).getTime() - new Date(a.capturedAt).getTime() ||
      String(b.id).localeCompare(String(a.id)),
  );
  const currentAttempt = leaves[0] ?? null;
  const revisions = currentAttempt
    ? await (await WorkAssessmentRevisionCollection.create({ db })).list({
        where: {
          tenantId: scope.tenantId,
          learnerId: scope.learnerId,
          attemptId: String(currentAttempt.id),
        },
      })
    : [];
  revisions.sort(
    (a, b) =>
      new Date(b.recordedAt).getTime() - new Date(a.recordedAt).getTime() ||
      String(b.id).localeCompare(String(a.id)),
  );
  const head =
    revisions.find((revision) => revision.kind === 'guardian') ??
    revisions.find((revision) => revision.kind === 'ai');
  const decisions = (await db.tableExists('workbook_completion_decisions'))
    ? await (await WorkCompletionDecisionCollection.create({ db })).list({
        where: scope,
      })
    : [];
  const currentDecisions = decisions.filter(
    (decision) => decision.attemptId === currentAttempt?.id,
  );
  if (currentDecisions.length > 1)
    throw new Error('Lesson work current completion decision is ambiguous');
  const decision = currentDecisions[0] ?? null;
  if (decision && decision.submissionId !== currentAttempt?.submissionId)
    throw new Error('Lesson work completion submission mismatch');
  return {
    currentAttempt,
    feedbackHeadId: head ? String(head.id) : null,
    decision,
    decisions,
    completion: decision
      ? { status: 'complete', completedAt: new Date(decision.recordedAt) }
      : { status: 'doing', completedAt: null },
    attempts,
  };
}
