import { randomUUID } from 'node:crypto';
import { isPostgresDatabase } from '@happyvertical/smrt-core';
import { getCurrentTenant, withTenant } from '@happyvertical/smrt-tenancy';
import { TenantCollection } from '@happyvertical/smrt-users';
import type { DatabaseInterface } from '@happyvertical/sql';
import { expect, vi } from 'vitest';
import { CatalogService } from '../catalog-service.js';
import {
  CourseCollection,
  CourseSectionCollection,
  LessonCollection,
} from '../collections.js';
import { CourseSourceCollection } from '../course-source.js';
import {
  type SourceImportRequest,
  SourceImportService,
} from '../source-import-service.js';

const pageUrl = 'https://allinonehomeschool.com/language/';
const page = (pdf = 'day-1.pdf', includeSecond = true) =>
  `<h1>Language Arts</h1><p><strong>Lesson 1*</strong></p><a href="/wp-content/uploads/${pdf}">worksheet</a>${includeSecond ? '<h2>Lesson 2</h2><p>Do not retain lesson text.</p>' : ''}`;

export async function sourceFixture(db: DatabaseInterface) {
  const tenants = await TenantCollection.create({ db });
  const group = await tenants.create({ name: `Group ${randomUUID()}` });
  const family = await tenants.createChild(String(group.id), {
    name: 'Family',
  });
  const sibling = await tenants.createChild(String(group.id), {
    name: 'Sibling',
  });
  const actorUserId = randomUUID();
  const tenantId = String(family.id);
  const run = <T>(callback: () => Promise<T>) =>
    withTenant({ tenantId, userId: actorUserId }, callback);
  const source = await run(async () =>
    (await CourseSourceCollection.create({ db })).create({
      key: 'easy-peasy',
      name: 'Easy Peasy',
    }),
  );
  const request: SourceImportRequest = {
    tenantId,
    actorUserId,
    sourceId: String(source.id),
    courseRef: 'language-4',
    pageUrl,
    destination: 'private',
  };
  let html = page();
  const fetchPage = vi.fn(async (url: string) => {
    expect(getCurrentTenant()?.tenantId).toBe(tenantId);
    return { html, url };
  });
  const authorize = vi.fn(() => true);
  const service = new SourceImportService(db, authorize);
  service.registerEasyPeasy({ termsAccepted: true, fetchPage });
  return {
    db,
    tenants,
    group,
    family,
    sibling,
    source,
    request,
    service,
    fetchPage,
    authorize,
    run,
    setPage: (value: string) => {
      html = value;
    },
    page,
  };
}

type Fixture = Awaited<ReturnType<typeof sourceFixture>>;

export async function assertEasyPeasySourceProvisioning(
  f: Fixture,
): Promise<void> {
  const first = await f.run(() =>
    f.service.ensureEasyPeasyCourseSource({
      tenantId: f.request.tenantId,
      actorUserId: f.request.actorUserId,
    }),
  );
  const second = await f.run(() =>
    f.service.ensureEasyPeasyCourseSource({
      tenantId: f.request.tenantId,
      actorUserId: f.request.actorUserId,
    }),
  );
  expect(second).toEqual(first);
  await f.run(async () => {
    const source = await (
      await CourseSourceCollection.create({ db: f.db })
    ).get(first.sourceId);
    expect(source).toMatchObject({
      tenantId: f.request.tenantId,
      key: 'easy-peasy',
      kind: 'adapter',
      adapterKey: 'easy-peasy',
      sharing: 'private',
    });
  });
  expect(f.authorize).toHaveBeenCalledWith(
    expect.objectContaining({
      action: 'education.source.ensure',
      actorTenantId: f.request.tenantId,
      actorUserId: f.request.actorUserId,
      sourceId: first.sourceId,
    }),
  );
  await withTenant(
    { tenantId: f.request.tenantId, userId: 'other-actor' },
    async () => {
      await expect(
        f.service.ensureEasyPeasyCourseSource({
          tenantId: f.request.tenantId,
          actorUserId: f.request.actorUserId,
        }),
      ).rejects.toThrow('not authorized');
    },
  );
  const unregistered = new SourceImportService(f.db, () => true);
  await f.run(async () => {
    await expect(
      unregistered.ensureEasyPeasyCourseSource({
        tenantId: f.request.tenantId,
        actorUserId: f.request.actorUserId,
      }),
    ).rejects.toThrow('not registered');
  });
}

