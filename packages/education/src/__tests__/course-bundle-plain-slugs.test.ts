import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { tinyPdf } from './bundle-zip-writer.js';
import { opened, setup } from './course-bundle-course-workflows.js';
import { officeDocx } from './office-fixtures.js';

/*
 * Plain-files imports (no manifest), smrt#4716:
 *  a second/Nth plain import in one tenant attaches ........ 'slugs'
 */
beforeAll(() => enableTenancy());
afterAll(() => disableTenancy());
afterEach(async () => {
  for (const db of opened.splice(0)) await db.close?.();
});

type Files = ReturnType<typeof setup> extends Promise<infer S> ? S : never;

/** Same file names every time; `tag` varies the bytes so each bundle is distinct. */
const plain = (tag: string) => ({
  files: [
    { path: 'notes.md', bytes: Buffer.from(`# Notes\n\nweather ${tag}\n`) },
    { path: 'worksheet.pdf', bytes: tinyPdf(`worksheet ${tag}`) },
    { path: 'report.docx', bytes: officeDocx(`report ${tag}`) },
  ],
});

const ownLessons = async (s: Files, ids: Record<string, string>) =>
  (await s.db.list('lessons', {})).filter((l) =>
    Object.values(ids).includes(String(l.id)),
  );

async function attachPlain(s: Files, tag: string) {
  const bundle = plain(tag);
  const { result, assets } = await s.importAndStore(bundle);
  return {
    result,
    attached: await s.attach(bundle, result.import.importId, assets),
    bundle,
    assets,
  };
}

describe('plain-files slugs', () => {
  it('attaches a second and third bundle with identical names in one tenant', async () => {
    const s = await setup();
    const first = await attachPlain(s, 'a');
    const second = await attachPlain(s, 'b');
    const third = await attachPlain(s, 'c');
    const ids = new Set([
      first.attached.courseId,
      second.attached.courseId,
      third.attached.courseId,
    ]);
    expect(ids.size).toBe(3);
    expect((await s.db.list('courses', {})).length).toBeGreaterThanOrEqual(3);
    const all = [first, second, third].flatMap((x) =>
      Object.values(x.attached.lessons),
    );
    const own = (await s.db.list('lessons', {})).filter((l) =>
      all.includes(String(l.id)),
    );
    expect(own).toHaveLength(9);
    const slugs = own.map((l) => String(l.slug));
    expect(new Set(slugs).size).toBe(9);
    expect(slugs.every((x) => x.startsWith('bundle-lesson-'))).toBe(true);
  });

  it('stays idempotent when the same bundle is attached again', async () => {
    const s = await setup();
    const first = await attachPlain(s, 'a');
    await attachPlain(s, 'b');
    const before = await s.counts();
    const again = await s.attach(
      first.bundle,
      first.result.import.importId,
      first.assets,
    );
    expect(again).toMatchObject({
      courseId: first.attached.courseId,
      created: false,
      replayed: true,
      lessonAssets: 0,
    });
    expect(await s.counts()).toEqual(before);
  });
});
