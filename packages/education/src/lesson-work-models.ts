import {
  field,
  foreignKey,
  SmrtCollection,
  SmrtObject,
  type SmrtSaveOptions,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import {
  validateWorkAssessment,
  type WorkAssessment,
} from './lesson-work-contracts.js';

const closed = { api: false, mcp: false, cli: false } as const;
function optionsFor(target: object, options: Record<string, unknown>) {
  for (const [key, value] of Object.entries(options))
    if (Object.hasOwn(target, key))
      (target as Record<string, unknown>)[key] = value;
}

/** Education-owned private lesson work record. Mutations go through LessonWorkService. */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'workbook_activities',
  conflictColumns: ['tenant_id', 'enrollment_id', 'lesson_id'],
  ...closed,
})
export class LessonActivity extends SmrtObject {
  @tenantId() tenantId = '';
  @foreignKey('Learner', { required: true, requiredFor: 'identity' })
  learnerId = '';
  @field({ type: 'text', required: true, default: 'identified' })
  captureKind = 'identified';
  @foreignKey('WorkbookPhotoIntake', { nullable: true }) photoIntakeId:
    | string
    | null = null;
  // Explicit NO ACTION: these are now the natural key, which would otherwise
  // default to CASCADE and differ from the deployed foreign keys. Learning
  // history is never removed by deleting its enrollment or lesson.
  @foreignKey('Enrollment', {
    required: true,
    requiredFor: 'identity',
    onDelete: 'NO ACTION',
  })
  enrollmentId = '';
  @foreignKey('Lesson', {
    required: true,
    requiredFor: 'identity',
    onDelete: 'NO ACTION',
  })
  lessonId = '';
  constructor(options: Record<string, unknown> = {}) {
    super(options);
    optionsFor(this, options);
  }
  override async delete(): Promise<void> {
    throw new Error(
      'Lesson work history is immutable; deliberate family deletion requires an owning retention operation',
    );
  }
  override async save(options?: SmrtSaveOptions): Promise<this> {
    if (!this.tenantId.trim()) throw new Error('Lesson work requires tenant');
    if (this.id && (await this.db.get(this.tableName, { id: this.id })))
      throw new Error('Lesson work history is immutable');
    if (!['identified', 'unfiled'].includes(this.captureKind))
      throw new Error('Invalid lesson work capture kind');
    const enrollment = await this.db.get('enrollments', {
      id: this.enrollmentId,
      tenant_id: this.tenantId,
      learner_id: this.learnerId,
    });
    if (!enrollment) throw new Error('Lesson work enrollment mismatch');
    if (!(await this.db.get('lessons', { id: this.lessonId })))
      throw new Error('Lesson work lesson mismatch');
    if (this.captureKind === 'unfiled') {
      if (
        !this.photoIntakeId ||
        !(await this.db.get('workbook_photo_intakes', {
          id: this.photoIntakeId,
          tenant_id: this.tenantId,
          learner_id: this.learnerId,
        }))
      )
        throw new Error('Unfiled work requires an exact owned photo receipt');
      if (
        await this.db.get(this.tableName, {
          tenant_id: this.tenantId,
          photo_intake_id: this.photoIntakeId,
        })
      )
        throw new Error('Photo receipt already has a work unit');
      const lesson = await this.db.get('lessons', {
        id: this.lessonId,
        tenant_id: this.tenantId,
      });
      const section =
        lesson &&
        (await this.db.get('course_sections', {
          id: lesson.section_id,
          tenant_id: this.tenantId,
          course_id: enrollment.course_id,
        }));
      if (
        !section ||
        !(await this.db.get('courses', {
          id: enrollment.course_id,
          tenant_id: this.tenantId,
          license_kind: 'personal-use-copy',
          source_key: 'unfiled-work',
          source_ref: this.photoIntakeId,
        }))
      )
        throw new Error(
          'Unfiled work requires exact private technical routing',
        );
    } else if (this.photoIntakeId !== null)
      throw new Error('Placed lesson work has no unfiled receipt');
    return super.save(options);
  }
}
export class LessonActivityCollection extends SmrtCollection<LessonActivity> {
  static readonly _itemClass = LessonActivity;
}

