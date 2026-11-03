import { withTenant } from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import {
  CourseCollection,
  CourseSectionCollection,
  CurriculumCollection,
  EnrollmentCollection,
  LessonProgressCollection,
  WorksheetCollection,
} from './collections.js';
import { LessonPageCollection } from './lesson-pages.js';
import { readWorkCompletion } from './lesson-work-completion.js';
import { LessonWorkFilingCollection } from './lesson-work-models.js';
import { BookContextRevisionCollection } from './workbook-photo-models.js';

/** What one run of {@link migrateWorkbooksToCourses} changed. */
export interface WorkbookMigrationReport {
  /** Book courses given their identity (existing scaffold or new). */
  bookCourses: number;
  /** Learner-scoped duplicate courses merged into a book course. */
  mergedCourses: number;
  lessonPages: number;
  filings: number;
  contextRevisions: number;
}

type Row = Record<string, unknown>;
/** Each family's rows are written inside that family's tenant context. */
const asTenant = <T>(tenantId: string, fn: () => Promise<T>) =>
  withTenant({ tenantId }, fn);
const str = (value: unknown) => (value == null ? '' : String(value));
const truthy = (value: unknown) =>
  value === true ||
  value === 1 ||
  value === '1' ||
  value === 't' ||
  value === 'true';
const time = (row: Row) => {
  const value = row.created_at;
  return value ? new Date(value as string).getTime() : 0;
};
const byAge = (a: Row, b: Row) =>
  time(a) - time(b) || str(a.id).localeCompare(str(b.id));

