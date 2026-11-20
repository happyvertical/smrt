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

export function htmlToText(html: string): string {
  const input =
    html.length > HTML_TO_TEXT_MAX_INPUT
      ? html.slice(0, HTML_TO_TEXT_MAX_INPUT)
      : html;
  const lower = input.toLowerCase();
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
        const c = lower.indexOf('</' + name, from);
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
  return decodeEntities(out.join(''))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
