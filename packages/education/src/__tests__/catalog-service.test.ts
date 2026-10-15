import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  LessonCollection,
} from '../collections.js';

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
  it('uses an allowlisted scope and hides family copies from ordinary catalog reads', async () => {
    let scopeRequest: unknown;
    const service = new CatalogService(
      courses as never,
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
});
