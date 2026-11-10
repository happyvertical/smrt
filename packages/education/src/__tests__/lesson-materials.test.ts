import { randomUUID } from 'node:crypto';
import {
  AssetCollection,
  withPrivateAssetAccess,
} from '@happyvertical/smrt-assets';
import { getTestDatabase } from '@happyvertical/smrt-core';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LessonAssetCollection } from '../collections.js';
import {
  CourseAssetCollection,
  externalVideoEmbedUrl,
  LESSON_ASSET_DEFAULT_AUDIENCE,
  LESSON_ASSET_RELATIONSHIPS,
  materialAudience,
  parseYouTubeReference,
} from '../lesson-assets.js';
import {
  ExternalVideoReferenceError,
  SubmissionService,
} from '../submission-service.js';
import { learnerFixture } from './learner-workflows.js';
import { submissionClasses } from './submission-workflows.js';

beforeAll(() => enableTenancy());
afterAll(() => disableTenancy());

describe('material roles and audience', () => {
  it('defaults each role and keeps keys and guidance guardian-only', () => {
    expect(LESSON_ASSET_RELATIONSHIPS).toEqual([
      'teacher-guide',
      'slides',
      'learner-pages',
      'assessment',
      'assessment-guidance',
      'handout',
      'printable',
      'answer-key',
      'video',
      'attachment',
    ]);
    expect(
      LESSON_ASSET_RELATIONSHIPS.filter(
        (r) => LESSON_ASSET_DEFAULT_AUDIENCE[r] === 'guardian',
      ),
    ).toEqual(['teacher-guide', 'slides', 'assessment-guidance', 'answer-key']);
    expect(materialAudience('slides')).toBe('guardian');
    expect(materialAudience('slides', 'learner')).toBe('learner');
    expect(materialAudience('handout', 'guardian')).toBe('guardian');
    expect(() => materialAudience('answer-key', 'learner')).toThrow(
      'guardian-only',
    );
    expect(() => materialAudience('assessment-guidance', 'learner')).toThrow(
      'guardian-only',
    );
    expect(() => materialAudience('poster')).toThrow('Unknown material role');
    expect(() => materialAudience('handout', 'everyone')).toThrow(
      'Unknown material audience',
    );
  });
  it('accepts only allowlisted YouTube references and never fetches', () => {
    const id = 'dQw4w9WgXcQ';
    for (const ref of [
      id,
      ` ${id} `,
      `https://www.youtube.com/watch?v=${id}&list=PL1`,
      `https://youtu.be/${id}?t=3`,
      `https://m.youtube.com/watch?v=${id}`,
      `https://www.youtube.com/embed/${id}`,
      `https://www.youtube.com/shorts/${id}`,
      `https://www.youtube-nocookie.com/embed/${id}`,
    ])
      expect(parseYouTubeReference(ref)).toBe(id);
    for (const ref of [
      `http://www.youtube.com/watch?v=${id}`,
      `https://youtube.com.evil.test/watch?v=${id}`,
      `https://vimeo.com/${id}`,
      'https://www.youtube.com/watch?v=short',
      'https://www.youtube.com/playlist?list=PL1',
      'not a link',
      `javascript:alert('${id}')`,
    ])
      expect(parseYouTubeReference(ref)).toBeNull();
    expect(externalVideoEmbedUrl('youtube', id)).toBe(
      `https://www.youtube-nocookie.com/embed/${id}`,
    );
  });
});

