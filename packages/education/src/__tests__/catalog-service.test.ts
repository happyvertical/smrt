import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssetCollection } from '@happyvertical/smrt-assets';
import { getTestDatabase } from '@happyvertical/smrt-core';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import { TenantCollection } from '@happyvertical/smrt-users';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CatalogAuthorizationError,
  CatalogService,
} from '../catalog-service.js';
import {
  CourseCollection,
  CourseSectionCollection,
  LessonAssetCollection,
  LessonCollection,
} from '../collections.js';

import {
  assertCatalogOwnerGuards,
  assertLessonAssetOwnerGuard,
  assertPersonalCopyPublicationGuard,
} from './publication-regression.js';

const courses = {
  list: async () => [
    { title: 'Open course', licenseKind: 'open-license' },
    { title: 'Family copy', licenseKind: 'personal-use-copy' },
  ],
};
const sections = { list: async () => [] };
const lessons = { list: async () => [] };
const assets = { byLeft: async () => [] };

beforeAll(() => enableTenancy());
afterAll(() => disableTenancy());

describe('CatalogService', () => {
  it('passes private exclusion into the allowlisted catalog query', async () => {
    let scopeRequest: unknown;
    let queryOptions: unknown;
    const service = new CatalogService(
      {
        list: async (options: unknown) => {
          queryOptions = options;
          return [{ title: 'Open course', licenseKind: 'open-license' }];
        },
      } as never,
      sections as never,
      lessons as never,
      assets as never,
      {
        withTenantCatalogReadScope: async (request, callback) => {
          scopeRequest = request;
          return callback();
        },
      },
      () => true,
    );
    await expect(
      service.findVisible({ tenantId: 'family-a', actorUserId: 'guardian-a' }),
    ).resolves.toEqual([{ title: 'Open course', licenseKind: 'open-license' }]);
    expect(queryOptions).toEqual({
      where: [
        [{ 'licenseKind !=': 'personal-use-copy' }],
        [{ licenseKind: null }],
      ],
    });
    expect(scopeRequest).toMatchObject({
      collections: expect.arrayContaining([
        '@happyvertical/smrt-education:Course',
      ]),
    });
  });

  it('requires a separate host authorization before revealing a family copy', async () => {
    const service = new CatalogService(
      courses as never,
      sections as never,
      lessons as never,
      assets as never,
      { withTenantCatalogReadScope: async (_request, callback) => callback() },
      ({ action }) => action === 'education.catalog.read',
    );
    await expect(
      service.findVisible({
        tenantId: 'family-a',
        actorUserId: 'learner-a',
        includePrivate: true,
      }),
    ).rejects.toBeInstanceOf(CatalogAuthorizationError);
  });

  it('fails closed before minting a tenancy read capability', async () => {
    let scoped = false;
    const service = new CatalogService(
      courses as never,
      sections as never,
      lessons as never,
      assets as never,
      {
        withTenantCatalogReadScope: async (_request, callback) => {
          scoped = true;
          return callback();
        },
      },
      () => false,
    );
    await expect(
      service.findVisible({ tenantId: 'family-a', actorUserId: 'learner-a' }),
    ).rejects.toBeInstanceOf(CatalogAuthorizationError);
    expect(scoped).toBe(false);
  });
});

