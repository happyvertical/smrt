import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { tinyPdf } from './bundle-zip-writer.js';
import { opened, setup } from './course-bundle-course-workflows.js';
import { officeDocx } from './office-fixtures.js';

/*
 * Plain-files imports (no manifest), smrt#4718:
 *  every member becomes learner material, body for text .... 'materials'
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

describe('plain-files materials', () => {
  it('attaches every member as learner material and the Markdown as the lesson body', async () => {
    const s = await setup();
    const { attached } = await attachPlain(s, 'a');
    const lessons = await ownLessons(s, attached.lessons);
    expect(lessons).toHaveLength(3);
    const byRef = (title: string) =>
      lessons.find((l) => String(l.title) === title);
    expect(String(byRef('notes')?.body)).toContain('weather a');
    const mine = new Set(lessons.map((l) => String(l.id)));
    const rows = (await s.db.list('lesson_assets', {})).filter((r) =>
      mine.has(String(r.lesson_id)),
    );
    // md (stored original), pdf (original), docx (rendered form only).
    expect(attached.lessonAssets).toBe(3);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.audience === 'learner')).toBe(true);
    expect(rows.every((r) => r.relationship === 'attachment')).toBe(true);
    const docx = rows.find((r) => r.rendition === 'rendered');
    expect(docx).toBeDefined();
    expect(rows.filter((r) => r.rendition === 'original')).toHaveLength(0);
  });

  it('keeps a Markdown-only lesson readable through its body', async () => {
    const s = await setup();
    const bundle = {
      files: [{ path: 'only.md', bytes: Buffer.from('# Only\n\nread me\n') }],
    };
    const { result, assets } = await s.importAndStore(bundle);
    const { ['only.md']: md } = assets;
    // A host may store text as an asset or not; the body must not depend on it.
    const withoutAsset = md
      ? { 'only.md': { ...md, original: undefined } }
      : {};
    const done = await s.attach(
      bundle,
      result.import.importId,
      withoutAsset as never,
    );
    const [lesson] = await ownLessons(s, done.lessons);
    expect(String(lesson?.body)).toContain('read me');
  });
});
