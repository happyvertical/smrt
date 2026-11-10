import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getSQLFromDiff,
  ObjectRegistry,
  SchemaComparer,
} from '@happyvertical/smrt-core';
import {
  createMigrationDefinition,
  MigrationGenerator,
  MigrationTracker,
} from '@happyvertical/smrt-core/migrations';
import type { DatabaseInterface } from '@happyvertical/sql';
import { expect } from 'vitest';
import { migrateWorkbooksToCourses } from '../course-work-migration.js';
import { WORK_MATH_VOCABULARY } from '../lesson-work-contracts.js';
import { LessonWorkService } from '../lesson-work-service.js';
import { WorkbookPhotoService } from '../workbook-photo-service.js';
import { learnerFixture } from './learner-workflows.js';

type Engine = 'sqlite' | 'postgres';
/** `workbook_activities` as deployed before #4614 (captured from a real SQLite install). */
const LEGACY_SQLITE_ACTIVITIES = `CREATE TABLE "workbook_activities" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "slug" TEXT NOT NULL,
  "context" TEXT NOT NULL DEFAULT '',
  "created_at" DATETIME NOT NULL DEFAULT current_timestamp,
  "updated_at" DATETIME NOT NULL DEFAULT current_timestamp,
  "tenant_id" TEXT NOT NULL,
  "learner_id" TEXT NOT NULL,
  "workbook_id" TEXT ,
  "enrollment_id" TEXT NOT NULL,
  "lesson_id" TEXT NOT NULL,
  "page_key" TEXT,
  "page_label" TEXT, "capture_kind" TEXT NOT NULL DEFAULT 'identified', "photo_intake_id" TEXT REFERENCES "workbook_photo_intakes" ("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "workbook_activities_learner_id_learners_id_fkey" FOREIGN KEY ("learner_id") REFERENCES "learners" ("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "workbook_activities_workbook_id_workbooks_id_fkey" FOREIGN KEY ("workbook_id") REFERENCES "workbooks" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "workbook_activities_enrollment_id_enrollments_id_fkey" FOREIGN KEY ("enrollment_id") REFERENCES "enrollments" ("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "workbook_activities_lesson_id_lessons_id_fkey" FOREIGN KEY ("lesson_id") REFERENCES "lessons" ("id") ON DELETE NO ACTION ON UPDATE CASCADE
)`;
const LEGACY_SQLITE_ACTIVITY_INDEXES = [
  'CREATE UNIQUE INDEX "workbook_activities_tenant_id_workbook_id_idx" ON "workbook_activities" ("tenant_id", "workbook_id", "page_key")',
  'CREATE INDEX "workbook_activities_slug_context_idx" ON "workbook_activities" ("slug", "context")',
  'CREATE INDEX "workbook_activities_tenant_id_created_at_idx" ON "workbook_activities" ("tenant_id", "created_at")',
  'CREATE INDEX "workbook_activities_learner_id_idx" ON "workbook_activities" ("learner_id")',
  'CREATE INDEX "workbook_activities_workbook_id_idx" ON "workbook_activities" ("workbook_id")',
  'CREATE INDEX "workbook_activities_enrollment_id_idx" ON "workbook_activities" ("enrollment_id")',
  'CREATE INDEX "workbook_activities_lesson_id_idx" ON "workbook_activities" ("lesson_id")',
  'CREATE INDEX "workbook_activities_photo_intake_id_idx" ON "workbook_activities" ("photo_intake_id")',
];
const HISTORY = [
  'workbook_activities',
  'workbook_attempts',
  'workbook_assessment_revisions',
  'workbook_feedback_releases',
  'workbook_completion_decisions',
  'submissions',
  'submission_assets',
  'grades',
  'lesson_progress',
  'lessons',
];
const sorted = (rows: Record<string, unknown>[]) =>
  [...rows].sort((a, b) => String(a.id).localeCompare(String(b.id)));

/**
 * A realistic pre-#4614 family: two learners each with their own scaffold
 * course for the same book (colliding page p2), captured, marked, released and
 * completed work, a cover-only second book with context, an unfiled page filed
 * twice (a revision chain) and another family with the same book key.
 */