describe('family copy persistence guard', () => {
  it.each([
    'sqlite',
    'duckdb',
  ] as const)('rejects personal-copy publication on %s without mutating persisted state', async (type) => {
    const db = await getTestDatabase({
      type,
      url: ':memory:',
      classes: ['Course'],
    });
    try {
      await assertPersonalCopyPublicationGuard(db);
    } finally {
      await db.close?.();
    }
  });

  it('compares child tenant ownership on SQLite', async () => {
    const type = 'sqlite';
    const db = await getTestDatabase({
      type,
      url: ':memory:',
      classes: ['Course', 'CourseSection', 'Lesson'],
    });
    try {
      await assertCatalogOwnerGuards(db);
    } finally {
      await db.close?.();
    }
  });

  it('compares asset join ownership on SQLite', async () => {
    const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    try {
      await assertLessonAssetOwnerGuard(db);
    } finally {
      await db.close?.();
    }
  });

  it('rejects tenant promotion and license relabeling before a write', async () => {
    const { Course } = await import('../catalog.js');
    const course = new Course({
      id: 'course-1',
      tenantId: 'group-a',
      licenseKind: 'open-license',
    });
    Object.defineProperty(course, 'db', {
      value: {
        get: async () => ({
          tenantId: 'family-a',
          licenseKind: 'personal-use-copy',
        }),
      },
    });
    await expect(course.save()).rejects.toThrow(
      'cannot change tenant or license kind',
    );
    course.tenantId = 'family-a';
    await expect(course.save()).rejects.toThrow(
      'cannot change tenant or license kind',
    );
  });
});

describe('CatalogService projections', () => {
  it('redacts worksheet answer URLs and answer-key assets for a learner', async () => {
    const lesson = {
      id: 'lesson-1',
      title: 'Worksheet',
      answerUrl: 'https://private.example/answer.pdf',
    };
    const service = new CatalogService(
      {
        list: async () => [{ id: 'course-1', licenseKind: 'open-license' }],
      } as never,
      {
        list: async () => [{ id: 'section-1', courseId: 'course-1' }],
      } as never,
      { list: async () => [lesson] } as never,
      {
        byLeft: async () => [
          { relationship: 'answer-key', assetId: 'answer-asset' },
          { relationship: 'printable', assetId: 'worksheet-asset' },
        ],
      } as never,
      { withTenantCatalogReadScope: async (_request, callback) => callback() },
      ({ action }) => action === 'education.catalog.read',
    );
    const projection = await service.projectCourse({
      tenantId: 'family-a',
      actorUserId: 'learner-a',
      courseId: 'course-1',
    });
    expect(projection?.sections[0]?.lessons[0]?.lesson).toMatchObject({
      answerUrl: '',
    });
    expect(projection?.sections[0]?.lessons[0]?.assets).toEqual([
      { relationship: 'printable', assetId: 'worksheet-asset' },
    ]);
  });

  it('returns worksheet answers only to a separately authorized guardian', async () => {
    const lesson = { id: 'lesson-1', answerUrl: 'private-answer' };
    const service = new CatalogService(
      {
        list: async () => [{ id: 'course-1', licenseKind: 'open-license' }],
      } as never,
      {
        list: async () => [{ id: 'section-1', courseId: 'course-1' }],
      } as never,
      { list: async () => [lesson] } as never,
      { byLeft: async () => [{ relationship: 'answer-key' }] } as never,
      { withTenantCatalogReadScope: async (_request, callback) => callback() },
      () => true,
    );
    const projection = await service.projectCourse({
      tenantId: 'family-a',
      actorUserId: 'guardian-a',
      courseId: 'course-1',
      includeAnswerKeys: true,
    });
    expect(projection?.sections[0]?.lessons[0]?.lesson).toMatchObject({
      answerUrl: 'private-answer',
    });
    expect(projection?.sections[0]?.lessons[0]?.assets).toEqual([
      { relationship: 'answer-key' },
    ]);
  });

  it('uses deterministic sort and identifier ordering for catalog structure', async () => {
    const calls: unknown[] = [];
    const service = new CatalogService(
      {
        list: async () => [{ id: 'course-1', licenseKind: 'open-license' }],
      } as never,
      {
        list: async (options: unknown) => (
          calls.push(options), [{ id: 'section-1' }]
        ),
      } as never,
      { list: async (options: unknown) => (calls.push(options), []) } as never,
      { byLeft: async () => [] } as never,
      { withTenantCatalogReadScope: async (_request, callback) => callback() },
      () => true,
    );
    await service.projectCourse({
      tenantId: 'family-a',
      actorUserId: 'guardian-a',
      courseId: 'course-1',
    });
    expect(calls).toEqual([
      { where: { courseId: 'course-1' }, orderBy: ['sortOrder ASC', 'id ASC'] },
      {
        where: { sectionId: 'section-1' },
        orderBy: ['sortOrder ASC', 'id ASC'],
      },
    ]);
  });
});

