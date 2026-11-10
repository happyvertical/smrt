import { randomUUID } from 'node:crypto';
import {
  AssetCollection,
  withPrivateAssetAccess,
} from '@happyvertical/smrt-assets';
import {
  type CollectionInterceptor,
  GlobalInterceptors,
  type SmrtCollection,
  type SmrtObject,
} from '@happyvertical/smrt-core';
import { MCPGenerator } from '@happyvertical/smrt-core/generators/mcp';
import { APIGenerator } from '@happyvertical/smrt-core/generators/rest';
import { expect } from 'vitest';
import {
  CourseCollection,
  CourseSectionCollection,
  LessonAssetCollection,
  LessonCollection,
} from '../collections.js';
import type { learnerFixture } from './learner-workflows.js';

type Fixture = Awaited<ReturnType<typeof learnerFixture>>;
export async function assertPrivateMaterial(f: Fixture) {
  const assets = await AssetCollection.create({ db: f.db });
  const links = await LessonAssetCollection.create({ db: f.db });
  const courses = await CourseCollection.create({ db: f.db });
  const sections = await CourseSectionCollection.create({ db: f.db });
  const lessons = await LessonCollection.create({ db: f.db });
  const tenantId = f.own.tenantId;
  const personal = await courses.create({
    tenantId,
    title: 'Private workbook',
    licenseKind: 'personal-use-copy',
  });
  const section = await sections.create({
    tenantId,
    courseId: String(personal.id),
    title: 'Private section',
  });
  const lesson = await lessons.create({
    tenantId,
    sectionId: String(section.id),
    title: 'Private lesson',
  });
  const publicAsset = await assets.create({
    tenantId,
    name: 'Public source',
    sourceUri: 'file:///public.pdf',
  });
  const id = randomUUID();
  const scope = {
    tenantId,
    actorUserId: f.own.actorUserId,
    ownerProfileId: String(f.alice.profile.id),
    assetIds: [id],
  };
  const scoped = <T>(action: () => Promise<T>) =>
    f.as(f.own, () => withPrivateAssetAccess(scope, action));
  await scoped(() =>
    assets.create({
      id,
      tenantId,
      name: 'Private source',
      accessMode: 'private',
      ownerProfileId: scope.ownerProfileId,
      sourceUri: 'file:///private.pdf',
    }),
  );
  const api = new APIGenerator(
    { basePath: '/api/v1', authMiddleware: () => async (request) => request },
    { db: f.db },
  );
  api.registerCollection(
    'assets',
    assets as unknown as SmrtCollection<SmrtObject>,
  );
  const rest = api.generateHandler();
  const mcp = new MCPGenerator(
    { classNames: ['Asset'] },
    { db: f.db, tenantId, user: { id: f.own.actorUserId } },
  );
  await f.as(f.own, async () => {
    // Positive control: public storage metadata really is available generically.
    const publicResponse = await rest(
      new Request(`http://local/api/v1/assets/${publicAsset.id}`),
    );
    expect(publicResponse.status).toBe(200);
    expect(await publicResponse.text()).toContain('file:///public.pdf');
    const publicMcp = await mcp.handleToolCall({
      method: 'tools/call',
      params: { name: 'asset_get', arguments: { id: publicAsset.id } },
    });
    expect(publicMcp.isError).not.toBe(true);
    expect(JSON.stringify(publicMcp)).toContain('file:///public.pdf');
    for (const [lessonId, relationship] of [
      [f.lesson.id, 'answer-key'],
      [lesson.id, 'printable'],
    ] as const) {
      await expect(
        links.create({
          tenantId,
          lessonId: String(lessonId),
          assetId: String(publicAsset.id),
          relationship,
        }),
      ).rejects.toThrow('authorized private asset');
      await expect(
        links.create({
          tenantId,
          lessonId: String(lessonId),
          assetId: id,
          relationship,
        }),
      ).rejects.toThrow('authorized private asset');
    }
    await expect(
      withPrivateAssetAccess(
        { ...scope, ownerProfileId: String(f.bob.profile.id) },
        () =>
          links.create({
            tenantId,
            lessonId: String(lesson.id),
            assetId: id,
            relationship: 'printable',
          }),
      ),
    ).rejects.toThrow('authorized private asset');
  });
  await scoped(() =>
    links.create({
      tenantId,
      lessonId: String(lesson.id),
      assetId: id,
      relationship: 'printable',
    }),
  );
  await scoped(() =>
    links.create({
      tenantId,
      lessonId: String(f.lesson.id),
      assetId: id,
      relationship: 'answer-key',
    }),
  );
  await f.as(f.own, async () => {
    expect(
      (await rest(new Request(`http://local/api/v1/assets/${id}`))).status,
    ).toBe(404);
    const response = await mcp.handleToolCall({
      method: 'tools/call',
      params: { name: 'asset_get', arguments: { id } },
    });
    expect(response.isError).toBe(true);
    expect(response.content[0]?.text).toMatch(/object not found/i);
    expect(JSON.stringify(response)).not.toContain('file:///private.pdf');
    const publicLink = await links.create({
      tenantId,
      lessonId: String(f.secondLesson.id),
      assetId: String(publicAsset.id),
      relationship: 'attachment',
    });
    publicLink.relationship = 'answer-key';
    await expect(publicLink.save()).rejects.toThrow('authorized private asset');
    expect(
      (await f.db.get('lesson_assets', { id: publicLink.id }))?.relationship,
    ).toBe('attachment');
  });
  const stable = await courses.create({
    tenantId,
    slug: 'immutable-classification',
    title: 'Original',
  });
  await expect(
    courses.create({
      tenantId,
      slug: 'immutable-classification',
      title: 'Replacement',
      licenseKind: 'personal-use-copy',
    }),
  ).rejects.toThrow();
  expect((await f.db.get('courses', { id: stable.id }))?.license_kind).toBe(
    'own-work',
  );
  const refreshed = await courses.create({
    tenantId,
    slug: 'immutable-classification',
    title: 'Refreshed',
  });
  expect(refreshed.id).toBe(stable.id);
  expect(refreshed.title).toBe('Refreshed');
  const pinnedSection = await sections.create({
    tenantId,
    slug: 'pinned-section',
    courseId: String(stable.id),
    title: 'Original section',
  });
  await expect(
    sections.create({
      tenantId,
      slug: 'pinned-section',
      courseId: String(personal.id),
      title: 'Moved section',
    }),
  ).rejects.toThrow();
  expect(
    await f.db.get('course_sections', {
      id: pinnedSection.id,
      course_id: stable.id,
    }),
  ).not.toBeNull();
  const pinnedLesson = await lessons.create({
    tenantId,
    slug: 'pinned-lesson',
    sectionId: String(pinnedSection.id),
    title: 'Original lesson',
  });
  await expect(
    lessons.create({
      tenantId,
      slug: 'pinned-lesson',
      sectionId: String(section.id),
      title: 'Moved lesson',
    }),
  ).rejects.toThrow();
  expect(
    await f.db.get('lessons', {
      id: pinnedLesson.id,
      section_id: pinnedSection.id,
    }),
  ).not.toBeNull();
  stable.licenseKind = 'personal-use-copy';
  await expect(stable.save()).rejects.toThrow('explicit re-authoring');
  // Change the persisted identity after the model's checks but before its final
  // write, modelling an interleaved administrative/migration write.
  const lateIdentityChange: CollectionInterceptor = {
    name: 'education-identity-race-fixture',
    async beforeSave(instance) {
      if (instance.id === refreshed.id)
        await f.db.update(
          'courses',
          { id: refreshed.id },
          { license_kind: 'personal-use-copy' },
        );
    },
  };
  GlobalInterceptors.register(lateIdentityChange);
  try {
    refreshed.title = 'Late overwrite';
    await expect(refreshed.save()).rejects.toThrow();
    expect((await f.db.get('courses', { id: refreshed.id }))?.title).toBe(
      'Refreshed',
    );
  } finally {
    GlobalInterceptors.unregister(lateIdentityChange);
  }
  f.course.licenseKind = 'personal-use-copy';
  await expect(f.course.save()).rejects.toThrow('explicit re-authoring');
  const originalSection = await sections.get(f.lesson.sectionId);
  if (!originalSection) throw new Error('Missing section fixture');
  originalSection.courseId = String(personal.id);
  await expect(originalSection.save()).rejects.toThrow('explicit re-authoring');
  f.secondLesson.sectionId = String(section.id);
  await expect(f.secondLesson.save()).rejects.toThrow('explicit re-authoring');
}