async function fixture() {
  const db = await getTestDatabase({
    type: 'sqlite',
    url: ':memory:',
    classes: submissionClasses,
  });
  const f = await learnerFixture(db);
  const claims: string[] = [];
  const service = new SubmissionService(
    db,
    ({ own, relationshipTypeId }) =>
      own || relationshipTypeId === f.guardianType.id,
    () => true,
    {
      storage: { type: 'local', basePath: '/tmp/unused' } as never,
      signAsset: async (claim) => {
        claims.push(`${claim.submissionId}:${claim.assetId}`);
        return `https://school.test/${claim.assetId}`;
      },
    },
  );
  const tenantId = f.parent.tenantId;
  const guardianProfile = String(
    (await db.get('users', { id: f.parent.actorUserId }))?.profile_id,
  );
  const asset = async (
    name: string,
    access: 'private' | 'public',
    mimeType = '',
  ) => {
    const id = randomUUID();
    const create = async () =>
      (await AssetCollection.create({ db })).create({
        id,
        tenantId,
        name,
        accessMode: access,
        ownerProfileId: guardianProfile,
        ...(mimeType ? { mimeType } : {}),
        sourceUri: `file:///education/${id}.pdf`,
      });
    await withTenant({ tenantId, userId: f.parent.actorUserId }, () =>
      access === 'private'
        ? withPrivateAssetAccess(
            {
              tenantId,
              actorUserId: f.parent.actorUserId,
              ownerProfileId: guardianProfile,
              assetIds: [id],
            },
            create,
          )
        : create(),
    );
    return id;
  };
  const link = async (
    relationship: string,
    access: 'private' | 'public',
    sortOrder: number,
    audience = '',
    extra: { mimeType?: string; rendition?: string } = {},
  ) => {
    const assetId = await asset(relationship, access, extra.mimeType);
    return withTenant({ tenantId, userId: f.parent.actorUserId }, () =>
      withPrivateAssetAccess(
        {
          tenantId,
          actorUserId: f.parent.actorUserId,
          ownerProfileId: guardianProfile,
          assetIds: [assetId],
        },
        async () =>
          (await LessonAssetCollection.create({ db })).create({
            tenantId,
            lessonId: String(f.lesson.id),
            assetId,
            relationship: relationship as never,
            audience: audience as never,
            sortOrder,
            ...(extra.rendition ? { rendition: extra.rendition as never } : {}),
          }),
      ),
    );
  };
  const scope = {
    enrollmentId: String(f.enrollment.id),
    lessonId: String(f.lesson.id),
  };
  return { ...f, db, service, claims, asset, link, scope, guardianProfile };
}

describe('signLessonPrintable roles (SMRT #4657)', () => {
  const pdf = { mimeType: 'application/pdf' };
  it('signs a printable, handout and learner-pages PDF for a learner and a guardian', async () => {
    const f = await fixture();
    try {
      for (const [i, role] of (
        ['printable', 'handout', 'learner-pages'] as const
      ).entries()) {
        const row = await f.link(role, 'public', i, '', pdf);
        for (const actor of [f.own, f.parent]) {
          const signed = await f.as(actor, () =>
            f.service.signLessonPrintable({
              ...actor,
              ...f.scope,
              assetId: row.assetId,
            }),
          );
          expect(signed.url).toContain(row.assetId);
        }
      }
    } finally {
      await f.db.close?.();
    }
  });
  it('refuses a guardian-audience row for a learner, an original, a non-PDF and an unrelated role', async () => {
    const f = await fixture();
    try {
      const sign = (actor: typeof f.own, assetId: string) =>
        f.as(actor, () =>
          f.service.signLessonPrintable({ ...actor, ...f.scope, assetId }),
        );
      const hidden = await f.link('handout', 'public', 0, 'guardian', pdf);
      await expect(sign(f.own, hidden.assetId)).rejects.toThrow();
      await sign(f.parent, hidden.assetId);
      const original = await f.link('learner-pages', 'public', 1, 'guardian', {
        ...pdf,
        rendition: 'original',
      });
      await expect(sign(f.own, original.assetId)).rejects.toThrow();
      await expect(sign(f.parent, original.assetId)).rejects.toThrow();
      const notPdf = await f.link('handout', 'public', 2);
      await expect(sign(f.own, notPdf.assetId)).rejects.toThrow();
      const guide = await f.link('teacher-guide', 'public', 3, '', pdf);
      await expect(sign(f.parent, guide.assetId)).rejects.toThrow();
      expect(f.claims.length).toBe(1);
    } finally {
      await f.db.close?.();
    }
  });
});