describe('CatalogService tenant integration', () => {
  it('lists only family, ancestor, and global courses through the real tenancy scope', async () => {
    const path = join(tmpdir(), `smrt-education-${randomUUID()}.db`);
    try {
      const db = await getTestDatabase({ type: 'sqlite', url: path });
      const tenants = await TenantCollection.create({ db });
      const group = await tenants.create({ name: 'Group' });
      const family = await tenants.createChild(String(group.id), {
        name: 'Family',
      });
      const sibling = await tenants.createChild(String(group.id), {
        name: 'Sibling',
      });
      const courses = await CourseCollection.create({ db });
      await courses.create({ title: 'Global', licenseKind: 'open-license' });
      await courses.create({ title: 'Group', tenantId: String(group.id) });
      await courses.create({ title: 'Family', tenantId: String(family.id) });
      await courses.create({ title: 'Sibling', tenantId: String(sibling.id) });
      const service = new CatalogService(
        courses,
        await CourseSectionCollection.create({ db }),
        await LessonCollection.create({ db }),
        { byLeft: async () => [] } as never,
        tenants,
        () => true,
      );
      await withTenant(
        { tenantId: String(family.id), userId: 'guardian' },
        async () => {
          const visible = await service.findVisible({
            tenantId: String(family.id),
            actorUserId: 'guardian',
          });
          expect(visible.map((course) => course.title).sort()).toEqual([
            'Family',
            'Global',
            'Group',
          ]);
        },
      );
    } finally {
      rmSync(path, { force: true });
    }
  });
  it('keeps ancestor private copies out of an authorized family guardian catalog', async () => {
    const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    try {
      const tenants = await TenantCollection.create({ db });
      const group = await tenants.create({ name: 'Private group' });
      const family = await tenants.createChild(String(group.id), {
        name: 'Private family',
      });
      const sibling = await tenants.createChild(String(group.id), {
        name: 'Private sibling',
      });
      const courses = await CourseCollection.create({ db });
      const own = await courses.create({
        title: 'Own private',
        tenantId: String(family.id),
        licenseKind: 'personal-use-copy',
      });
      const ancestor = await courses.create({
        title: 'Ancestor private',
        tenantId: String(group.id),
        licenseKind: 'personal-use-copy',
      });
      const other = await courses.create({
        title: 'Sibling private',
        tenantId: String(sibling.id),
        licenseKind: 'personal-use-copy',
      });
      const global = await courses.create({ title: 'Invalid global private' });
      await db.update(
        'courses',
        { id: global.id },
        { license_kind: 'personal-use-copy' },
      );
      const service = new CatalogService(
        courses,
        await CourseSectionCollection.create({ db }),
        await LessonCollection.create({ db }),
        await LessonAssetCollection.create({ db }),
        tenants,
        () => true,
      );
      await withTenant(
        { tenantId: String(family.id), userId: 'guardian' },
        async () => {
          const request = {
            tenantId: String(family.id),
            actorUserId: 'guardian',
            includePrivate: true,
          };
          expect
            .soft(
              (await service.findVisible(request)).map((course) => course.id),
            )
            .toEqual([own.id]);
          expect
            .soft(
              (
                await service.projectCourse({
                  ...request,
                  courseId: String(own.id),
                })
              )?.course.id,
            )
            .toBe(own.id);
          for (const hidden of [ancestor, other, global]) {
            expect
              .soft(
                await service.projectCourse({
                  ...request,
                  courseId: String(hidden.id),
                  includeAnswerKeys: true,
                }),
              )
              .toBeNull();
          }
        },
      );
    } finally {
      await db.close?.();
    }
  });

  it('excludes hostile existing child owners at every course projection level', async () => {
    const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    try {
      const tenants = await TenantCollection.create({ db });
      const group = await tenants.create({ name: 'Projection group' });
      const family = await tenants.createChild(String(group.id), {
        name: 'Projection family',
      });
      const owner = String(family.id);
      const courses = await CourseCollection.create({ db });
      const sections = await CourseSectionCollection.create({ db });
      const lessons = await LessonCollection.create({ db });
      const assets = await LessonAssetCollection.create({ db });
      const files = await AssetCollection.create({ db });
      const course = await courses.create({
        title: 'Owned projection',
        tenantId: owner,
      });
      const section = await sections.create({
        title: 'Owned section',
        courseId: String(course.id),
        tenantId: owner,
      });
      const lesson = await lessons.create({
        title: 'Owned lesson',
        sectionId: String(section.id),
        tenantId: owner,
      });
      const file = await files.create({
        name: 'Owned attachment',
        sourceUri: 'file://attachment',
        tenantId: owner,
      });
      const asset = await assets.create({
        lessonId: String(lesson.id),
        assetId: String(file.id),
        tenantId: owner,
      });
      for (const hostileOwner of [String(group.id), null]) {
        const suffix = hostileOwner ?? 'global';
        const hostileSection = await sections.create({
          title: `Hostile section ${suffix}`,
          courseId: String(course.id),
          tenantId: owner,
        });
        const hostileLesson = await lessons.create({
          title: `Hostile lesson ${suffix}`,
          sectionId: String(section.id),
          tenantId: owner,
        });
        const hostileFile = await files.create({
          name: `Hostile file ${suffix}`,
          sourceUri: `file://${suffix}`,
          tenantId: owner,
        });
        const hostileAsset = await assets.create({
          lessonId: String(lesson.id),
          assetId: String(hostileFile.id),
          tenantId: owner,
        });
        // Simulate pre-existing corrupt links without weakening normal save guards.
        await db.update(
          'course_sections',
          { id: hostileSection.id },
          { tenant_id: hostileOwner },
        );
        await db.update(
          'lessons',
          { id: hostileLesson.id },
          { tenant_id: hostileOwner },
        );
        await db.update(
          'lesson_assets',
          { id: hostileAsset.id },
          { tenant_id: hostileOwner },
        );
      }
      const service = new CatalogService(
        courses,
        sections,
        lessons,
        assets,
        tenants,
        () => true,
      );
      await withTenant({ tenantId: owner, userId: 'guardian' }, async () => {
        const projection = await service.projectCourse({
          tenantId: owner,
          actorUserId: 'guardian',
          courseId: String(course.id),
          includeAnswerKeys: true,
        });
        expect
          .soft(projection?.sections.map((entry) => entry.section.id))
          .toEqual([section.id]);
        const ownedSection = projection?.sections.find(
          (entry) => entry.section.id === section.id,
        );
        expect
          .soft(ownedSection?.lessons.map((entry) => entry.lesson.id))
          .toEqual([lesson.id]);
        expect
          .soft(
            ownedSection?.lessons
              .find((entry) => entry.lesson.id === lesson.id)
              ?.assets.map((entry) => entry.id),
          )
          .toEqual([asset.id]);
      });
    } finally {
      await db.close?.();
    }
  });

  it('initializes catalog records on DuckDB with the focused schema selector', async () => {
    const db = await getTestDatabase({
      type: 'duckdb',
      url: ':memory:',
      classes: ['Course'],
    });
    try {
      const courses = await CourseCollection.create({ db });
      await courses.create({ title: 'DuckDB catalog course' });
      expect((await courses.list()).map((course) => course.title)).toContain(
        'DuckDB catalog course',
      );
    } finally {
      await db.close?.();
    }
  });
});