/**
 * Append-only placement of unfiled work: the head names the course, the
 * learner's enrollment, lesson and optional lesson page the work now belongs
 * to. Activity, attempt, submission and assessment IDs never move.
 */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'lesson_work_filings',
  conflictColumns: ['tenant_id', 'source_activity_id', 'request_key'],
  ...closed,
})
export class LessonWorkFiling extends SmrtObject {
  @tenantId() tenantId = '';
  @foreignKey('Learner', { required: true, requiredFor: 'identity' })
  learnerId = '';
  @foreignKey('LessonActivity', { required: true, requiredFor: 'identity' })
  sourceActivityId = '';
  @foreignKey('Course', { required: true, requiredFor: 'identity' })
  courseId = '';
  @foreignKey('Enrollment', { required: true, requiredFor: 'identity' })
  enrollmentId = '';
  @foreignKey('Lesson', { required: true, requiredFor: 'identity' })
  lessonId = '';
  @foreignKey('LessonPage', { nullable: true }) lessonPageId: string | null =
    null;
  @foreignKey('LessonWorkFiling', { nullable: true }) previousRevisionId:
    | string
    | null = null;
  actorUserId = '';
  requestKey = '';
  reason = '';
  digest = '';
  recordedAt = new Date();
  constructor(options: Record<string, unknown> = {}) {
    super(options);
    optionsFor(this, options);
  }
  override async delete(): Promise<void> {
    throw new Error('Lesson work history is immutable');
  }
  override async save(options?: SmrtSaveOptions): Promise<this> {
    if (this.id && (await this.db.get(this.tableName, { id: this.id })))
      throw new Error('Lesson work history is immutable');
    const owner = { tenant_id: this.tenantId, learner_id: this.learnerId };
    const enrollment =
      this.tenantId &&
      (await this.db.get('enrollments', { ...owner, id: this.enrollmentId }));
    if (
      !this.tenantId ||
      !this.actorUserId ||
      !this.requestKey.trim() ||
      !this.reason.trim() ||
      !/^[a-f0-9]{64}$/.test(this.digest) ||
      !enrollment ||
      !(await this.db.get('workbook_activities', {
        ...owner,
        id: this.sourceActivityId,
        capture_kind: 'unfiled',
      }))
    )
      throw new Error('Lesson work filing ownership mismatch');
    const lesson = await this.db.get('lessons', { id: this.lessonId });
    const section =
      lesson &&
      (await this.db.get('course_sections', {
        id: lesson.section_id,
        course_id: this.courseId,
      }));
    if (!section || String(enrollment.course_id) !== this.courseId)
      throw new Error('Lesson work filing target mismatch');
    if (
      this.lessonPageId &&
      !(await this.db.get('lesson_pages', {
        id: this.lessonPageId,
        lesson_id: this.lessonId,
      }))
    )
      throw new Error('Lesson work filing page mismatch');
    if (
      this.previousRevisionId &&
      !(await this.db.get(this.tableName, {
        ...owner,
        id: this.previousRevisionId,
        source_activity_id: this.sourceActivityId,
      }))
    )
      throw new Error('Lesson work filing predecessor mismatch');
    if (
      await this.db.get(this.tableName, {
        ...owner,
        source_activity_id: this.sourceActivityId,
        previous_revision_id: this.previousRevisionId,
      })
    )
      throw new Error('Lesson work filing predecessor already superseded');
    return super.save(options);
  }
}
export class LessonWorkFilingCollection extends SmrtCollection<LessonWorkFiling> {
  static readonly _itemClass = LessonWorkFiling;
}