describe('signLessonPrintable retired rows (SMRT #4657)', () => {
  const pdf = { mimeType: 'application/pdf' };
  const retire = (f: Awaited<ReturnType<typeof fixture>>, id: unknown) =>
    f.db.query(
      `UPDATE lesson_assets SET retired_at = '2026-01-01T00:00:00.000Z' WHERE id = '${String(id)}'`,
    );
  it('refuses a retired printable, handout and learner-pages PDF to everyone', async () => {
    const f = await fixture();
    try {
      for (const [i, role] of (
        ['printable', 'handout', 'learner-pages'] as const
      ).entries()) {
        const row = await f.link(role, 'public', i, '', pdf);
        const sign = (actor: typeof f.own) =>
          f.as(actor, () =>
            f.service.signLessonPrintable({
              ...actor,
              ...f.scope,
              assetId: row.assetId,
            }),
          );
        await sign(f.own);
        await retire(f, row.id);
        await expect(sign(f.own)).rejects.toThrow();
        await expect(sign(f.parent)).rejects.toThrow();
      }
      expect(f.claims.length).toBe(3);
    } finally {
      await f.db.close?.();
    }
  });
  it('refuses a handout superseded into an answer key, whose new row is never signed here', async () => {
    const f = await fixture();
    try {
      const handout = await f.link('handout', 'private', 0, '', pdf);
      await withTenant(
        { tenantId: f.parent.tenantId, userId: f.parent.actorUserId },
        () =>
          withPrivateAssetAccess(
            {
              tenantId: f.parent.tenantId,
              actorUserId: f.parent.actorUserId,
              ownerProfileId: f.guardianProfile,
              assetIds: [handout.assetId],
            },
            async () =>
              (await LessonAssetCollection.create({ db: f.db })).create({
                tenantId: f.parent.tenantId,
                lessonId: String(f.lesson.id),
                assetId: handout.assetId,
                relationship: 'answer-key',
                sortOrder: 1,
              }),
          ),
      );
      await retire(f, handout.id);
      const sign = (actor: typeof f.own) =>
        f.as(actor, () =>
          f.service.signLessonPrintable({
            ...actor,
            ...f.scope,
            assetId: handout.assetId,
          }),
        );
      await expect(sign(f.own)).rejects.toThrow();
      await expect(sign(f.parent)).rejects.toThrow();
      // The learner's list shows nothing for it; the guardian sees only the key.
      const learner = await f.as(f.own, () =>
        f.service.listLessonMaterials({ ...f.own, ...f.scope }),
      );
      expect(learner).toEqual([]);
      const guardian = await f.as(f.parent, () =>
        f.service.listLessonMaterials({ ...f.parent, ...f.scope }),
      );
      expect(guardian.map((m) => [m.relationship, m.audience])).toEqual([
        ['answer-key', 'guardian'],
      ]);
      expect(f.claims.length).toBe(0);
    } finally {
      await f.db.close?.();
    }
  });
});