export async function assertRefreshAndPrivacy(f: Fixture): Promise<void> {
  const first = await f.run(() =>
    f.service.importCourse({ ...f.request, subject: 'language-arts' }),
  );
  const courses = await CourseCollection.create({ db: f.db });
  const lessons = await LessonCollection.create({ db: f.db });
  const sentinel = `source_history_${randomUUID().replaceAll('-', '')}`;
  // These foreign keys model future enrollment/progress/submission references;
  // those feature models are intentionally outside this issue's dependency.
  const sqlType = isPostgresDatabase(f.db) ? 'UUID' : 'TEXT';
  await f.db.query(
    `CREATE TABLE ${sentinel} (id TEXT PRIMARY KEY, course_id ${sqlType} REFERENCES courses(id), lesson_id ${sqlType} REFERENCES lessons(id), score INTEGER)`,
  );
  await f.db.insert(sentinel, {
    id: 'existing-history',
    course_id: first.courseId,
    lesson_id: first.lessonIds[0],
    score: 17,
  });
  await f.run(async () => {
    const lesson = await lessons.get(first.lessonIds[0]);
    expect(lesson).toBeTruthy();
    if (!lesson) throw new Error('Missing imported lesson');
    lesson.body = 'Family-authored content';
    await lesson.save();
  });
  f.setPage(page('changed.pdf', false));
  const refreshed = await f.run(() =>
    f.service.importCourse({
      ...f.request,
      pageUrl: 'https://allinonehomeschool.com/language-new/',
    }),
  );
  expect(refreshed.courseId).toBe(first.courseId);
  expect(refreshed.lessonIds).toEqual([first.lessonIds[0]]);
  await f.run(async () => {
    const lesson = await lessons.get(first.lessonIds[0]);
    expect(lesson).toMatchObject({
      body: 'Family-authored content',
      printableUrl:
        'https://allinonehomeschool.com/wp-content/uploads/changed.pdf',
    });
    expect(await lessons.get(first.lessonIds[1])).toBeTruthy();
    const course = await courses.get(first.courseId);
    expect(course).toMatchObject({
      tenantId: f.request.tenantId,
      status: 'draft',
      subject: 'language-arts',
      licenseKind: 'personal-use-copy',
    });
  });
  expect(await f.db.get(sentinel, { id: 'existing-history' })).toMatchObject({
    score: 17,
  });
  const catalog = new CatalogService(
    courses,
    await CourseSectionCollection.create({ db: f.db }),
    lessons,
    { db: f.db, byLeft: async () => [] } as never,
    f.tenants,
    () => true,
  );
  await f.run(async () => {
    expect(
      (await catalog.findVisible(f.request)).some(
        (row) => row.id === first.courseId,
      ),
    ).toBe(false);
    expect(
      (await catalog.findVisible({ ...f.request, includePrivate: true })).map(
        (row) => row.id,
      ),
    ).toContain(first.courseId);
  });
  for (const owner of [String(f.sibling.id), String(f.group.id)]) {
    await withTenant(
      { tenantId: owner, userId: f.request.actorUserId },
      async () => {
        expect(
          await catalog.projectCourse({
            tenantId: owner,
            actorUserId: f.request.actorUserId,
            includePrivate: true,
            courseId: first.courseId,
          }),
        ).toBeNull();
      },
    );
  }
}