/** Education-owned private lesson work record. Mutations go through LessonWorkService. */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'workbook_attempts',
  conflictColumns: ['tenant_id', 'submission_id'],
  ...closed,
})
export class WorkAttempt extends SmrtObject {
  @tenantId() tenantId = '';
  @foreignKey('Learner', { required: true, requiredFor: 'identity' })
  learnerId = '';
  @foreignKey('LessonActivity', { required: true, requiredFor: 'identity' })
  activityId = '';
  @foreignKey('Submission', { required: true, requiredFor: 'identity' })
  submissionId = '';
  @foreignKey('WorkAttempt', { nullable: true }) previousAttemptId:
    | string
    | null = null;
  capturedAt = new Date();
  episodeId = '';
  reviewRequired = true;
  policyVersion = 1;
  assistance = 'unknown';
  actorUserId = '';
  @field({ type: 'text' }) sourceHashes = '[]';
  constructor(options: Record<string, unknown> = {}) {
    super(options);
    optionsFor(this, options);
  }
  override async delete(): Promise<void> {
    throw new Error(
      'Lesson work history is immutable; deliberate family deletion requires an owning retention operation',
    );
  }
  override async save(options?: SmrtSaveOptions): Promise<this> {
    if (!this.tenantId.trim()) throw new Error('Lesson work requires tenant');
    if (this.id && (await this.db.get(this.tableName, { id: this.id })))
      throw new Error('Lesson work history is immutable');
    if (
      !(await this.db.get('workbook_activities', {
        id: this.activityId,
        tenant_id: this.tenantId,
        learner_id: this.learnerId,
      }))
    )
      throw new Error('Lesson work parent ownership mismatch');
    if (
      !(await this.db.get('submissions', {
        id: this.submissionId,
        tenant_id: this.tenantId,
        learner_id: this.learnerId,
      }))
    )
      throw new Error('Lesson work submission mismatch');
    if (
      this.previousAttemptId &&
      !(await this.db.get(this.tableName, {
        id: this.previousAttemptId,
        tenant_id: this.tenantId,
        learner_id: this.learnerId,
        activity_id: this.activityId,
        episode_id: this.episodeId,
      }))
    )
      throw new Error('Lesson work correction identity mismatch');
    const sources: { assetId: string; sha256: string; pageCount: number }[] =
      JSON.parse(this.sourceHashes);
    if (!Array.isArray(sources) || !sources.length)
      throw new Error('Lesson work requires retained source hashes');
    for (const source of sources)
      if (
        !/^[a-f0-9]{64}$/.test(source.sha256) ||
        !Number.isSafeInteger(source.pageCount) ||
        source.pageCount < 1 ||
        !(await this.db.get('submission_assets', {
          submission_id: this.submissionId,
          asset_id: source.assetId,
          tenant_id: this.tenantId,
        }))
      )
        throw new Error('Lesson work retained source mismatch');
    if (!['independent', 'assisted', 'unknown'].includes(this.assistance))
      throw new Error('Invalid assistance');
    return super.save(options);
  }
}
export class WorkAttemptCollection extends SmrtCollection<WorkAttempt> {
  static readonly _itemClass = WorkAttempt;
}

/** Education-owned private lesson work record. Mutations go through LessonWorkService. */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'workbook_assessment_revisions',
  conflictColumns: ['tenant_id', 'attempt_id', 'request_key'],
  ...closed,
})
export class WorkAssessmentRevision extends SmrtObject {
  @tenantId() tenantId = '';
  @foreignKey('Learner', { required: true, requiredFor: 'identity' })
  learnerId = '';
  @foreignKey('WorkAttempt', { required: true, requiredFor: 'identity' })
  attemptId = '';
  requestKey = '';
  requestDigest = '';
  kind = 'ai';
  actorUserId = '';
  @foreignKey('WorkAssessmentRevision', { nullable: true })
  sourceRevisionId: string | null = null;
  decisionReason = '';
  @foreignKey('WorkAssessmentRevision', { nullable: true }) supersedesId:
    | string
    | null = null;
  @field({ type: 'text' }) assessmentJson = '{}';
  recordedAt = new Date();
  constructor(options: Record<string, unknown> = {}) {
    super(options);
    optionsFor(this, options);
  }
  override async delete(): Promise<void> {
    throw new Error(
      'Lesson work history is immutable; deliberate family deletion requires an owning retention operation',
    );
  }
  override async save(options?: SmrtSaveOptions): Promise<this> {
    if (!this.tenantId.trim()) throw new Error('Lesson work requires tenant');
    if (this.id && (await this.db.get(this.tableName, { id: this.id })))
      throw new Error('Lesson work history is immutable');
    validateWorkAssessment(JSON.parse(this.assessmentJson) as WorkAssessment);
    if (
      !(await this.db.get('workbook_attempts', {
        id: this.attemptId,
        tenant_id: this.tenantId,
        learner_id: this.learnerId,
      }))
    )
      throw new Error('Lesson work parent ownership mismatch');
    if (
      this.sourceRevisionId &&
      !(await this.db.get(this.tableName, {
        id: this.sourceRevisionId,
        tenant_id: this.tenantId,
        learner_id: this.learnerId,
        attempt_id: this.attemptId,
      }))
    )
      throw new Error('Lesson work reviewed source mismatch');
    // Entries that pin an authored revision must name immutable rows this tenant owns.
    const assessment = JSON.parse(this.assessmentJson) as WorkAssessment;
    for (const [column, table, ids] of [
      [
        'question revision',
        'question_revisions',
        assessment.questions.map((q) => q.questionRevisionId),
      ],
      [
        'lesson revision',
        'lesson_revisions',
        assessment.questions.map((q) => q.lessonRevisionId),
      ],
    ] as const)
      for (const id of new Set(ids.filter((v): v is string => !!v)))
        if (!(await this.db.get(table, { id, tenant_id: this.tenantId })))
          throw new Error(`Lesson work ${column} reference mismatch`);
    if (!['ai', 'guardian'].includes(this.kind))
      throw new Error('Invalid revision kind');
    return super.save(options);
  }
}
export class WorkAssessmentRevisionCollection extends SmrtCollection<WorkAssessmentRevision> {
  static readonly _itemClass = WorkAssessmentRevision;
}