describe('lesson materials by audience', () => {
  it('shows guardians every material and learners only learner material', async () => {
    const f = await fixture();
    try {
      await f.link('teacher-guide', 'public', 0);
      const slides = await f.link('slides', 'public', 1);
      await f.link('learner-pages', 'public', 2);
      await f.link('answer-key', 'private', 3);
      await f.link('assessment-guidance', 'private', 4);
      await f.link('handout', 'public', 5);
      // Keys and guidance must be private files; a public one is refused.
      await expect(f.link('assessment-guidance', 'public', 6)).rejects.toThrow(
        'private asset',
      );
      await expect(
        f.link('answer-key', 'private', 7, 'learner'),
      ).rejects.toThrow('guardian-only');
      const guardian = await f.as(f.parent, () =>
        f.service.listLessonMaterials({ ...f.parent, ...f.scope }),
      );
      expect(guardian.map((m) => [m.relationship, m.audience])).toEqual([
        ['teacher-guide', 'guardian'],
        ['slides', 'guardian'],
        ['learner-pages', 'learner'],
        ['answer-key', 'guardian'],
        ['assessment-guidance', 'guardian'],
        ['handout', 'learner'],
      ]);
      const learner = await f.as(f.own, () =>
        f.service.listLessonMaterials({ ...f.own, ...f.scope }),
      );
      expect(learner.map((m) => m.relationship)).toEqual([
        'learner-pages',
        'handout',
      ]);
      // The learner catalog projection follows the same rule.
      const catalog = await f.as(f.own, () =>
        (
          f.service as unknown as {
            catalog(
              r: unknown,
              id: string,
            ): Promise<{
              sections: Array<{
                lessons: Array<{ assets: Array<{ relationship: string }> }>;
              }>;
            }>;
          }
        ).catalog(f.own, String(f.course.id)),
      );
      expect(
        catalog.sections
          .flatMap((s) => s.lessons)
          .flatMap((l) => l.assets.map((a) => a.relationship))
          .sort(),
      ).toEqual(['handout', 'learner-pages']);
      // Learners cannot sign guardian material, even with its id.
      const guide = guardian.find((m) => m.relationship === 'teacher-guide');
      const key = guardian.find((m) => m.relationship === 'answer-key');
      for (const material of [guide, key])
        await expect(
          f.as(f.own, () =>
            f.service.signLessonMaterial({
              ...f.own,
              ...f.scope,
              materialId: String(material?.id),
            }),
          ),
        ).rejects.toThrow();
      await f.as(f.parent, () =>
        f.service.signLessonMaterial({
          ...f.parent,
          ...f.scope,
          materialId: String(key?.id),
        }),
      );
      expect(f.claims).toEqual([`lesson:${f.lesson.id}:${key?.assetId}`]);
      // A guardian may show the slides to the learner; never the key.
      const shown = await f.as(f.parent, () =>
        f.service.setMaterialAudience({
          ...f.parent,
          enrollmentId: f.scope.enrollmentId,
          scope: 'lesson',
          kind: 'file',
          materialId: String(slides.id),
          audience: 'learner',
        }),
      );
      expect(shown.audience).toBe('learner');
      expect(
        (
          await f.as(f.own, () =>
            f.service.listLessonMaterials({ ...f.own, ...f.scope }),
          )
        ).map((m) => m.relationship),
      ).toEqual(['slides', 'learner-pages', 'handout']);
      await expect(
        f.as(f.parent, () =>
          f.service.setMaterialAudience({
            ...f.parent,
            enrollmentId: f.scope.enrollmentId,
            scope: 'lesson',
            kind: 'file',
            materialId: String(key?.id),
            audience: 'learner',
          }),
        ),
      ).rejects.toThrow('guardian-only');
      await expect(
        f.as(f.own, () =>
          f.service.setMaterialAudience({
            ...f.own,
            enrollmentId: f.scope.enrollmentId,
            scope: 'lesson',
            kind: 'file',
            materialId: String(guide?.id),
            audience: 'learner',
          }),
        ),
      ).rejects.toThrow();
      // The older printable signer follows the audience too.
      const printable = await f.link('printable', 'public', 8);
      const signPrintable = (request: typeof f.own) =>
        f.as(request, () =>
          f.service.signLessonPrintable({
            ...request,
            ...f.scope,
            assetId: printable.assetId,
          }),
        );
      await signPrintable(f.own);
      await f.as(f.parent, () =>
        f.service.setMaterialAudience({
          ...f.parent,
          enrollmentId: f.scope.enrollmentId,
          scope: 'lesson',
          kind: 'file',
          materialId: String(printable.id),
          audience: 'guardian',
        }),
      );
      await expect(signPrintable(f.own)).rejects.toThrow();
      await signPrintable(f.parent);
      // Another family never reads these materials.
      await expect(
        f.as({ ...f.parent, tenantId: String(f.foreign.tenantId) }, () =>
          f.service.listLessonMaterials({
            ...f.parent,
            tenantId: String(f.foreign.tenantId),
            ...f.scope,
          }),
        ),
      ).rejects.toThrow();
    } finally {
      await f.db.close?.();
    }
  });

  it('adds external videos as references in step order, idempotently', async () => {
    const f = await fixture();
    try {
      const add = (reference: string, title: string, stepOrder: number) =>
        f.as(f.parent, () =>
          f.service.addLessonVideo({
            ...f.parent,
            ...f.scope,
            reference,
            title,
            stepOrder,
          }),
        );
      const second = await add('https://youtu.be/aaaaaaaaaaa', 'Step 2', 2);
      const first = await add(
        'https://www.youtube.com/watch?v=bbbbbbbbbbb',
        'Step 1',
        1,
      );
      expect(first).toMatchObject({
        kind: 'external-video',
        provider: 'youtube',
        videoId: 'bbbbbbbbbbb',
        audience: 'learner',
        assetId: null,
        embedUrl: 'https://www.youtube-nocookie.com/embed/bbbbbbbbbbb',
      });
      expect(await add('aaaaaaaaaaa', 'Step 2', 2)).toEqual(second);
      await expect(add('aaaaaaaaaaa', 'Renamed', 2)).rejects.toThrow(
        'other details',
      );
      await expect(add('https://vimeo.com/1', 'Elsewhere', 3)).rejects.toThrow(
        ExternalVideoReferenceError,
      );
      await expect(
        f.as(f.own, () =>
          f.service.addLessonVideo({
            ...f.own,
            ...f.scope,
            reference: 'ccccccccccc',
            title: 'Learner',
            stepOrder: 4,
          }),
        ),
      ).rejects.toThrow();
      expect(
        (
          await f.as(f.own, () =>
            f.service.listLessonMaterials({ ...f.own, ...f.scope }),
          )
        ).map((m) => m.title),
      ).toEqual(['Step 1', 'Step 2']);
      expect(await f.db.list('assets', {})).toEqual([]);
      // A guardian may keep a video for themselves.
      await f.as(f.parent, () =>
        f.service.setMaterialAudience({
          ...f.parent,
          enrollmentId: f.scope.enrollmentId,
          scope: 'lesson',
          kind: 'external-video',
          materialId: second.id,
          audience: 'guardian',
        }),
      );
      expect(
        (
          await f.as(f.own, () =>
            f.service.listLessonMaterials({ ...f.own, ...f.scope }),
          )
        ).map((m) => m.title),
      ).toEqual(['Step 1']);
    } finally {
      await f.db.close?.();
    }
  });

  it('lists course-level materials under the same audience rule', async () => {
    const f = await fixture();
    try {
      const create = async (
        relationship: string,
        access: 'private' | 'public',
        title: string,
        sortOrder = 0,
      ) => {
        const assetId = await f.asset(title, access);
        return withTenant(
          { tenantId: f.parent.tenantId, userId: f.parent.actorUserId },
          () =>
            withPrivateAssetAccess(
              {
                tenantId: f.parent.tenantId,
                actorUserId: f.parent.actorUserId,
                ownerProfileId: f.guardianProfile,
                assetIds: [assetId],
              },
              async () =>
                (await CourseAssetCollection.create({ db: f.db })).create({
                  tenantId: f.parent.tenantId,
                  courseId: String(f.course.id),
                  assetId,
                  relationship: relationship as never,
                  title,
                  sortOrder,
                }),
            ),
        );
      };
      await create('handout', 'public', 'Supply list', 0);
      await create('attachment', 'public', 'Poster', 1);
      await create('teacher-guide', 'public', 'Unit guide', 2);
      await expect(
        create('assessment-guidance', 'public', 'Rubric'),
      ).rejects.toThrow('private asset');
      expect(
        (
          await f.as(f.parent, () =>
            f.service.listCourseMaterials({
              ...f.parent,
              enrollmentId: f.scope.enrollmentId,
            }),
          )
        ).map((m) => [m.title, m.audience, m.scope]),
      ).toEqual([
        ['Supply list', 'learner', 'course'],
        ['Poster', 'learner', 'course'],
        ['Unit guide', 'guardian', 'course'],
      ]);
      const learner = await f.as(f.own, () =>
        f.service.listCourseMaterials({
          ...f.own,
          enrollmentId: f.scope.enrollmentId,
        }),
      );
      expect(learner.map((m) => m.title)).toEqual(['Supply list', 'Poster']);
      await f.as(f.own, () =>
        f.service.signCourseMaterial({
          ...f.own,
          enrollmentId: f.scope.enrollmentId,
          materialId: learner[0].id,
        }),
      );
      expect(f.claims).toEqual([`course:${f.course.id}:${learner[0].assetId}`]);
    } finally {
      await f.db.close?.();
    }
  });
});