export async function assertAuthorizationAndSharing(f: Fixture): Promise<void> {
  await expect(f.service.importCourse(f.request)).rejects.toThrow(
    'not authorized',
  );
  await withTenant(
    { tenantId: String(f.sibling.id), userId: f.request.actorUserId },
    async () => {
      await expect(f.service.importCourse(f.request)).rejects.toThrow(
        'not authorized',
      );
      await expect(
        f.service.importCourse({
          ...f.request,
          tenantId: String(f.sibling.id),
        }),
      ).rejects.toThrow();
    },
  );
  await withTenant(
    { tenantId: f.request.tenantId, userId: 'other-actor' },
    async () => {
      await expect(f.service.importCourse(f.request)).rejects.toThrow(
        'not authorized',
      );
    },
  );
  await withTenant(
    {
      tenantId: f.request.tenantId,
      userId: f.request.actorUserId,
      superAdminBypass: true,
    },
    async () => {
      await expect(f.service.importCourse(f.request)).rejects.toThrow(
        'not authorized',
      );
    },
  );
  expect(f.fetchPage).not.toHaveBeenCalled();
  await f.run(async () => {
    f.authorize.mockReturnValue(false);
    await expect(f.service.importCourse(f.request)).rejects.toThrow(
      'not authorized',
    );
    f.authorize.mockReturnValue(true);
    for (const sharing of ['private', 'group', 'global'] as const) {
      f.source.sharing = sharing;
      f.source.setConfig({
        licenseEvidence: 'Written permission held by host',
      });
      await f.source.save();
      await expect(
        f.service.importCourse({
          ...f.request,
          courseRef: `private-${sharing}`,
        }),
      ).resolves.toHaveProperty('courseId');
      const wider = f.service.importCourse({
        ...f.request,
        courseRef: `group-${sharing}`,
        destination: 'group',
      });
      if (sharing === 'private')
        await expect(wider).rejects.toThrow('Source sharing');
      else await expect(wider).resolves.toHaveProperty('courseId');
    }
    f.source.setConfig({});
    await f.source.save();
    await expect(
      f.service.importCourse({ ...f.request, destination: 'group' }),
    ).rejects.toThrow('licensing');
    await expect(
      f.service.importCourse({ ...f.request, destination: 'global' as never }),
    ).rejects.toThrow('destinations');
    await expect(
      f.service.importCourse({ ...f.request, tenantId: null as never }),
    ).rejects.toThrow('not authorized');
    // A widened policy may permit future imports, never relabel an existing copy.
    await f.service.importCourse(f.request);
    f.source.setConfig({ licenseEvidence: 'Later permission' });
    await f.source.save();
    await expect(
      f.service.importCourse({ ...f.request, destination: 'group' }),
    ).rejects.toThrow('license cannot be changed');
    // Unknown persisted values fail closed even if written by older/raw tooling.
    await f.db.update(
      'course_sources',
      { id: f.source.id },
      { sharing: 'unknown' },
    );
    await expect(f.service.importCourse(f.request)).rejects.toThrow(
      'Unsupported source policy',
    );
  });
}

export async function assertRollbackAndRetry(f: Fixture): Promise<void> {
  const first = await f.run(() => f.service.importCourse(f.request));
  const before = await f.db.get('lessons', { id: first.lessonIds[0] });
  f.setPage('<h1>Broken</h1><h2>Lesson 1</h2><h2>Lesson 1</h2>');
  await f.run(async () => {
    await expect(f.service.importCourse(f.request)).rejects.toThrow();
  });
  expect(await f.db.get('lessons', { id: first.lessonIds[0] })).toEqual(before);
  f.setPage(page('rollback.pdf'));
  const originalSave = (await import('../catalog.js')).Reading.prototype.save;
  const fail = vi
    .spyOn((await import('../catalog.js')).Reading.prototype, 'save')
    .mockRejectedValueOnce(new Error('Injected later write failure'));
  try {
    await f.run(async () => {
      await expect(f.service.importCourse(f.request)).rejects.toThrow(
        'Injected later write failure',
      );
    });
  } finally {
    fail.mockRestore();
  }
  expect(originalSave).toBeTypeOf('function');
  expect(await f.db.get('lessons', { id: first.lessonIds[0] })).toEqual(before);
  const { Reading } = await import('../catalog.js');
  const contention = vi
    .spyOn(Reading.prototype, 'save')
    .mockRejectedValueOnce(
      Object.assign(new Error('serialization'), { code: '40001' }),
    );
  const fetchedBefore = f.fetchPage.mock.calls.length;
  try {
    await f.run(() => f.service.importCourse(f.request));
  } finally {
    contention.mockRestore();
  }
  expect(f.fetchPage.mock.calls.length).toBe(fetchedBefore + 1);
  expect(await f.db.get('lessons', { id: first.lessonIds[0] })).not.toEqual(
    before,
  );
  const results = await f.run(() =>
    Promise.all([
      f.service.importCourse(f.request),
      f.service.importCourse(f.request),
    ]),
  );
  expect(results[0]).toEqual(results[1]);
  await f.run(async () => {
    expect(
      (await (await LessonCollection.create({ db: f.db })).list()).length,
    ).toBe(2);
  });
  const exhausted = vi
    .spyOn(Reading.prototype, 'save')
    .mockRejectedValue(Object.assign(new Error('busy'), { code: '40001' }));
  try {
    await f.run(async () => {
      await expect(f.service.importCourse(f.request)).rejects.toThrow('busy');
    });
    expect(exhausted).toHaveBeenCalledTimes(4);
  } finally {
    exhausted.mockRestore();
  }
}