/** Education-owned private lesson work record. Mutations go through LessonWorkService. */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'workbook_feedback_releases',
  conflictColumns: ['tenant_id', 'attempt_id', 'request_key'],
  ...closed,
})
export class WorkFeedbackRelease extends SmrtObject {
  @tenantId() tenantId = '';
  @foreignKey('Learner', { required: true, requiredFor: 'identity' })
  learnerId = '';
  @foreignKey('WorkAttempt', { required: true, requiredFor: 'identity' })
  attemptId = '';
  @foreignKey('WorkAssessmentRevision', {
    required: true,
    requiredFor: 'identity',
  })
  revisionId = '';
  @foreignKey('WorkAssessmentRevision', { nullable: true }) expectedHeadId:
    | string
    | null = null;
  requestKey = '';
  actorUserId = '';
  recordedAt = new Date();
  constructor(options: Record<string, unknown> = {}) {
    super(options);
    optionsFor(this, options);
  }
  override async delete(): Promise<void> {
    throw new Error(
      'Lesson work history is immutable; deliberate family deletion requires an owning retention operation',
    );
  }
  override async save(options?: SmrtSaveOptions): Promise<this> {
    if (!this.tenantId.trim()) throw new Error('Lesson work requires tenant');
    if (this.id && (await this.db.get(this.tableName, { id: this.id })))
      throw new Error('Lesson work history is immutable');
    if (
      !(await this.db.get('workbook_attempts', {
        id: this.attemptId,
        tenant_id: this.tenantId,
        learner_id: this.learnerId,
      }))
    )
      throw new Error('Lesson work parent ownership mismatch');
    if (
      !(await this.db.get('workbook_assessment_revisions', {
        id: this.revisionId,
        tenant_id: this.tenantId,
        learner_id: this.learnerId,
        attempt_id: this.attemptId,
      }))
    )
      throw new Error('Lesson work release revision mismatch');
    return super.save(options);
  }
}
export class WorkFeedbackReleaseCollection extends SmrtCollection<WorkFeedbackRelease> {
  static readonly _itemClass = WorkFeedbackRelease;
}

/** Authenticated delivery acknowledgment; this does not assert comprehension. */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'workbook_feedback_deliveries',
  conflictColumns: ['tenant_id', 'attempt_id', 'actor_user_id', 'revision_id'],
  ...closed,
})
export class WorkFeedbackDelivery extends SmrtObject {
  @tenantId() tenantId = '';
  @foreignKey('Learner', { required: true, requiredFor: 'identity' })
  learnerId = '';
  @foreignKey('WorkAttempt', { required: true, requiredFor: 'identity' })
  attemptId = '';
  @foreignKey('WorkAssessmentRevision', {
    required: true,
    requiredFor: 'identity',
  })
  revisionId = '';
  actorUserId = '';
  requestKey = '';
  recordedAt = new Date();
  constructor(options: Record<string, unknown> = {}) {
    super(options);
    optionsFor(this, options);
  }
  override async save(options?: SmrtSaveOptions): Promise<this> {
    if (this.id && (await this.db.get(this.tableName, { id: this.id })))
      throw new Error('Lesson work delivery history is immutable');
    if (
      !(await this.db.get('workbook_assessment_revisions', {
        id: this.revisionId,
        tenant_id: this.tenantId,
        learner_id: this.learnerId,
        attempt_id: this.attemptId,
      }))
    )
      throw new Error('Lesson work delivery revision mismatch');
    if (
      !(await this.db.get('learners', {
        id: this.learnerId,
        tenant_id: this.tenantId,
        user_id: this.actorUserId,
      }))
    )
      throw new Error('Lesson work delivery must name own learner');
    return super.save(options);
  }
  override async delete(): Promise<void> {
    throw new Error('Lesson work delivery history is immutable');
  }
}
export class WorkFeedbackDeliveryCollection extends SmrtCollection<WorkFeedbackDelivery> {
  static readonly _itemClass = WorkFeedbackDelivery;
}
