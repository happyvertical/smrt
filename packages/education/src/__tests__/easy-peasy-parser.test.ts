import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  parseEasyPeasyPage,
  validateEasyPeasyUrl,
} from '../sources/easy-peasy-parser.js';

const fixture = (name: string): string =>
  readFileSync(
    fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)),
    'utf8',
  );

describe('parseEasyPeasyPage', () => {
  const pageUrl = 'https://allinonehomeschool.com/language-arts-4/';

  it('keeps only title, day pointers, and source-hosted printable links', () => {
    expect(
      parseEasyPeasyPage(fixture('easy-peasy-course.html'), pageUrl),
    ).toEqual({
      title: 'Language Arts & Stories',
      packetUrl:
        'https://allinonehomeschool.com/wp-content/uploads/2026/language-arts-packet.pdf',
      lessons: [
        {
          day: 1,
          title: 'Lesson 1',
          externalRef: 'lesson:1',
          externalUrl:
            'https://allinonehomeschool.com/language-arts-4/#lesson-1',
          worksheet: false,
        },
        {
          day: 2,
          title: 'Lesson 2',
          externalRef: 'lesson:2',
          externalUrl:
            'https://allinonehomeschool.com/language-arts-4/#lesson-2',
          worksheet: true,
          printableUrl:
            'https://allinonehomeschool.com/wp-content/uploads/2026/lesson-2.pdf',
        },
        {
          day: 3,
          title: 'Lesson 3',
          externalRef: 'lesson:3',
          externalUrl:
            'https://allinonehomeschool.com/language-arts-4/#lesson-3',
          worksheet: true,
        },
      ],
    });
  });

  it('parses the official daily-container marker layout without retaining lesson content', () => {
    expect(
      parseEasyPeasyPage(
        fixture('easy-peasy-day-container.html'),
        'https://allinonehomeschool.com/ep-math-4/',
      ),
    ).toMatchObject({
      title: 'EP Math 4 – Easy Peasy All-in-One Homeschool',
      lessons: [
        { day: 1, worksheet: false },
        { day: 2, worksheet: false },
        { day: 3, worksheet: false },
        {
          day: 4,
          worksheet: true,
          printableUrl:
            'https://allinonehomeschool.com/wp-content/uploads/2022/03/ep-math-4-lesson-4.pdf',
        },
        {
          day: 5,
          worksheet: true,
          printableUrl:
            'https://allinonehomeschool.com/wp-content/uploads/2022/03/ep-math-4-lesson-5.pdf',
        },
        {
          day: 6,
          title: 'Week 6',
          externalUrl: 'https://allinonehomeschool.com/ep-math-4/#week6',
        },
      ],
    });
  });

  it('uses day identities and stable fragments when the source page URL changes', () => {
    const html = fixture('easy-peasy-course.html');
    const first = parseEasyPeasyPage(html, pageUrl).lessons[0];
    const moved = parseEasyPeasyPage(
      html,
      'https://allinonehomeschool.com/archive/language-arts/',
    ).lessons[0];
    expect(first.externalRef).toBe(moved.externalRef);
    expect(first.externalUrl).toMatch(/#lesson-1$/);
    expect(moved.externalUrl).toMatch(/#lesson-1$/);
  });

  it('rejects absent, malformed, and duplicate lesson headings', () => {
    expect(() => parseEasyPeasyPage('<h1>Empty</h1>', pageUrl)).toThrow(
      'no lesson headings',
    );
    expect(() =>
      parseEasyPeasyPage(fixture('easy-peasy-malformed.html'), pageUrl),
    ).toThrow('malformed');
    expect(() =>
      parseEasyPeasyPage(fixture('easy-peasy-duplicate.html'), pageUrl),
    ).toThrow('duplicated');
  });

  it('rejects unterminated and mismatched lesson heading tags', () => {
    expect(() =>
      parseEasyPeasyPage(
        '<h1>Course</h1><h2>Lesson 1</h2><h2>Lesson 2',
        pageUrl,
      ),
    ).toThrow('unterminated or mismatched');
    expect(() =>
      parseEasyPeasyPage('<h1>Course</h1><h2>Lesson 1</h3>', pageUrl),
    ).toThrow('unterminated or mismatched');
  });

  it('rejects unsafe URLs and does not retain answer links', () => {
    expect(
      parseEasyPeasyPage(fixture('easy-peasy-unsafe.html'), pageUrl),
    ).toMatchObject({
      lessons: [expect.objectContaining({ day: 1, worksheet: true })],
    });
    expect(
      parseEasyPeasyPage(fixture('easy-peasy-unsafe.html'), pageUrl).lessons[0],
    ).not.toHaveProperty('printableUrl');
    expect(() =>
      validateEasyPeasyUrl('http://allinonehomeschool.com/course/'),
    ).toThrow('approved HTTPS source host');
    expect(() => validateEasyPeasyUrl('javascript:alert(1)', pageUrl)).toThrow(
      'approved HTTPS source host',
    );
  });

  it('retains the lesson pointer but no printable when source metadata has multiple PDFs', () => {
    const html = `
      <h1>Course</h1><p><strong>Lesson 1 *</strong></p>
      <a href="/wp-content/uploads/one.pdf">One</a>
      <a href="/wp-content/uploads/two.pdf">Two</a>`;
    const lesson = parseEasyPeasyPage(html, pageUrl).lessons[0];
    expect(lesson).toMatchObject({ day: 1, worksheet: true });
    expect(lesson).not.toHaveProperty('printableUrl');
  });

  it('keeps a lesson segment open through unrelated bold instructions', () => {
    const html = `
      <h1>Course</h1>
      <p><strong>Lesson 1 *</strong></p>
      <p><strong>Print this worksheet</strong></p>
      <a href="/wp-content/uploads/day-1.pdf">Worksheet</a>
      <p><strong>Lesson 2</strong></p>`;
    expect(parseEasyPeasyPage(html, pageUrl).lessons).toEqual([
      expect.objectContaining({
        day: 1,
        printableUrl:
          'https://allinonehomeschool.com/wp-content/uploads/day-1.pdf',
      }),
      expect.objectContaining({ day: 2 }),
    ]);
  });

  it('ends the last lesson at a structural Resources heading', () => {
    const html =
      '<h1>Course</h1><p><strong>Lesson 3 *</strong></p><h2>Resources</h2><a href="/wp-content/uploads/supply-list.pdf">Supply list</a>';
    expect(parseEasyPeasyPage(html, pageUrl).lessons).toEqual([
      expect.objectContaining({ day: 3, worksheet: true }),
    ]);
    expect(parseEasyPeasyPage(html, pageUrl).lessons[0]).not.toHaveProperty(
      'printableUrl',
    );
  });

  it('keeps the canonical URL when an official worksheet has numbered pages', () => {
    const parsed = parseEasyPeasyPage(
      '<h1>Course</h1><div id="day9"><p><strong>Lesson 9*</strong></p><a href="/wp-content/lesson-9.pdf">worksheet</a><a href="/wp-content/lesson-9-2.pdf">page two</a></div>',
      pageUrl,
    );
    expect(parsed.lessons).toEqual([
      expect.objectContaining({
        day: 9,
        printableUrl: 'https://allinonehomeschool.com/wp-content/lesson-9.pdf',
      }),
    ]);
  });

  it('keeps generic printable labels on their lesson rather than the course packet', () => {
    const parsed = parseEasyPeasyPage(
      '<h1>Course</h1><h2>Lesson 1 *</h2><a href="/wp-content/one.pdf">Printable</a><h2>Lesson 2 *</h2><a href="/wp-content/two.pdf">Printables</a>',
      pageUrl,
    );
    expect(parsed).not.toHaveProperty('packetUrl');
    expect(parsed.lessons.map((lesson) => lesson.printableUrl)).toEqual([
      'https://allinonehomeschool.com/wp-content/one.pdf',
      'https://allinonehomeschool.com/wp-content/two.pdf',
    ]);
  });

  it('uses only actual href attributes, never data-href', () => {
    const parsed = parseEasyPeasyPage(
      '<h1>Course</h1><h2>Lesson 1 *</h2><a data-href="/wp-content/wrong.pdf" href="/wp-content/right.pdf">Worksheet</a><h2>Lesson 2 *</h2><a data-href="/wp-content/absent.pdf">Worksheet</a>',
      pageUrl,
    );
    expect(parsed.lessons[0].printableUrl).toBe(
      'https://allinonehomeschool.com/wp-content/right.pdf',
    );
    expect(parsed.lessons[1]).not.toHaveProperty('printableUrl');
  });

  it('rejects ambiguous compact and generic-container lesson marker layouts', () => {
    const compact = `
      <h1>Course</h1>
      <p><strong>Lesson 1 *</strong><br><strong>Lesson 2 *</strong>
      <a href="/wp-content/uploads/day-2.pdf">Worksheet</a></p>`;
    const genericContainer = `
      <h1>Course</h1>
      <div><span><strong>Lesson 3 *</strong></span>
      <a href="/wp-content/uploads/day-3.pdf">Worksheet</a></div>`;
    expect(() => parseEasyPeasyPage(compact, pageUrl)).toThrow('unsupported');
    expect(() => parseEasyPeasyPage(genericContainer, pageUrl)).toThrow(
      'unsupported',
    );
  });

  it('ignores scripts, comments, and third-party non-PDF links', () => {
    const html = `
      <h1>Course</h1>
      <!-- <p><strong>Lesson 99 *</strong></p> -->
      <script>const fake = '<strong>Lesson 100 *</strong>';</script>
      <p><strong>Lesson 1</strong></p>
      <a href="https://attacker.test/lesson">Unrelated source link</a>`;
    expect(parseEasyPeasyPage(html, pageUrl).lessons).toEqual([
      expect.objectContaining({ day: 1, worksheet: false }),
    ]);
  });
});