export async function assertInputAndIdentityGuards(f: Fixture): Promise<void> {
  const service = new SourceImportService(f.db, () => true);
  expect(() =>
    service.registerEasyPeasy({
      termsAccepted: false as never,
      fetchPage: f.fetchPage,
    }),
  ).toThrow('terms');
  await f.run(async () => {
    await expect(service.importCourse(f.request)).rejects.toThrow(
      'not registered',
    );
    await expect(
      f.service.importCourse({ ...f.request, pageUrl: 'http://127.0.0.1/' }),
    ).rejects.toThrow();
    expect(f.fetchPage).not.toHaveBeenCalled();
    f.fetchPage.mockRejectedValueOnce(new Error('Upstream unavailable'));
    await expect(f.service.importCourse(f.request)).rejects.toThrow(
      'Upstream unavailable',
    );
    f.fetchPage.mockResolvedValueOnce({
      html: page(),
      url: 'https://allinonehomeschool.com/redirected/',
    });
    await expect(f.service.importCourse(f.request)).rejects.toThrow('redirect');
    f.fetchPage.mockResolvedValueOnce({
      html: 'x'.repeat(2_000_001),
      url: f.request.pageUrl,
    });
    await expect(f.service.importCourse(f.request)).rejects.toThrow(
      'oversized',
    );
    expect(
      await (await CourseCollection.create({ db: f.db })).list(),
    ).toHaveLength(0);
    const imported = await f.service.importCourse(f.request);
    const before = await f.db.get('courses', { id: imported.courseId });
    f.setPage('<h1>Changed title</h1><h2>Lesson 1</h2>');
    await expect(f.service.importCourse(f.request)).rejects.toThrow(
      'kind cannot be changed',
    );
    expect(await f.db.get('courses', { id: imported.courseId })).toEqual(
      before,
    );
    f.setPage(page());
    const section = (await f.db.get('course_sections', {
      course_id: imported.courseId,
    })) as { id: string };
    for (const [table, id] of [
      ['courses', imported.courseId],
      ['course_sections', section.id],
      ['lessons', imported.lessonIds[0]],
    ] as const) {
      await f.db.update(table, { id }, { tenant_id: String(f.sibling.id) });
      await expect(f.service.importCourse(f.request)).rejects.toThrow(
        'not authorized',
      );
      expect(
        await f.db.get(table, { id, tenant_id: String(f.sibling.id) }),
      ).toBeTruthy();
      await f.db.update(table, { id }, { tenant_id: f.request.tenantId });
    }
    // Policy is read again after the fetch completes, before any mutation.
    f.fetchPage.mockImplementationOnce(async (url) => {
      await f.db.update(
        'course_sources',
        { id: f.source.id },
        { sharing: 'private' },
      );
      return { url, html: page() };
    });
    f.source.sharing = 'group';
    f.source.setConfig({ licenseEvidence: 'permission' });
    await f.source.save();
    await expect(
      f.service.importCourse({
        ...f.request,
        courseRef: 'revoked-during-fetch',
        destination: 'group',
      }),
    ).rejects.toThrow('Source sharing');
    expect(
      await f.db.get('courses', { source_ref: 'revoked-during-fetch' }),
    ).toBeNull();
  });
}

/** Regression: ordinary bold instructions cannot terminate the worksheet day. */
export async function assertBoldInstructionRefresh(f: Fixture): Promise<void> {
  const first = await f.run(() => f.service.importCourse(f.request));
  f.setPage(
    '<h1>Language Arts</h1><p><strong>Lesson 1 *</strong></p><p><strong>Print this worksheet</strong></p><a href="/wp-content/uploads/refreshed-day1.pdf">Worksheet</a><h2>Lesson 2</h2>',
  );
  const refreshed = await f.run(() => f.service.importCourse(f.request));
  expect(refreshed).toEqual(first);
  await f.run(async () => {
    const lessons = await LessonCollection.create({ db: f.db });
    expect(await lessons.get(first.lessonIds[0])).toMatchObject({
      printableUrl:
        'https://allinonehomeschool.com/wp-content/uploads/refreshed-day1.pdf',
    });
  });
}

