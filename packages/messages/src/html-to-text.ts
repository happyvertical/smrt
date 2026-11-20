/**
 * Linear-time HTML to plain text for quoting HTML-only mail in drafts.
 *
 * Single forward scan, no backtracking regexes, input capped at
 * HTML_TO_TEXT_MAX_INPUT. Markup is never passed through: tags are dropped,
 * and the content of script/style/head/title/template/noscript elements and
 * comments is dropped. Text hidden by CSS (display:none etc.) is NOT detected
 * and remains in the output.
 */
export const HTML_TO_TEXT_MAX_INPUT = 256 * 1024;

const SKIP = new Set([
  'script',
  'style',
  'head',
  'title',
  'template',
  'noscript',
]);
const BLOCK = new Set([
  'p',
  'div',
  'li',
  'tr',
  'br',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'blockquote',
  'table',
  'ul',
  'ol',
  'pre',
  'hr',
]);
const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  copy: '©',
  reg: '®',
  trade: '™',
  bull: '•',
  middot: '·',
};

function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (m, e) => {
    if (e[0] === '#') {
      const code =
        e[1] === 'x' || e[1] === 'X'
          ? Number.parseInt(e.slice(2), 16)
          : Number.parseInt(e.slice(1), 10);
      if (code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)) {
        return String.fromCodePoint(code);
      }
      return '';
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

export const HTML_TO_TEXT_TRUNCATED = '[\u2026truncated]';

/** Length-preserving ASCII-only lowercase (String#toLowerCase can change length). */
function asciiLower(text: string): string {
  return text.replace(/[A-Z]/g, (c) =>
    String.fromCharCode(c.charCodeAt(0) | 32),
  );
}

/** Bidi/format characters and C0/C1 controls (except \n and \t). */
function isUnsafe(code: number): boolean {
  return (
    (code <= 0x1f && code !== 0x0a && code !== 0x09) ||
    (code >= 0x7f && code <= 0x9f) ||
    (code >= 0x200b && code <= 0x200f) ||
    code === 0x2028 ||
    code === 0x2029 ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069) ||
    code === 0xfeff
  );
}

function stripUnsafe(text: string): string {
  let out = '';
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (isUnsafe(text.charCodeAt(i))) {
      out += text.slice(start, i);
      start = i + 1;
    }
  }
  return start === 0 ? text : out + text.slice(start);
}

export function htmlToText(html: string): string {
  let input = html;
  let truncated = false;
  if (input.length > HTML_TO_TEXT_MAX_INPUT) {
    let cut = HTML_TO_TEXT_MAX_INPUT;
    const last = input.charCodeAt(cut - 1);
    if (last >= 0xd800 && last <= 0xdbff) cut -= 1; // do not split a pair
    input = input.slice(0, cut);
    truncated = true;
  }
  const lower = asciiLower(input);
  const out: string[] = [];
  let i = 0;
  const n = input.length;
  while (i < n) {
    const lt = input.indexOf('<', i);
    if (lt === -1) {
      out.push(input.slice(i));
      break;
    }
    if (lt > i) out.push(input.slice(i, lt));
    const next = lower[lt + 1];
    if (next === undefined || !/[a-z/!?]/.test(next)) {
      // A bare `<` (e.g. "a < b") is literal text, not a tag.
      out.push('<');
      i = lt + 1;
      continue;
    }
    if (input.startsWith('<!--', lt)) {
      const end = input.indexOf('-->', lt + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    const gt = input.indexOf('>', lt + 1);
    if (gt === -1) {
      // Unterminated tag: drop the rest rather than emit markup.
      break;
    }
    let j = lt + 1;
    const closing = input[j] === '/';
    if (closing) j++;
    let k = j;
    while (k < gt && /[a-z0-9]/.test(lower[k])) k++;
    const name = lower.slice(j, k);
    i = gt + 1;
    if (!closing && SKIP.has(name)) {
      // Drop through the matching close tag; unclosed drops the remainder.
      let from = i;
      let found = -1;
      while (from < n) {
        const c = lower.indexOf(`</${name}`, from);
        if (c === -1) break;
        const after = lower[c + 2 + name.length];
        if (after === undefined || !/[a-z0-9]/.test(after)) {
          found = c;
          break;
        }
        from = c + 2;
      }
      if (found === -1) {
        i = n;
      } else {
        const close = input.indexOf('>', found);
        i = close === -1 ? n : close + 1;
      }
      continue;
    }
    if (BLOCK.has(name)) out.push('\n');
  }
  const lines = stripUnsafe(decodeEntities(out.join('')))

    .split('\n')
    .map((l) => l.trimEnd());
  // Collapse runs of blank lines to at most one, linearly.
  const kept: string[] = [];
  let blanks = 0;
  for (const line of lines) {
    if (line === '') {
      blanks++;
      if (blanks > 1) continue;
    } else {
      blanks = 0;
    }
    kept.push(line);
  }
  const text = kept.join('\n').trim();
  return truncated ? `${text}\n${HTML_TO_TEXT_TRUNCATED}` : text;
}
