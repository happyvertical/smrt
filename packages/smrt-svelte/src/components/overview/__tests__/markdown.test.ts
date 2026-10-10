import { describe, expect, it } from 'vitest';
import { parseMarkdown, safeHref } from '../markdown.js';

describe('safeHref', () => {
  it('allows http(s), mailto, same-site paths and fragments', () => {
    for (const ok of [
      'https://example.com/a?b=c',
      'http://example.com',
      'mailto:a@example.com',
      '/events/1',
      '#top',
    ]) {
      expect(safeHref(ok)).toBe(ok);
    }
  });

  it('rejects scripts, data URLs, protocol-relative and odd input', () => {
    for (const bad of [
      'javascript:alert(1)',
      ' JaVaScRiPt:alert(1)',
      'java\nscript:alert(1)',
      'data:text/html,<script>1</script>',
      'vbscript:x',
      '//evil.example/x',
      'events/1',
      'https://exa mple.com',
      'https://example.com/"onmouseover="x',
      '',
      `https://example.com/${'a'.repeat(3000)}`,
    ]) {
      expect(safeHref(bad)).toBeNull();
    }
  });
});

describe('parseMarkdown', () => {
  it('parses blocks and inline marks', () => {
    const blocks = parseMarkdown(
      [
        '# Title',
        '',
        'Hello **bold** and *it* and `code` and [a link](https://example.com).',
        '',
        '- one',
        '- two',
        '',
        '1. first',
        '2) second',
        '',
        '> quoted',
        '',
        '```',
        'raw <b>text</b>',
        '```',
      ].join('\n'),
    );
    expect(blocks.map((b) => b.type)).toEqual([
      'heading',
      'paragraph',
      'list',
      'list',
      'quote',
      'code',
    ]);
    const para = blocks[1];
    expect(
      para.type === 'paragraph' && para.children.map((n) => n.type),
    ).toEqual([
      'text',
      'strong',
      'text',
      'em',
      'text',
      'code',
      'text',
      'link',
      'text',
    ]);
    expect(blocks[2]).toMatchObject({ ordered: false });
    expect(blocks[3]).toMatchObject({ ordered: true });
    expect(blocks[5]).toEqual({ type: 'code', text: 'raw <b>text</b>' });
  });

  it('treats HTML as text and drops unsafe link targets', () => {
    const blocks = parseMarkdown(
      '<script>alert(1)</script> [x](javascript:alert(1)) ![i](http://e.co/a.png)',
    );
    const flat = JSON.stringify(blocks);
    expect(flat).toContain('<script>alert(1)</script>');
    expect(flat).not.toContain('javascript:');
    // the label survives as plain text
    expect(flat).toContain('"x"');
  });

  it('does not italicise snake_case or stray asterisks, and honours escapes', () => {
    const blocks = parseMarkdown('snake_case_name 2 * 3 * 4 \\*literal\\*');
    const para = blocks[0];
    expect(para.type === 'paragraph' && para.children).toEqual([
      { type: 'text', text: 'snake_case_name 2 * 3 * 4 *literal*' },
    ]);
  });

  it('bounds nesting and size, and never throws', () => {
    const nested = `${'*a'.repeat(200)}${'*'.repeat(200)}`;
    expect(() => parseMarkdown(nested)).not.toThrow();
    const many = parseMarkdown(
      Array.from({ length: 1000 }, (_, i) => `# h${i}`).join('\n'),
    );
    expect(many.length).toBeLessThanOrEqual(200);
    expect(parseMarkdown('x'.repeat(100_000))).toHaveLength(1);
  });
});
