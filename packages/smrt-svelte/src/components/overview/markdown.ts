/**
 * A small, safe Markdown subset for the note widget (#3727).
 *
 * It parses to a node tree that components render as Svelte elements. There
 * is no HTML output and no `{@html}`: raw HTML in the source is plain text,
 * and links pass {@link safeHref}, so a stored note cannot inject markup or a
 * `javascript:` URL by construction.
 *
 * Supported: `#`-`###` headings, paragraphs, `-`/`*` and `1.` lists,
 * `>` quotes, fenced code, and inline **bold**, *italic*, `code`, and
 * [links](https://example.com). Anything else is literal text.
 */

export type InlineNode =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'strong' | 'em'; children: InlineNode[] }
  | { type: 'link'; href: string; children: InlineNode[] };

export type BlockNode =
  | { type: 'heading'; level: 1 | 2 | 3; children: InlineNode[] }
  | { type: 'paragraph'; children: InlineNode[] }
  | { type: 'quote'; children: InlineNode[] }
  | { type: 'list'; ordered: boolean; items: InlineNode[][] }
  | { type: 'code'; text: string };

const MAX_BLOCKS = 200;
const MAX_INLINE_DEPTH = 4;
const MAX_SOURCE = 20_000;

/**
 * The URL when it is safe to link: `http(s):`, `mailto:`, a same-site path
 * (`/x`, not `//host`), or a fragment. Everything else (`javascript:`,
 * `data:`, control characters, whitespace, quotes) is `null`.
 */
export function safeHref(raw: string): string | null {
  const url = raw.trim();
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
  if (!url || url.length > 2048 || /[\u0000-\u001f\u007f\s<>"'`\\]/.test(url)) {
    return null;
  }
  if (/^https?:\/\//i.test(url)) {
    try {
      new URL(url);
      return url;
    } catch {
      return null;
    }
  }
  if (/^mailto:[^\s?]+(\?.*)?$/i.test(url)) return url;
  if (url.startsWith('#')) return url;
  if (url.startsWith('/') && !url.startsWith('//')) return url;
  return null;
}

const isWordChar = (ch: string | undefined): boolean =>
  ch !== undefined && /[A-Za-z0-9]/.test(ch);

function parseInline(src: string, depth: number): InlineNode[] {
  const out: InlineNode[] = [];
  let text = '';
  const flush = (): void => {
    if (text) out.push({ type: 'text', text });
    text = '';
  };
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (
      ch === '\\' &&
      i + 1 < src.length &&
      /[\\`*_[\]()#>-]/.test(src[i + 1])
    ) {
      text += src[i + 1];
      i += 2;
      continue;
    }
    if (ch === '`') {
      const end = src.indexOf('`', i + 1);
      if (end > i + 1) {
        flush();
        out.push({ type: 'code', text: src.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if (depth < MAX_INLINE_DEPTH && src.startsWith('**', i)) {
      const end = src.indexOf('**', i + 2);
      if (end > i + 2) {
        flush();
        out.push({
          type: 'strong',
          children: parseInline(src.slice(i + 2, end), depth + 1),
        });
        i = end + 2;
        continue;
      }
    }
    if (
      depth < MAX_INLINE_DEPTH &&
      (ch === '*' || ch === '_') &&
      src[i + 1] !== ' ' &&
      !(ch === '_' && isWordChar(src[i - 1]))
    ) {
      const end = src.indexOf(ch, i + 1);
      if (
        end > i + 1 &&
        src[end - 1] !== ' ' &&
        !(ch === '_' && isWordChar(src[end + 1]))
      ) {
        flush();
        out.push({
          type: 'em',
          children: parseInline(src.slice(i + 1, end), depth + 1),
        });
        i = end + 1;
        continue;
      }
    }
    if (ch === '[' && depth < MAX_INLINE_DEPTH) {
      const close = src.indexOf('](', i + 1);
      const endParen = close > 0 ? src.indexOf(')', close + 2) : -1;
      if (close > 0 && endParen > 0) {
        const label = src.slice(i + 1, close);
        const href = safeHref(src.slice(close + 2, endParen));
        flush();
        if (href) {
          out.push({
            type: 'link',
            href,
            children: parseInline(label, depth + 1),
          });
        } else {
          // An unsafe target keeps the label as plain text.
          out.push(...parseInline(label, depth + 1));
        }
        i = endParen + 1;
        continue;
      }
    }
    text += ch;
    i += 1;
  }
  flush();
  return out;
}

/** Parse a note into blocks. Total; capped in size and nesting. */
export function parseMarkdown(source: string): BlockNode[] {
  const lines = source.slice(0, MAX_SOURCE).replace(/\r\n?/g, '\n').split('\n');
  const blocks: BlockNode[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: InlineNode[][] } | null = null;
  const closeParagraph = (): void => {
    if (paragraph.length) {
      blocks.push({
        type: 'paragraph',
        children: parseInline(paragraph.join(' '), 0),
      });
    }
    paragraph = [];
  };
  const closeList = (): void => {
    if (list) blocks.push({ type: 'list', ...list });
    list = null;
  };
  for (let i = 0; i < lines.length && blocks.length < MAX_BLOCKS; i += 1) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      closeParagraph();
      closeList();
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !/^\s*```/.test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      blocks.push({ type: 'code', text: body.join('\n') });
      continue;
    }
    if (line.trim() === '') {
      closeParagraph();
      closeList();
      continue;
    }
    const heading = /^(#{1,3})\s+(.*\S)\s*$/.exec(line);
    if (heading) {
      closeParagraph();
      closeList();
      blocks.push({
        type: 'heading',
        level: heading[1].length as 1 | 2 | 3,
        children: parseInline(heading[2], 0),
      });
      continue;
    }
    const bullet = /^\s*[-*]\s+(.*\S)\s*$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*\S)\s*$/.exec(line);
    if (bullet || numbered) {
      closeParagraph();
      const ordered = numbered !== null;
      if (list && list.ordered !== ordered) closeList();
      list ??= { ordered, items: [] };
      list.items.push(parseInline((bullet ?? numbered)?.[1] ?? '', 0));
      continue;
    }
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      closeParagraph();
      closeList();
      blocks.push({ type: 'quote', children: parseInline(quote[1], 0) });
      continue;
    }
    closeList();
    paragraph.push(line.trim());
  }
  closeParagraph();
  closeList();
  return blocks.slice(0, MAX_BLOCKS);
}
