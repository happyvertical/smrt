/**
 * Minimal, escaping Markdown renderer for assistant answers (#4505).
 *
 * The output is meant for `{@html}`, so the contract is safety first: every
 * character of the input is HTML-escaped before any markup is produced, and
 * the only tags emitted are the fixed set below with no attributes except a
 * validated `href` (http/https only, with `rel="noopener noreferrer"` and
 * `target="_blank"`), an ordered list's numeric `start`, and a code block's
 * `language-*` class from a restricted alphabet. Raw HTML in the input is
 * shown as text, never interpreted.
 *
 * Supported: paragraphs (single newlines become `<br>`), `#`/`##`/`###`
 * headings, `-`/`*`/`+` and `1.`/`1)` lists (one level), fenced code blocks
 * (``` or ~~~), inline `code`, `**bold**`/`__bold__`, `*italic*`/`_italic_`,
 * and `[text](https://…)` links. Anything else renders as literal text.
 */

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escape text for an HTML text node or a double-quoted attribute value. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character]);
}

/** Placeholder delimiter; stripped from the input so it can never collide. */
const MARK = '\u0000';
// biome-ignore lint/suspicious/noControlCharactersInRegex: the placeholder delimiter is a NUL by design.
const MARK_PATTERN = /\u0000(\d+)\u0000/g;
const FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*([A-Za-z0-9_+-]{0,32})[ \t]*$/;
const HEADING = /^ {0,3}(#{1,3})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const UNORDERED_ITEM = /^ {0,3}[-*+][ \t]+(.*)$/;
const ORDERED_ITEM = /^ {0,3}(\d{1,9})[.)][ \t]+(.*)$/;
const CONTINUATION = /^(?: {2,}|\t)\S/;

/** A safe absolute http(s) URL for an href, already attribute-escaped. */
function safeHref(raw: string): string | null {
  // The link target was escaped with the rest of the text; undo only the
  // entity escaping to parse it, then re-escape the normalized result.
  const unescaped = raw
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
  let url: URL;
  try {
    url = new URL(unescaped);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return escapeHtml(url.href);
}

/** Bold and italic on already-escaped text without placeholders' digits. */
function emphasis(text: string): string {
  return text
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
    .replace(
      /(^|[^\p{L}\p{N}_])__(?=\S)([\s\S]*?\S)__(?![\p{L}\p{N}_])/gu,
      '$1<strong>$2</strong>',
    )
    .replace(/\*(?=[^\s*])([^*]*?[^\s*])\*/g, '<em>$1</em>')
    .replace(
      /(^|[^\p{L}\p{N}_])_(?=[^\s_])([^_]*?[^\s_]|[^\s_])_(?![\p{L}\p{N}_])/gu,
      '$1<em>$2</em>',
    );
}

/**
 * Longest line that gets block or inline parsing. The lazy emphasis, code
 * span and heading patterns scan to the end of the line from each start
 * position, so one pathological line (many openers, no closers) costs
 * O(n^2); above this bound a line is escaped as plain text instead, which
 * keeps a streamed reply's per-token re-render bounded (#4505 review).
 */
const LINE_PARSE_LIMIT = 2000;

/** Render one line's inline Markdown. `text` is raw (unescaped) input. */
function inline(text: string): string {
  if (text.length > LINE_PARSE_LIMIT) return escapeHtml(text);
  const slots: string[] = [];
  const slot = (html: string) => {
    slots.push(html);
    return `${MARK}${slots.length - 1}${MARK}`;
  };
  let out = escapeHtml(text);
  // Code spans first: their content is literal.
  out = out.replace(
    /(`{1,2})(?!`)([^\n]*?[^`\n]|[^`\n])\1(?!`)/g,
    (_, _ticks, code: string) => slot(`<code>${code}</code>`),
  );
  // Links next, so emphasis never rewrites an href.
  out = out.replace(
    /\[([^\]\n]+)\]\(([^()\s]+)\)/g,
    (whole: string, label: string, target: string) => {
      const href = safeHref(target);
      if (!href) return whole;
      return slot(
        `<a href="${href}" target="_blank" rel="noopener noreferrer">${emphasis(label)}</a>`,
      );
    },
  );
  out = emphasis(out);
  // Restore placeholders (a link label may itself hold a code span).
  let previous: string;
  do {
    previous = out;
    out = out.replace(
      MARK_PATTERN,
      (_, index: string) => slots[Number(index)] ?? '',
    );
  } while (out !== previous);
  return out;
}

type ListKind = 'ul' | 'ol';

/**
 * Render assistant Markdown to sanitized HTML. Safe for `{@html}`: see the
 * module comment for the exact output vocabulary.
 */
export function renderAssistantMarkdown(source: string): string {
  const lines = String(source ?? '')
    .split(MARK)
    .join('')
    .replace(/\r\n?/g, '\n')
    .split('\n');
  const blocks: string[] = [];
  let paragraph: string[] = [];
  // Cast so the declaration does not narrow to `null` (closures reassign it).
  let list = null as {
    kind: ListKind;
    start: number;
    items: string[][];
  } | null;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push(`<p>${paragraph.map(inline).join('<br>')}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    const start =
      list.kind === 'ol' && list.start !== 1 ? ` start="${list.start}"` : '';
    const items = list.items
      .map((item) => `<li>${item.map(inline).join('<br>')}</li>`)
      .join('');
    blocks.push(`<${list.kind}${start}>${items}</${list.kind}>`);
    list = null;
  };
  const flush = () => {
    flushParagraph();
    flushList();
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.length > LINE_PARSE_LIMIT) {
      // Too long for the line patterns: plain paragraph text (see
      // LINE_PARSE_LIMIT).
      flushList();
      paragraph.push(line);
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const marker = fence[1];
      const closing = new RegExp(
        `^ {0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}[ \\t]*$`,
      );
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !closing.test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      const language = fence[2] ? ` class="language-${fence[2]}"` : '';
      blocks.push(
        `<pre><code${language}>${escapeHtml(code.join('\n'))}</code></pre>`,
      );
      continue;
    }
    if (line.trim() === '') {
      flush();
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      const level = heading[1].length;
      blocks.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }
    const unordered = UNORDERED_ITEM.exec(line);
    const ordered = unordered ? null : ORDERED_ITEM.exec(line);
    if (unordered || ordered) {
      flushParagraph();
      const kind: ListKind = unordered ? 'ul' : 'ol';
      if (list && list.kind !== kind) flushList();
      if (!list) {
        list = {
          kind,
          start: ordered ? Number(ordered[1]) : 1,
          items: [],
        };
      }
      list.items.push([unordered ? unordered[1] : (ordered?.[2] ?? '')]);
      continue;
    }
    if (list && CONTINUATION.test(line)) {
      list.items[list.items.length - 1].push(line.trim());
      continue;
    }
    flushList();
    paragraph.push(line);
  }
  flush();
  return blocks.join('');
}