export async function assertWorkbookMigration(
  db: DatabaseInterface,
  engine: Engine,
) {
  const f = await learnerFixture(db);
  const other = await learnerFixture(db);
  const storage = await mkdtemp(join(tmpdir(), 'workbook-migration-'));
  const authorize = ({
    own,
    relationshipTypeId,
  }: {
    own: boolean;
    relationshipTypeId?: string | null;
  }) => own || relationshipTypeId === f.guardianType.id;
  const service = new WorkbookPhotoService(db, authorize, () => true, {
    storage,
  });
  const uuid = engine === 'postgres' ? 'UUID' : 'TEXT';
  const insert = async (table: string, row: Record<string, unknown>) => {
    const columns = Object.keys(row);
    await db.query(
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
      Object.values(row),
    );
  };
  const base = (tenantId: string) => ({
    id: randomUUID(),
    slug: randomUUID(),
    context: '',
    tenant_id: tenantId,
  });
  // Only this fixture's two families: a shared PostgreSQL test database also
  // holds rows written concurrently by other suites.
  const tenants = [f.parent.tenantId, other.parent.tenantId];
  const listOwn = async (table: string) =>
    (
      await Promise.all(tenants.map((t) => db.list(table, { tenant_id: t })))
    ).flat();
  try {
    // Legacy schema: the retired tables and activity columns.
    await db.query(
      `CREATE TABLE workbooks (id ${uuid} PRIMARY KEY, slug TEXT NOT NULL, context TEXT NOT NULL DEFAULT '', created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, tenant_id ${uuid} NOT NULL, learner_id ${uuid} NOT NULL, workbook_key TEXT, title TEXT, edition TEXT, review_required BOOLEAN, policy_version INTEGER)`,
    );
    await db.query(
      `CREATE TABLE workbook_work_filings (id ${uuid} PRIMARY KEY, slug TEXT NOT NULL, context TEXT NOT NULL DEFAULT '', created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, tenant_id ${uuid} NOT NULL, learner_id ${uuid} NOT NULL, source_activity_id ${uuid} NOT NULL, workbook_id ${uuid} NOT NULL, canonical_activity_id ${uuid}, previous_revision_id ${uuid}, actor_user_id TEXT, request_key TEXT, reason TEXT, digest TEXT)`,
    );
    await db.query(
      `CREATE TABLE workbook_context_revisions (id ${uuid} PRIMARY KEY, slug TEXT NOT NULL, context TEXT NOT NULL DEFAULT '', created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, tenant_id ${uuid} NOT NULL, learner_id ${uuid} NOT NULL, workbook_id ${uuid} NOT NULL, decision_id ${uuid} NOT NULL, metadata_json TEXT)`,
    );
    if (engine === 'sqlite') {
      // The exact deployed pre-#4614 table (real SQLite DDL, with its foreign
      // keys and the retired natural key), not the new schema plus columns.
      await db.query('DROP TABLE workbook_activities');
      await db.query(LEGACY_SQLITE_ACTIVITIES);
      for (const index of LEGACY_SQLITE_ACTIVITY_INDEXES) await db.query(index);
    } else {
      // A shared PostgreSQL test database already holds other suites' rows,
      // so add the legacy columns and a plain unique legacy key instead.
      for (const column of ['workbook_id', 'page_key', 'page_label'])
        await db.query(
          `ALTER TABLE workbook_activities ADD COLUMN ${column} ${column === 'workbook_id' ? uuid : 'TEXT'}`,
        );
      await db.query(
        'CREATE UNIQUE INDEX workbook_activities_tenant_id_workbook_id_idx ON workbook_activities (tenant_id, workbook_id, page_key)',
      );
    }

    const tenantId = f.parent.tenantId;
    const alice = f.parent.learnerId;
    const bob = String(f.sibling.id);
    const at = (minutes: number) =>
      new Date(Date.UTC(2026, 9, 1, 8, minutes)).toISOString();
    /** A legacy per-learner scaffold: course, section, plan, enrollment. */
    const scaffold = async (
      tenant: string,
      learnerId: string,
      book: string,
      minute: number,
    ) => {
      const course = {
        ...base(tenant),
        title: 'Spectrum Math 4',
        license_kind: 'personal-use-copy',
        source_key: 'physical-workbook',
        source_ref: book,
        // Legacy workbook pages were release-gated; until the book columns are
        // dropped below this stands in for that legacy behaviour.
        book_key: `legacy:${book}:${learnerId}`,
        modality: 'printable',
        status: 'draft',
        _meta_type: '@happyvertical/smrt-education:Course',
        created_at: at(minute),
      };
      await insert('courses', course);
      const section = {
        ...base(tenant),
        course_id: course.id,
        title: 'Workbook pages',
      };
      await insert('course_sections', section);
      const plan = {
        ...base(tenant),
        learner_id: learnerId,
        title: 'Spectrum Math 4',
      };
      await insert('curricula', plan);
      const enrollment = {
        ...base(tenant),
        learner_id: learnerId,
        curriculum_id: plan.id,
        course_id: course.id,
        status: 'active',
      };
      await insert('enrollments', enrollment);
      return { course, section, enrollment };
    };
    const page = async (
      tenant: string,
      learnerId: string,
      book: string,
      s: Awaited<ReturnType<typeof scaffold>>,
      key: string,
      minute: number,
    ) => {
      const lesson = {
        ...base(tenant),
        section_id: s.section.id,
        title: `Page ${key}`,
        completion_rule: 'submit',
        _meta_type: '@happyvertical/smrt-education:Worksheet',
      };
      await insert('lessons', lesson);
      const activity = {
        ...base(tenant),
        learner_id: learnerId,
        capture_kind: 'identified',
        enrollment_id: s.enrollment.id,
        lesson_id: lesson.id,
        workbook_id: book,
        page_key: key,
        page_label: `Page ${key}`,
        created_at: at(minute),
      };
      await insert('workbook_activities', activity);
      return { lessonId: lesson.id, id: activity.id };
    };
    const book = (
      tenant: string,
      learnerId: string,
      minute: number,
      extra = {},
    ) => ({
      ...base(tenant),
      learner_id: learnerId,
      workbook_key: 'isbn:9781483812137',
      title: 'Spectrum Math 4',
      edition: '2015',
      review_required: engine === 'postgres' ? true : 1,
      policy_version: 1,
      created_at: at(minute),
      ...extra,
    });
    const aliceBook = book(tenantId, alice, 1, {
      review_required: engine === 'postgres' ? false : 0,
      policy_version: 3,
    });
    const bobBook = book(tenantId, bob, 2);
    const coverBook = {
      ...book(tenantId, alice, 3),
      workbook_key: 'printed:cover-only',
      title: 'Reading Street',
      edition: '',
    };
    const otherBook = book(other.parent.tenantId, other.parent.learnerId, 4);
    for (const row of [aliceBook, bobBook, coverBook, otherBook])
      await insert('workbooks', row);
    const aliceScaffold = await scaffold(tenantId, alice, aliceBook.id, 1);
    const bobScaffold = await scaffold(tenantId, bob, bobBook.id, 2);
    const otherScaffold = await scaffold(
      other.parent.tenantId,
      other.parent.learnerId,
      otherBook.id,
      4,
    );
    const a1 = await page(
      tenantId,
      alice,
      aliceBook.id,
      aliceScaffold,
      'p1',
      5,
    );
    const a2 = await page(
      tenantId,
      alice,
      aliceBook.id,
      aliceScaffold,
      'p2',
      6,
    );
    const b2 = await page(tenantId, bob, bobBook.id, bobScaffold, 'p2', 7);
    const b3 = await page(tenantId, bob, bobBook.id, bobScaffold, 'p3', 8);
    const o1 = await page(
      other.parent.tenantId,
      other.parent.learnerId,
      otherBook.id,
      otherScaffold,
      'p1',
      9,
    );

    // Real history on the legacy activities through the unchanged pipeline.
    const capture = async (activityId: string, key: string) =>
      f.as(f.parent, () =>
        service.captureLessonWork({
          ...f.parent,
          activityId,
          requestKey: key,
          intakeItemId: key,
          pages: [
            {
              name: 'p.png',
              mimeType: 'image/png',
              data: Buffer.from(`legacy work ${key}`),
            },
          ],
        }),
      );
    const attempt = await capture(a1.id, 'alice-p1');
    const evidence = {
      ...f.parent,
      activityId: a1.id,
      submissionId: attempt.submissionId,
    };
    const anchors = await f.as(f.parent, () =>
      service.getWorkSourceAnchors(evidence),
    );
    const ai = await f.as(f.parent, () =>
      service.recordWorkAnalysis({
        ...evidence,
        requestKey: 'ai',
        assessment: {
          version: 1,
          feedback: 'Good',
          vocabulary: structuredClone(WORK_MATH_VOCABULARY),
          provenance: {
            provider: 'synthetic',
            model: 'test',
            configurationVersion: '1',
            rubricVersion: '1',
            inputHash: anchors[0].sha256,
            analysisId: 'legacy',
          },
          questions: [
            {
              id: 'q1',
              prompt: '2+2',
              answer: '4',
              result: 'correct',
              reason: 'none',
              feedback: 'Yes',
              points: 1,
              possiblePoints: 1,
              anchors: [{ ...anchors[0], page: 1, rect: [0, 0, 1, 1] }],
              conceptIds: ['math.addition'],
            },
          ],
        },
      }),
    );
    const reviewed = await f.as(f.parent, () =>
      service.reviewWorkAssessment({
        ...evidence,
        revisionId: ai.id,
        expectedHeadId: null,
        requestKey: 'review',
      }),
    );
    await f.as(f.parent, () =>
      service.releaseWorkFeedback({
        ...evidence,
        revisionId: reviewed.id,
        expectedHeadId: reviewed.id,
        requestKey: 'release',
      }),
    );
    await f.as(f.parent, () =>
      service.completeLessonActivity({
        ...evidence,
        expectedAttemptId: attempt.id,
        expectedHeadId: reviewed.id,
        requestKey: 'done',
      }),
    );
    await capture(a2.id, 'alice-p2');

    // An unfiled page, filed to the book twice (canonical activity, then book only).
    const receipt = {
      ...base(tenantId),
      learner_id: alice,
      item_id: 'loose-photo',
      actor_user_id: f.parent.actorUserId,
      content_digest: 'a'.repeat(64),
    };
    await insert('workbook_photo_intakes', receipt);
    const loose = await f.as(f.parent, () =>
      service.withTransaction((s) =>
        (
          s as unknown as {
            resolveUnfiledActivityInScope(r: unknown): Promise<{ id: string }>;
          }
        ).resolveUnfiledActivityInScope({ ...f.parent, intakeId: receipt.id }),
      ),
    );
    await capture(loose.id, 'loose-photo');
    const firstFiling = {
      ...base(tenantId),
      learner_id: alice,
      source_activity_id: loose.id,
      workbook_id: aliceBook.id,
      canonical_activity_id: a2.id,
      previous_revision_id: null,
      actor_user_id: f.parent.actorUserId,
      request_key: 'file-1',
      reason: 'It is page 2',
      digest: 'b'.repeat(64),
      created_at: at(20),
    };
    const secondFiling = {
      ...firstFiling,
      ...base(tenantId),
      canonical_activity_id: null,
      previous_revision_id: firstFiling.id,
      request_key: 'file-2',
      reason: 'Book only',
      digest: 'c'.repeat(64),
      created_at: at(21),
    };
    // Inserted newest first: the migration must order the chain itself.
    await insert('workbook_work_filings', secondFiling);
    await insert('workbook_work_filings', firstFiling);
    const decision = {
      ...base(tenantId),
      learner_id: alice,
      intake_id: receipt.id,
      request_key: 'cover',
      sequence: 1,
      actor_user_id: f.parent.actorUserId,
      body_json: '{"type":"resolve"}',
    };
    await insert('workbook_photo_decisions', decision);
    const context = {
      ...base(tenantId),
      learner_id: alice,
      workbook_id: coverBook.id,
      decision_id: decision.id,
      metadata_json: JSON.stringify({
        identification: {
          workbook: {
            workbookKey: coverBook.workbook_key,
            publisher: 'Pearson',
          },
        },
      }),
    };
    await insert('workbook_context_revisions', context);

    // Before the schema migration: the new course columns and tables are absent.
    const courseSchema = ObjectRegistry.getSchema('Course');
    const schemas = Object.fromEntries(
      [
        'Course',
        'LessonActivity',
        'LessonPage',
        'LessonWorkFiling',
        'BookContextRevision',
        // Foreign-key targets, so their deployed actions are compared too.
        'Enrollment',
        'Lesson',
        'Learner',
        'WorkbookPhotoIntake',
      ].map((name) => {
        // The host migrates from the runtime registry definitions; use the
        // same source so default foreign-key actions are the deployed ones.
        const table = ObjectRegistry.getSchema(name)?.tableName;
        const schema = Object.values(
          ObjectRegistry.getAllSchemasAsDefinitions(),
        ).find((definition) => definition.tableName === table);
        if (!schema) throw new Error(`Missing schema ${name}`);
        return [schema.tableName, schema];
      }),
    );
    if (!courseSchema) throw new Error('Missing course schema');
    // Children first: lesson_work_filings references lesson_pages.
    for (const table of [
      'lesson_work_filings',
      'lesson_pages',
      'book_context_revisions',
    ])
      await db.query(`DROP TABLE "${table}"`);
    for (const column of [
      'book_key',
      'book_edition',
      'work_review_required',
      'work_policy_version',
    ])
      await db.query(`ALTER TABLE "courses" DROP COLUMN "${column}"`);
    const before = Object.fromEntries(
      await Promise.all(
        HISTORY.map(async (t) => [t, sorted(await listOwn(t))] as const),
      ),
    );
    // Only SQLite uses the exact legacy activity table; the PostgreSQL
    // fixture starts with today's manifest and already has sync metadata.
    const addedActivityMetadata =
      engine === 'sqlite'
        ? {
            _sync_origin_device_id: null,
            _sync_revision: null,
          }
        : {};
    const diff = await new SchemaComparer(db, { engineHint: engine }).compare(
      schemas,
    );
    if (engine === 'sqlite') {
      // The deployed foreign keys must match the manifest exactly: SQLite
      // cannot alter a foreign key, so any drift would demand a rebuild.
      const activitySchema = schemas.workbook_activities;
      const live = (
        await db.query(
          "SELECT * FROM pragma_foreign_key_list('workbook_activities')",
        )
      ).rows as Array<Record<string, unknown>>;
      for (const column of ['learner_id', 'enrollment_id', 'lesson_id']) {
        const declared = activitySchema?.columns[column]?.foreignKey;
        const actual = live.find((row) => row.from === column);
        expect([actual?.table, actual?.on_delete, actual?.on_update]).toEqual([
          declared?.table,
          declared?.onDelete,
          declared?.onUpdate,
        ]);
      }
    }
    // The normal schema step applies: nothing needs a manual rebuild.
    expect(
      diff.changes
        .filter(
          (c) =>
            c.advisory?.severity === 'warning' ||
            /foreign_key|rebuild/.test(String(c.type)),
        )
        .map((c) => `${c.type} ${c.table}.${c.name}`),
    ).toEqual([]);
    expect(diff.added_tables.map((t) => t.tableName).sort()).toEqual([
      'book_context_revisions',
      'lesson_pages',
      'lesson_work_filings',
    ]);
    expect(
      diff.changes
        .filter((c) => c.type === 'add_column')
        .map((c) => [c.table, c.name])
        .sort(),
    ).toEqual([
      ['courses', 'book_edition'],
      ['courses', 'book_key'],
      ['courses', 'work_policy_version'],
      ['courses', 'work_review_required'],
      ...Object.keys(addedActivityMetadata).map((column) => [
        'workbook_activities',
        column,
      ]),
    ]);
    const generated = new MigrationGenerator({ engine }).generateFromDiff(
      diff,
      {
        name: 'course_work',
      },
    );
    const applied = await new MigrationTracker({
      db,
      engineHint: engine,
      useConcurrentIndexes: false,
    }).applyAll(
      [
        createMigrationDefinition(
          '20261103_course_work',
          // Advisory notes (the retired orphan columns) are comments, not SQL.
          generated.up.filter((sql) => !sql.trimStart().startsWith('--')),
          generated.down,
          { packageName: '@happyvertical/smrt-education', version: '0.57.51' },
        ),
      ],
      { postgresSafe: false },
    );
    expect(applied.every((r) => r.success)).toBe(true);
    const second = await new SchemaComparer(db, { engineHint: engine }).compare(
      schemas,
    );
    expect(second.added_tables).toEqual([]);
    expect(
      getSQLFromDiff(second).filter((sql) => !sql.startsWith('--')),
    ).toEqual([]);

    // The data migration.
    const report = await migrateWorkbooksToCourses(db);
    expect(report).toEqual({
      bookCourses: 3,
      mergedCourses: 1,
      lessonPages: 5,
      filings: 2,
      contextRevisions: 1,
    });
    const snapshot = async () =>
      Object.fromEntries(
        await Promise.all(
          [
            ...HISTORY,
            'courses',
            'course_sections',
            'enrollments',
            'curricula',
            'lesson_pages',
            'lesson_work_filings',
            'book_context_revisions',
          ].map(async (t) => [t, sorted(await listOwn(t))] as const),
        ),
      );
    const migrated = await snapshot();
    // Idempotent: a re-run changes nothing.
    expect(await migrateWorkbooksToCourses(db)).toEqual({
      bookCourses: 0,
      mergedCourses: 0,
      lessonPages: 0,
      filings: 0,
      contextRevisions: 0,
    });
    expect(await snapshot()).toEqual(migrated);

    // Lossless: every original learner history value is untouched, and
    // old activity rows remain untracked after the nullable additions.
    for (const table of HISTORY.filter(
      (t) => t !== 'lesson_progress' && t !== 'lessons',
    )) {
      const expected =
        table === 'workbook_activities'
          ? before[table].map((row) => ({ ...row, ...addedActivityMetadata }))
          : before[table];
      expect(sorted(await listOwn(table))).toEqual(expected);
    }
    // Lessons are unchanged; the one new lesson holds the book-only filing.
    const lessonsAfter = sorted(await listOwn('lessons'));
    expect(
      lessonsAfter.filter((l) => before.lessons.some((b) => b.id === l.id)),
    ).toEqual(before.lessons);
    expect(
      lessonsAfter
        .filter((l) => !before.lessons.some((b) => b.id === l.id))
        .map((l) => l.title),
    ).toEqual(['Captured work']);
    const progressIds = (await listOwn('lesson_progress')).map((r) => r.id);
    for (const row of before.lesson_progress)
      expect(progressIds).toContain(row.id);

    // One course per family per book key, the earlier learner's scaffold.
    const bookCourses = await db.list('courses', {
      tenant_id: tenantId,
      book_key: 'isbn:9781483812137',
    });
    expect(bookCourses.map((c) => c.id)).toEqual([aliceScaffold.course.id]);
    expect(bookCourses[0]).toMatchObject({
      source_key: 'book',
      book_edition: '2015',
    });
    // Raw PostgreSQL rows return BIGINT as text.
    expect(Number(bookCourses[0].work_policy_version)).toBe(3);
    // Strictest policy wins: Bob's copy required review.
    expect(
      [true, 1, '1'].includes(bookCourses[0].work_review_required as never),
    ).toBe(true);
    expect(
      await db.get('courses', { id: bobScaffold.course.id }),
    ).toMatchObject({
      status: 'archived',
      source_key: 'merged-book',
      source_ref: aliceScaffold.course.id,
    });
    expect(
      await db.get('enrollments', { id: bobScaffold.enrollment.id }),
    ).toMatchObject({ course_id: aliceScaffold.course.id });
    expect(
      await db.get('course_sections', { id: bobScaffold.section.id }),
    ).toMatchObject({ course_id: aliceScaffold.course.id });
    // The other family keeps its own course for the same key.
    expect(
      (
        await db.list('courses', {
          tenant_id: other.parent.tenantId,
          book_key: 'isbn:9781483812137',
        })
      ).map((c) => c.id),
    ).toEqual([otherScaffold.course.id]);
    // Cover-only book: a new book course with its context.
    const cover = await db.get('courses', {
      tenant_id: tenantId,
      book_key: 'printed:cover-only',
    });
    expect(cover).toMatchObject({
      title: 'Reading Street',
      source_key: 'book',
    });
    expect(
      await db.get('book_context_revisions', { id: context.id }),
    ).toMatchObject({ course_id: cover?.id, decision_id: decision.id });

    // Lesson pages for every legacy page; the merged collision keeps both.
    const pages = await db.list('lesson_pages', {
      course_id: aliceScaffold.course.id,
    });
    expect(pages.map((p) => [p.lesson_id, p.page_key]).sort()).toEqual(
      [
        [a1.lessonId, 'p1'],
        [a2.lessonId, 'p2'],
        [b2.lessonId, 'p2'],
        [b3.lessonId, 'p3'],
      ].sort(),
    );
    expect(
      await db.list('lesson_pages', { lesson_id: o1.lessonId }),
    ).toHaveLength(1);

    // Filings: same IDs, chain kept, first on page 2's lesson, then its own lesson.
    const first = await db.get('lesson_work_filings', { id: firstFiling.id });
    const latest = await db.get('lesson_work_filings', {
      id: secondFiling.id,
    });
    expect(first).toMatchObject({
      course_id: aliceScaffold.course.id,
      enrollment_id: aliceScaffold.enrollment.id,
      lesson_id: a2.lessonId,
      previous_revision_id: null,
    });
    expect(latest).toMatchObject({
      course_id: aliceScaffold.course.id,
      previous_revision_id: firstFiling.id,
    });
    expect(latest?.lesson_id).not.toBe(a2.lessonId);

    // The pipeline reads the migrated data.
    const looseView = await f.as(f.parent, () =>
      service.getLessonActivity({ ...f.parent, activityId: loose.id }),
    );
    expect(looseView).toMatchObject({
      courseId: aliceScaffold.course.id,
      bookKey: 'isbn:9781483812137',
      pageLabel: 'Captured work',
      filing: { state: 'filed', revisionId: secondFiling.id },
    });
    const done = await f.as(f.parent, () =>
      service.getLessonActivity({ ...f.parent, activityId: a1.id }),
    );
    expect(done).toMatchObject({
      courseId: aliceScaffold.course.id,
      pageKey: 'p1',
      completion: { status: 'complete' },
    });
    // Identification reuses each learner's own page lesson, never a sibling's.
    const identify = (learnerId: string, pageKey: string) =>
      f.as(f.parent, () =>
        service.resolveBookPageActivity({
          ...f.parent,
          learnerId,
          bookKey: 'isbn:9781483812137',
          title: 'Spectrum Math 4',
          edition: '2015',
          pageKey,
          pageLabel: `Page ${pageKey}`,
        }),
      );
    expect((await identify(alice, 'p2')).id).toBe(a2.id);
    const alicePage3 = await identify(alice, 'p3');
    expect(alicePage3.lessonId).toBe(b3.lessonId);
    expect(alicePage3.enrollmentId).toBe(aliceScaffold.enrollment.id);
    const books = await f.as(f.parent, () =>
      service.listPhotoBookCourses(f.parent),
    );
    expect(books.map((b) => [b.bookKey, b.publisher]).sort()).toEqual([
      ['isbn:9781483812137', undefined],
      ['printed:cover-only', 'Pearson'],
    ]);
    // New work is never blocked by the legacy unique page index.
    const fresh = new LessonWorkService(db, authorize, () => true, { storage });
    const p9 = await identify(alice, 'p9');
    const p10 = await f.as(f.parent, () =>
      fresh.resolveBookPageActivity({
        ...f.parent,
        bookKey: 'isbn:9781483812137',
        title: 'Spectrum Math 4',
        edition: '2015',
        pageKey: 'p10',
        pageLabel: 'Page p10',
      }),
    );
    expect(p9.id).not.toBe(p10.id);
    // New hand-ins insert beside the retired columns, which stay null: an
    // ordinary lesson through the generic path and a book page capture.
    const ordinary = await f.as(f.own, () =>
      service.captureSubmission({
        ...f.own,
        enrollmentId: String(f.enrollment.id),
        lessonId: String(f.lesson.id),
        requestKey: 'after-migration',
        pages: [
          { name: 'n.png', mimeType: 'image/png', data: Buffer.from('new') },
        ],
      }),
    );
    const bookPage = await f.as(f.parent, () =>
      service.captureLessonWork({
        ...f.parent,
        activityId: p9.id,
        requestKey: 'p9-capture',
        pages: [
          { name: 'p9.png', mimeType: 'image/png', data: Buffer.from('p9') },
        ],
      }),
    );
    for (const [activity, submission] of [
      [
        (
          await db.list('workbook_activities', {
            tenant_id: tenantId,
            lesson_id: String(f.lesson.id),
          })
        )[0],
        ordinary.id,
      ],
      [
        await db.get('workbook_activities', { id: p9.id }),
        bookPage.submissionId,
      ],
    ] as const) {
      expect(activity).toMatchObject({
        workbook_id: null,
        page_key: null,
        page_label: null,
      });
      expect(
        await db.get('workbook_attempts', { submission_id: submission }),
      ).toBeTruthy();
    }
  } finally {
    await rm(storage, { recursive: true, force: true });
  }
}