function createHash() {
  const crypto =
    typeof process !== 'undefined' && process.getBuiltinModule?.('node:crypto');
  if (!crypto) throw new Error('The workbook migration requires a Node server');
  return crypto.createHash('sha256');
}
function digest(parts: unknown[]) {
  return createHash().update(JSON.stringify(parts)).digest('hex');
}
function deterministicId(parts: unknown[]): string {
  const hex = digest(parts);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${(
    (Number.parseInt(hex[16], 16) & 3) | 8
  ).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Move retired `Workbook` data into book courses (SMRT #4614). Host-run, once,
 * after the schema migration that adds `courses.book_key`, `lesson_pages`,
 * `lesson_work_filings` and `book_context_revisions`. Idempotent and
 * transactional; a no-op when the retired `workbooks` table does not exist.
 *
 * One course per family per book key: the earliest learner's scaffold course
 * becomes the book course and later learners' scaffold courses merge into it
 * (their sections and enrollments are re-pointed; the emptied course is
 * archived as `merged-book`). Learner history rows are never rewritten. Legacy
 * page keys become lesson pages, legacy filings become placements with the same
 * IDs, and cover context revisions are copied with the same IDs. Retired tables
 * are left in place.
 */
export async function migrateWorkbooksToCourses(
  db: DatabaseInterface,
): Promise<WorkbookMigrationReport> {
  const report: WorkbookMigrationReport = {
    bookCourses: 0,
    mergedCourses: 0,
    lessonPages: 0,
    filings: 0,
    contextRevisions: 0,
  };
  if (!(await db.tableExists('workbooks'))) return report;
  const transaction = db.transaction?.bind(db);
  if (!transaction) throw new Error('Database transaction support is required');
  await transaction(async (tx: DatabaseInterface) => {
    // The retired natural key (tenant, workbook, page). New activities carry no
    // book link, and PostgreSQL's NULLS NOT DISTINCT would make them collide.
    await tx.query(
      'DROP INDEX IF EXISTS workbook_activities_tenant_id_workbook_id_idx',
    );
    const courseFor = new Map<string, string>();
    const books = (await tx.list('workbooks', {})).sort(byAge);
    const groups = new Map<string, Row[]>();
    for (const book of books) {
      const key = JSON.stringify([str(book.tenant_id), str(book.workbook_key)]);
      groups.set(key, [...(groups.get(key) ?? []), book]);
    }
    const courses = await CourseCollection.create({ db: tx });
    for (const group of groups.values())
      await asTenant(str(group[0].tenant_id), async () => {
        const tenantId = str(group[0].tenant_id);
        const bookKey = str(group[0].workbook_key);
        const scaffolds: Row[] = [];
        for (const book of group)
          scaffolds.push(
            ...(
              await tx.list('courses', {
                tenant_id: tenantId,
                source_key: 'physical-workbook',
                source_ref: str(book.id),
              })
            ).sort(byAge),
          );
        let canonical = await courses.get(
          { tenantId, bookKey },
          { cache: false },
        );
        const reviewRequired = group.some((b) => truthy(b.review_required));
        const policyVersion = Math.max(
          1,
          ...group.map((b) => Number(b.policy_version) || 1),
        );
        if (!canonical) {
          const first = scaffolds[0];
          if (first) {
            canonical = await courses.get(
              { id: str(first.id), tenantId },
              { cache: false },
            );
            if (!canonical)
              throw new Error('Workbook scaffold course vanished');
            canonical.bookKey = bookKey;
            canonical.bookEdition = str(group[0].edition);
            canonical.title = str(group[0].title) || canonical.title;
            canonical.sourceKey = 'book';
            canonical.sourceRef = bookKey;
            canonical.workReviewRequired = reviewRequired;
            canonical.workPolicyVersion = policyVersion;
            await canonical.save();
          } else
            canonical = await courses.create({
              _insertOnly: true,
              id: deterministicId(['book-course', tenantId, bookKey]),
              slug: `book-${digest([tenantId, bookKey])}`,
              tenantId,
              title: str(group[0].title),
              licenseKind: 'personal-use-copy',
              sourceKey: 'book',
              sourceRef: bookKey,
              modality: 'printable',
              bookKey,
              bookEdition: str(group[0].edition),
              workReviewRequired: reviewRequired,
              workPolicyVersion: policyVersion,
            });
          report.bookCourses++;
        }
        const canonicalId = String(canonical.id);
        for (const scaffold of scaffolds) {
          if (str(scaffold.id) === canonicalId) continue;
          const params = [canonicalId, str(scaffold.id), tenantId];
          await tx.query(
            'UPDATE course_sections SET course_id = ? WHERE course_id = ? AND tenant_id = ?',
            params,
          );
          await tx.query(
            'UPDATE enrollments SET course_id = ? WHERE course_id = ? AND tenant_id = ?',
            params,
          );
          await tx.query(
            'UPDATE courses SET status = ?, source_key = ?, source_ref = ? WHERE id = ? AND tenant_id = ?',
            [
              'archived',
              'merged-book',
              canonicalId,
              str(scaffold.id),
              tenantId,
            ],
          );
          report.mergedCourses++;
        }
        for (const book of group) courseFor.set(str(book.id), canonicalId);
      });

    // Legacy page identity becomes structure on each page lesson.
    const pages = await LessonPageCollection.create({ db: tx });
    const activities = (await tx.list('workbook_activities', {})).sort(byAge);
    const activityById = new Map(activities.map((a) => [str(a.id), a]));
    const pageFor = async (activity: Row): Promise<string | null> => {
      const courseId = courseFor.get(str(activity.workbook_id));
      const pageKey = str(activity.page_key);
      if (!courseId || !pageKey) return null;
      return asTenant(str(activity.tenant_id), async () => {
        const existing = await pages.get(
          { lessonId: str(activity.lesson_id), pageKey },
          { cache: false },
        );
        if (existing) return String(existing.id);
        const siblings = await tx.list('lesson_pages', {
          course_id: courseId,
        });
        const created = await pages.create({
          _insertOnly: true,
          tenantId: str(activity.tenant_id),
          courseId,
          lessonId: str(activity.lesson_id),
          pageKey,
          label: str(activity.page_label) || pageKey,
          sortOrder: siblings.length,
        });
        report.lessonPages++;
        return String(created.id);
      });
    };
    for (const activity of activities)
      if (activity.workbook_id) await pageFor(activity);

    // Legacy filings become placements, predecessors first, with their IDs.
    if (await tx.tableExists('workbook_work_filings')) {
      const filings = await LessonWorkFilingCollection.create({ db: tx });
      const legacy = (await tx.list('workbook_work_filings', {})).sort(byAge);
      const done = new Set<string>();
      const pending = [...legacy];
      while (pending.length) {
        const index = pending.findIndex(
          (f) =>
            !f.previous_revision_id ||
            done.has(str(f.previous_revision_id)) ||
            !legacy.some((l) => str(l.id) === str(f.previous_revision_id)),
        );
        if (index < 0) throw new Error('Legacy filing history is cyclic');
        const [filing] = pending.splice(index, 1);
        done.add(str(filing.id));
        await asTenant(str(filing.tenant_id), async () => {
          if (await tx.get('lesson_work_filings', { id: str(filing.id) }))
            return;
          const tenantId = str(filing.tenant_id);
          const learnerId = str(filing.learner_id);
          const courseId = courseFor.get(str(filing.workbook_id));
          if (!courseId) throw new Error('Legacy filing names an unknown book');
          const enrollmentId = await learnerEnrollment(
            tx,
            tenantId,
            learnerId,
            courseId,
          );
          let lessonId: string;
          let lessonPageId: string | null = null;
          const canonical = filing.canonical_activity_id
            ? activityById.get(str(filing.canonical_activity_id))
            : undefined;
          if (canonical) {
            lessonId = str(canonical.lesson_id);
            lessonPageId = await pageFor(canonical);
          } else
            lessonId = await capturedWorkLesson(
              tx,
              tenantId,
              courseId,
              str(filing.id),
            );
          await filings.create({
            _insertOnly: true,
            id: str(filing.id),
            tenantId,
            learnerId,
            sourceActivityId: str(filing.source_activity_id),
            courseId,
            enrollmentId,
            lessonId,
            lessonPageId,
            previousRevisionId: filing.previous_revision_id
              ? str(filing.previous_revision_id)
              : null,
            actorUserId: str(filing.actor_user_id),
            requestKey: str(filing.request_key),
            reason: str(filing.reason),
            digest: str(filing.digest),
            recordedAt: filing.created_at
              ? new Date(filing.created_at as string)
              : new Date(),
          });
          await placedProgress(
            tx,
            tenantId,
            learnerId,
            str(filing.source_activity_id),
            enrollmentId,
            lessonId,
          );
          report.filings++;
        });
      }
    }

    // Cover/reference context follows its book into the course.
    if (await tx.tableExists('workbook_context_revisions')) {
      const contexts = await BookContextRevisionCollection.create({ db: tx });
      for (const row of (await tx.list('workbook_context_revisions', {})).sort(
        byAge,
      )) {
        if (await tx.get('book_context_revisions', { id: str(row.id) }))
          continue;
        const courseId = courseFor.get(str(row.workbook_id));
        if (!courseId) throw new Error('Legacy context names an unknown book');
        await asTenant(str(row.tenant_id), () =>
          contexts.create({
            _insertOnly: true,
            id: str(row.id),
            tenantId: str(row.tenant_id),
            learnerId: str(row.learner_id),
            courseId,
            decisionId: str(row.decision_id),
            metadataJson: str(row.metadata_json) || '{}',
          }),
        );
        report.contextRevisions++;
      }
    }
  });
  return report;
}

async function learnerEnrollment(
  tx: DatabaseInterface,
  tenantId: string,
  learnerId: string,
  courseId: string,
): Promise<string> {
  const existing = (
    await tx.list('enrollments', {
      tenant_id: tenantId,
      learner_id: learnerId,
      course_id: courseId,
    })
  )
    .filter((e) => e.status !== 'dropped')
    .sort(byAge)[0];
  if (existing) return str(existing.id);
  const course = await tx.get('courses', { id: courseId, tenant_id: tenantId });
  const key = digest([tenantId, learnerId, courseId]);
  const curriculum = await (
    await CurriculumCollection.create({ db: tx })
  ).create({
    _insertOnly: true,
    slug: `book-plan-${key}`,
    tenantId,
    learnerId,
    title: str(course?.title) || 'Book',
  });
  const enrollment = await (
    await EnrollmentCollection.create({ db: tx })
  ).create({
    _insertOnly: true,
    tenantId,
    learnerId,
    curriculumId: String(curriculum.id),
    courseId,
    status: 'active',
  });
  return String(enrollment.id);
}

/** A legacy filing that named only a book gets its own captured-work lesson. */
async function capturedWorkLesson(
  tx: DatabaseInterface,
  tenantId: string,
  courseId: string,
  filingId: string,
): Promise<string> {
  const sections = (
    await tx.list('course_sections', {
      tenant_id: tenantId,
      course_id: courseId,
    })
  ).sort(
    (a, b) =>
      Number(a.sort_order ?? 0) - Number(b.sort_order ?? 0) || byAge(a, b),
  );
  const sectionId = sections[0]
    ? str(sections[0].id)
    : String(
        (
          await (
            await CourseSectionCollection.create({ db: tx })
          ).create({
            _insertOnly: true,
            slug: `book-pages-${courseId}`,
            tenantId,
            courseId,
            title: 'Pages',
          })
        ).id,
      );
  const lessons = await tx.list('lessons', {
    tenant_id: tenantId,
    section_id: sectionId,
  });
  const lesson = await (await WorksheetCollection.create({ db: tx })).create({
    _insertOnly: true,
    slug: `filed-work-${digest([courseId, filingId])}`,
    tenantId,
    sectionId,
    title: 'Captured work',
    sortOrder: lessons.length,
    completionRule: 'submit',
  });
  return String(lesson.id);
}

async function placedProgress(
  tx: DatabaseInterface,
  tenantId: string,
  learnerId: string,
  activityId: string,
  enrollmentId: string,
  lessonId: string,
) {
  const progress = await LessonProgressCollection.create({ db: tx });
  if (
    await progress.get(
      { tenantId, learnerId, enrollmentId, lessonId },
      { cache: false },
    )
  )
    return;
  const state = await readWorkCompletion(tx, {
    tenantId,
    learnerId,
    activityId,
  });
  const complete = state.completion.status === 'complete';
  await progress.create({
    tenantId,
    learnerId,
    enrollmentId,
    lessonId,
    status: complete ? 'complete' : 'submitted',
    // The work's first capture, not the migration date.
    startedAt: state.attempts.length
      ? new Date(
          Math.min(
            ...state.attempts.map((a) => new Date(a.capturedAt).getTime()),
          ),
        )
      : new Date(),
    completedAt: complete ? state.completion.completedAt : null,
    attempts: state.attempts.length,
  });
}
