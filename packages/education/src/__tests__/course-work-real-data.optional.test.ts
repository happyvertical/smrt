import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import { getTestManifestPath } from '@happyvertical/smrt-vitest';
import { getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { migrateWorkbooksToCourses } from '../course-work-migration.js';
import { LessonWorkService } from '../lesson-work-service.js';

/**
 * Opt-in end-to-end proof on a copy of a real pre-#4614 SQLite database:
 * HEARTH_LEGACY_DB=/path/to/copy.sqlite. The file is copied again before use;
 * nothing is written to it. Skipped when the variable is unset.
 */
const source = process.env.HEARTH_LEGACY_DB;
beforeAll(() => enableTenancy());
afterAll(() => disableTenancy());
(source ? it : it.skip)(
  'migrates a real legacy database through the normal schema step, the data step and new hand-ins',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hearth-legacy-'));
    const path = join(dir, 'copy.sqlite');
    copyFileSync(source as string, path);
    const db = await getDatabase({
      type: 'sqlite',
      url: path,
      cache: false,
    } as never);
    try {
      const manifest = JSON.parse(readFileSync(getTestManifestPath(), 'utf8'));
      // Every registered table the host migrates together (education,
      // assets, users, profiles, ingestion ...).
      const schemas = Object.fromEntries(
        Object.values(ObjectRegistry.getAllSchemasAsDefinitions()).map(
          (schema) => [schema.tableName, schema],
        ),
      );
      const diff = await new SchemaComparer(db, {
        engineHint: 'sqlite',
      }).compare(schemas);
      // Nothing that needs a manual rebuild or intervention.
      const education = new Set(
        Object.keys(manifest.objects)
          .filter((k) => k.startsWith('@happyvertical/smrt-education:'))
          .map((k) => ObjectRegistry.getSchema(k.split(':')[1])?.tableName),
      );
      const blocking = diff.changes.filter(
        (c) =>
          (education.has(c.table) && c.advisory?.severity === 'warning') ||
          /foreign_key|rebuild/.test(String(c.type)),
      );
      expect(blocking.map((c) => `${c.type} ${c.table}.${c.name}`)).toEqual([]);
      const generated = new MigrationGenerator({
        engine: 'sqlite',
      }).generateFromDiff(diff, {
        name: 'course_work_real',
      });
      const applied = await new MigrationTracker({
        db,
        engineHint: 'sqlite',
        useConcurrentIndexes: false,
      }).applyAll(
        [
          createMigrationDefinition(
            '20261103_course_work_real',
            generated.up.filter((sql) => !sql.trimStart().startsWith('--')),
            generated.down,
            {
              packageName: '@happyvertical/smrt-education',
              version: '0.57.52',
            },
          ),
        ],
        { postgresSafe: false },
      );
      expect(applied.map((r) => r.error?.message ?? 'ok')).toEqual(['ok']);
      const after = await new SchemaComparer(db, {
        engineHint: 'sqlite',
      }).compare(schemas);
      expect(
        getSQLFromDiff(after).filter((sql) => !sql.startsWith('--')),
      ).toEqual([]);

      const before = {
        activities: await db.list('workbook_activities', {}),
        submissions: await db.list('submissions', {}),
        attempts: await db.list('workbook_attempts', {}),
      };
      const report = await migrateWorkbooksToCourses(db);
      expect(await migrateWorkbooksToCourses(db)).toEqual({
        bookCourses: 0,
        mergedCourses: 0,
        lessonPages: 0,
        filings: 0,
        contextRevisions: 0,
      });
      console.log('real-data migration report', report);
      expect(await db.list('workbook_activities', {})).toEqual(
        before.activities,
      );
      expect(await db.list('submissions', {})).toEqual(before.submissions);
      expect(await db.list('workbook_attempts', {})).toEqual(before.attempts);
      // Filed destinations start at the work's first capture, not today.
      for (const filing of await db.list('lesson_work_filings', {})) {
        const attempts = await db.list('workbook_attempts', {
          activity_id: filing.source_activity_id,
        });
        if (!attempts.length) continue;
        const progress = await db.get('lesson_progress', {
          enrollment_id: filing.enrollment_id,
          lesson_id: filing.lesson_id,
        });
        expect(new Date(progress?.started_at as string).getTime()).toBe(
          Math.min(
            ...attempts.map((a) => new Date(a.captured_at as string).getTime()),
          ),
        );
      }
      expect((await db.list('lesson_work_filings', {})).length).toBe(
        (await db.list('workbook_work_filings', {})).length,
      );

      // Actors from the data: a learner and a guardian with a relationship.
      const [learner] = await db.list('learners', {});
      const relationship = (
        await db.list('profile_relationships', {
          to_profile_id: learner.profile_id,
        })
      )[0];
      const guardianUser = await db.get('users', {
        profile_id: relationship.from_profile_id,
      });
      const tenantId = String(learner.tenant_id);
      const own = {
        tenantId,
        actorUserId: String(learner.user_id),
        learnerId: String(learner.id),
      };
      const parent = {
        ...own,
        actorUserId: String(guardianUser?.id),
        guardianRelationshipId: String(relationship.id),
      };
      const service = new LessonWorkService(
        db,
        ({ own: self, relationshipTypeId }) =>
          self || relationshipTypeId === relationship.type_id,
        () => true,
        { storage: dir },
      );
      const as = <T>(r: typeof own, fn: () => Promise<T>) =>
        withTenant({ tenantId, userId: r.actorUserId }, fn);
      // A new ordinary hand-in on a plain course lesson.
      const enrollments = await db.list('enrollments', {
        learner_id: learner.id,
      });
      let ordinary: { id: string } | null = null;
      for (const enrollment of enrollments) {
        const course = await db.get('courses', { id: enrollment.course_id });
        if (!course || course.book_key || course.source_key === 'unfiled-work')
          continue;
        const sections = await db.list('course_sections', {
          course_id: course.id,
        });
        // The copy's plain lessons may all be done: add one fresh lesson to
        // the copy (never the source) so a new hand-in has somewhere to go.
        const [template] = sections.length
          ? await db.list('lessons', { section_id: sections[0].id })
          : [];
        if (template) {
          const lesson = {
            ...template,
            id: globalThis.crypto.randomUUID(),
            slug: globalThis.crypto.randomUUID(),
            title: 'Post-migration lesson',
          };
          const columns = Object.keys(lesson);
          await db.query(
            `INSERT INTO lessons (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
            Object.values(lesson),
          );
        }
        for (const section of sections)
          for (const lesson of await db.list('lessons', {
            section_id: section.id,
          })) {
            if (ordinary) break;
            const progress = await db.get('lesson_progress', {
              enrollment_id: enrollment.id,
              lesson_id: lesson.id,
            });
            if (
              progress &&
              ['submitted', 'needs_review', 'complete', 'skipped'].includes(
                String(progress.status),
              )
            )
              continue;
            ordinary = await as(own, () =>
              service.captureSubmission({
                ...own,
                enrollmentId: String(enrollment.id),
                lessonId: String(lesson.id),
                requestKey: 'post-migration-ordinary',
                pages: [
                  {
                    name: 'o.png',
                    mimeType: 'image/png',
                    data: Buffer.from('ordinary'),
                  },
                ],
              }),
            );
          }
      }
      expect(ordinary).not.toBeNull();
      expect(
        await db.get('workbook_attempts', { submission_id: ordinary?.id }),
      ).toBeTruthy();
      // A new book-page capture in the migrated book.
      const book = (await db.list('courses', { tenant_id: tenantId })).find(
        (c) => c.book_key,
      );
      expect(book).toBeTruthy();
      const page = await as(parent, () =>
        service.resolveBookPageActivity({
          ...parent,
          bookKey: String(book?.book_key),
          title: String(book?.title),
          edition: String(book?.book_edition ?? ''),
          pageKey: 'post-migration-p1',
          pageLabel: 'Post-migration page',
        }),
      );
      const capture = await as(own, () =>
        service.captureLessonWork({
          ...own,
          activityId: page.id,
          requestKey: 'post-migration-book',
          pages: [
            {
              name: 'b.png',
              mimeType: 'image/png',
              data: Buffer.from('book page'),
            },
          ],
        }),
      );
      expect(capture.pages.map((p) => p.pageKey)).toEqual(['p1']);
      const fresh = await db.get('workbook_activities', { id: page.id });
      expect(fresh).toMatchObject({
        workbook_id: null,
        page_key: null,
        page_label: null,
      });
    } finally {
      await db.close?.();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
