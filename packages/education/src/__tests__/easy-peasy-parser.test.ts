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
    expect(() =>
      parseEasyPeasyPage(fixture('easy-peasy-unsafe.html'), pageUrl),
    ).toThrow('approved HTTPS source host');
    expect(() =>
      validateEasyPeasyUrl('http://allinonehomeschool.com/course/'),
    ).toThrow('approved HTTPS source host');
    expect(() => validateEasyPeasyUrl('javascript:alert(1)', pageUrl)).toThrow(
      'approved HTTPS source host',
    );
  });

  it('rejects multiple printable PDFs for one lesson', () => {
    const html = `
      <h1>Course</h1><p><strong>Lesson 1 *</strong></p>
      <a href="/wp-content/uploads/one.pdf">One</a>
      <a href="/wp-content/uploads/two.pdf">Two</a>`;
    expect(() => parseEasyPeasyPage(html, pageUrl)).toThrow('ambiguous');
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