/** Regression: unaccounted markers cannot commit pointers to a different day. */
export async function assertAmbiguousMarkersAtomicity(
  f: Fixture,
): Promise<void> {
  f.setPage(
    '<h1>Original</h1><p><strong>Lesson 1 *</strong></p><a href="/wp-content/uploads/old1.pdf">Worksheet</a><p><strong>Lesson 2 *</strong></p><a href="/wp-content/uploads/old2.pdf">Worksheet</a>',
  );
  const first = await f.run(() => f.service.importCourse(f.request));
  const courseBefore = await f.db.get('courses', { id: first.courseId });
  const lessonsBefore = await Promise.all(
    first.lessonIds.map((id) => f.db.get('lessons', { id })),
  );
  const malformed = [
    '<h1>Changed</h1><p><strong>Lesson 1 *</strong><br><strong>Lesson 2 *</strong> <a href="/wp-content/uploads/wrong-day2.pdf">worksheet</a></p>',
    ...['div', 'td', 'span'].map(
      (tag) =>
        `<h1>Changed</h1><p><strong>Lesson 1 *</strong></p><${tag}><strong>Lesson 2 *</strong> <a href="/wp-content/uploads/wrong-day2.pdf">worksheet</a></${tag}>`,
    ),
  ];
  await f.run(async () => {
    const courses = await CourseCollection.create({ db: f.db });
    const countBefore = (await courses.list()).length;
    for (const html of malformed) {
      f.setPage(html);
      await expect.soft(f.service.importCourse(f.request)).rejects.toThrow();
      await expect
        .soft(
          f.service.importCourse({
            ...f.request,
            courseRef: 'ambiguous-new-course',
          }),
        )
        .rejects.toThrow();
      expect
        .soft(await f.db.get('courses', { id: first.courseId }))
        .toEqual(courseBefore);
      expect
        .soft(
          await Promise.all(
            first.lessonIds.map((id) => f.db.get('lessons', { id })),
          ),
        )
        .toEqual(lessonsBefore);
      expect.soft((await courses.list()).length).toBe(countBefore);
    }
  });
}

/** Regression: trailing resource PDFs must not overwrite a lesson on refresh. */
export async function assertStructuralHeadingRefresh(
  f: Fixture,
): Promise<void> {
  f.setPage(
    '<h1>Course</h1><p><strong>Lesson 1 *</strong></p><a href="/wp-content/uploads/day1.pdf">Worksheet</a>',
  );
  const first = await f.run(() => f.service.importCourse(f.request));
  f.setPage(
    '<h1>Course</h1><p><strong>Lesson 1 *</strong></p><h2>Resources</h2><a href="/wp-content/uploads/supply-list.pdf">Supply list</a>',
  );
  const refreshed = await f.run(() => f.service.importCourse(f.request));
  expect(refreshed).toEqual(first);
  await f.run(async () => {
    const lessons = await LessonCollection.create({ db: f.db });
    expect(await lessons.get(first.lessonIds[0])).toMatchObject({
      printableUrl: '',
    });
  });
}

/** Generic Printable labels remain lesson pointers across refresh. */
export async function assertPrintableLabelRefresh(f: Fixture): Promise<void> {
  f.setPage(
    '<h1>Course</h1><h2>Lesson 1 *</h2><a href="/wp-content/old.pdf">Worksheet</a>',
  );
  const first = await f.run(() => f.service.importCourse(f.request));
  for (const label of ['Printable', 'Printables']) {
    f.setPage(
      `<h1>Course</h1><h2>Lesson 1 *</h2><a href="/wp-content/new.pdf">${label}</a>`,
    );
    expect(await f.run(() => f.service.importCourse(f.request))).toEqual(first);
    await f.run(async () => {
      const lessons = await LessonCollection.create({ db: f.db });
      expect(await lessons.get(first.lessonIds[0])).toMatchObject({
        printableUrl: 'https://allinonehomeschool.com/wp-content/new.pdf',
      });
    });
  }
}

/** A data-href attribute cannot replace the actual destination on refresh. */
export async function assertExactHrefRefresh(f: Fixture): Promise<void> {
  f.setPage(
    '<h1>Course</h1><h2>Lesson 1 *</h2><a href="/wp-content/old.pdf">Worksheet</a>',
  );
  const first = await f.run(() => f.service.importCourse(f.request));
  f.setPage(
    '<h1>Course</h1><h2>Lesson 1 *</h2><a data-href="/wp-content/wrong.pdf" href="/wp-content/right.pdf">Worksheet</a>',
  );
  expect(await f.run(() => f.service.importCourse(f.request))).toEqual(first);
  await f.run(async () => {
    const lessons = await LessonCollection.create({ db: f.db });
    expect(await lessons.get(first.lessonIds[0])).toMatchObject({
      printableUrl: 'https://allinonehomeschool.com/wp-content/right.pdf',
    });
  });
  f.setPage(
    '<h1>Course</h1><h2>Lesson 1 *</h2><a data-href="/wp-content/absent.pdf">Worksheet</a>',
  );
  expect(await f.run(() => f.service.importCourse(f.request))).toEqual(first);
  await f.run(async () => {
    const lessons = await LessonCollection.create({ db: f.db });
    expect(await lessons.get(first.lessonIds[0])).toMatchObject({
      printableUrl: '',
    });
  });
}
