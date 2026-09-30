import sanitize from 'sanitize-html';

export type ContentBodyFormat = 'markdown' | 'html';
export type ContentBodyImagePlacement =
  | 'block'
  | 'left'
  | 'right'
  | 'center'
  | 'full';

export interface ContentBodyImage {
  src: string;
  alt: string;
  title?: string;
  assetId?: string;
  placement?: ContentBodyImagePlacement;
  width?: number;
  /** True for the content's thumbnail block (see `placeThumbnailInBody`). */
  thumbnail?: boolean;
  /**
   * True for a picture in the story the person chose as the main picture
   * (see `setBodyMainImage`).
   */
  main?: boolean;
  index: number;
}

export const DEFAULT_CONTENT_BODY_FORMAT: ContentBodyFormat = 'html';

const HTML_TAG_PATTERN =
  /<\/?(?:article|aside|blockquote|br|div|figure|figcaption|h[1-6]|hr|img|li|ol|p|pre|section|span|strong|em|b|i|u|a|ul|table|tbody|td|th|thead|tr)(?:\s[^>]*)?>/i;
const BLOCK_TAGS = [
  'address',
  'article',
  'aside',
  'blockquote',
  'div',
  'dl',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'tbody',
  'td',
  'th',
  'thead',
  'tr',
  'ul',
];

export function isContentBodyFormat(
  value: unknown,
): value is ContentBodyFormat {
  return value === 'markdown' || value === 'html';
}

export function looksLikeHtml(value: unknown): boolean {
  return typeof value === 'string' && HTML_TAG_PATTERN.test(value);
}

export function resolveBodyFormat(
  format: unknown,
  body: unknown = '',
): ContentBodyFormat {
  if (isContentBodyFormat(format)) {
    return format;
  }

  if (typeof format === 'string' && isContentBodyFormat(format.toLowerCase())) {
    return format.toLowerCase() as ContentBodyFormat;
  }

  if (looksLikeHtml(body)) {
    return 'html';
  }

  return body ? 'markdown' : DEFAULT_CONTENT_BODY_FORMAT;
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case "'":
        return '&#39;';
      default:
        return char;
    }
  });
}

export function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/`/g, '&#96;');
}

function decodeBasicEntities(value: string): string {
  const decodeCodePoint = (codePoint: number) =>
    Number.isFinite(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
      ? String.fromCodePoint(codePoint)
      : '';

  return value
    .replace(/&#x([0-9a-f]+);?/gi, (_match, hex: string) => {
      const codePoint = Number.parseInt(hex, 16);
      return decodeCodePoint(codePoint);
    })
    .replace(/&#(\d+);?/g, (_match, decimal: string) => {
      const codePoint = Number.parseInt(decimal, 10);
      return decodeCodePoint(codePoint);
    })
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

function sanitizeUrl(value: string): string {
  const trimmed = decodeBasicEntities(value).trim();
  if (!trimmed) {
    return '';
  }

  let compactScheme = '';
  for (const char of trimmed) {
    const code = char.charCodeAt(0);
    if (code <= 31 || code === 127 || char.trim() === '') {
      continue;
    }
    compactScheme += char.toLowerCase();
  }

  if (/^(?:javascript|vbscript):/.test(compactScheme)) {
    return '#';
  }

  if (
    compactScheme.startsWith('data:') &&
    !/^data:image\/(?:png|gif|jpe?g|webp);/.test(compactScheme)
  ) {
    return '#';
  }

  return trimmed;
}

function sanitizeStyle(value: string): string {
  const safeRules: string[] = [];

  for (const rawRule of decodeBasicEntities(value).split(';')) {
    const [rawName, ...rawValueParts] = rawRule.split(':');
    const name = rawName?.trim().toLowerCase();
    const ruleValue = rawValueParts.join(':').trim().toLowerCase();

    if (!name || !ruleValue) {
      continue;
    }

    if (
      (name === 'width' || name === 'max-width') &&
      /^(?:\d{1,4}(?:\.\d+)?px|100%)$/.test(ruleValue)
    ) {
      safeRules.push(`${name}: ${ruleValue}`);
      continue;
    }

    if (name === 'height' && ruleValue === 'auto') {
      safeRules.push('height: auto');
    }
  }

  return safeRules.join('; ');
}

// ---------------------------------------------------------------------------
// Body sanitizer
//
// Bodies come from editors, AI drafts and scraped feeds and are rendered with
// `{@html}` — on public, prerendered pages too — so they go through a real
// HTML parser (sanitize-html / htmlparser2) with an allowlist, never through
// tag- or attribute-stripping regexes (nested input such as
// `<scr<script>ipt>` reassembles after a single regex pass). The parser
// re-serializes the tree: text and attribute values come out escaped, and no
// raw-text or foreign-content element (script, style, svg, math, iframe,
// noscript, template, textarea, …) is ever emitted, so the browser re-parses
// exactly the tree that was checked.
// ---------------------------------------------------------------------------

const INLINE_TAGS = [
  'a',
  'abbr',
  'b',
  'br',
  'code',
  'del',
  'em',
  'i',
  'img',
  'ins',
  'kbd',
  'mark',
  's',
  'small',
  'span',
  'strong',
  'sub',
  'sup',
  'u',
];

const BLOCK_CONTENT_TAGS = [
  'article',
  'aside',
  'blockquote',
  'caption',
  'col',
  'colgroup',
  'dd',
  'div',
  'dl',
  'dt',
  'figcaption',
  'figure',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'li',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'ul',
];

/** Editor layout markers kept on images and their figures. */
const IMAGE_MARKER_ATTRIBUTES = [
  'data-smrt-asset-id',
  'data-smrt-inline-image',
  'data-smrt-placement',
  'data-smrt-width',
  'data-smrt-thumbnail',
  'data-smrt-main',
];

const SANITIZER_ALLOWED_ATTRIBUTES: Record<string, string[]> = {
  a: ['href', 'title', 'rel', 'target'],
  abbr: ['title'],
  img: [
    'src',
    'srcset',
    'alt',
    'title',
    'width',
    'height',
    'loading',
    'style',
    ...IMAGE_MARKER_ATTRIBUTES,
  ],
  figure: ['style', ...IMAGE_MARKER_ATTRIBUTES],
  ol: ['start', 'reversed', 'type'],
  td: ['colspan', 'rowspan'],
  th: ['colspan', 'rowspan', 'scope'],
  col: ['span'],
  colgroup: ['span'],
};

/**
 * Disallowed elements whose content is dropped along with the tag (other
 * disallowed tags keep their text). Covers every raw-text / foreign-content
 * element where parser differentials (mXSS) live.
 */
const SANITIZER_DROP_CONTENT_TAGS = [
  'script',
  'style',
  'textarea',
  'option',
  'select',
  'noscript',
  'noembed',
  'noframes',
  'template',
  'title',
  'xmp',
  'plaintext',
  'iframe',
  'object',
  'embed',
  'svg',
  'math',
  'head',
];

const LINK_SCHEMES = new Set(['http', 'https', 'mailto', 'tel']);
const IMAGE_SCHEMES = new Set(['http', 'https']);
/**
 * Raster `data:` images stay allowed in image sources: the editor's upload
 * path can store an image asset whose source is a data URL. SVG (`image/svg+xml`)
 * and every other data type are refused.
 */
const SAFE_DATA_IMAGE_PATTERN = /^data:image\/(?:png|gif|jpe?g|webp|avif);/;
const IMAGE_PLACEMENTS = new Set(['block', 'left', 'right', 'center', 'full']);

/**
 * The URL when it is safe for a link (`http(s)`, `mailto`, `tel`, relative)
 * or an image (`http(s)`, raster `data:image/*`, relative); otherwise ''.
 * `value` is the parser-decoded attribute value — exactly what the browser
 * sees after the escaped re-serialization.
 */
function allowedUrl(value: string | undefined, kind: 'link' | 'image'): string {
  const url = (value || '').trim();
  if (!url) {
    return '';
  }

  let compact = '';
  for (const char of decodeBasicEntities(url)) {
    const code = char.charCodeAt(0);
    if (code <= 0x20 || code === 0x7f) {
      continue;
    }
    compact += char.toLowerCase();
  }

  const scheme = /^([a-z][a-z0-9+.-]*):/.exec(compact)?.[1];
  if (!scheme) {
    // Relative, root-relative, protocol-relative or fragment URL. A colon
    // before the first `/`, `?` or `#` would make it a scheme, so the regex
    // above already caught any `javascript:`-style value.
    return url;
  }

  if (kind === 'image') {
    if (IMAGE_SCHEMES.has(scheme)) {
      return url;
    }
    return scheme === 'data' && SAFE_DATA_IMAGE_PATTERN.test(compact)
      ? url
      : '';
  }

  return LINK_SCHEMES.has(scheme) ? url : '';
}

function allowedSrcset(value: string): string {
  return value
    .split(',')
    .map((candidate) => {
      const parts = candidate.trim().split(/\s+/);
      const url = allowedUrl(parts.shift(), 'image');
      if (!url || url.startsWith('data:')) {
        return '';
      }
      const descriptors = parts.filter((part) =>
        /^(?:\d+(?:\.\d+)?x|\d+w)$/.test(part),
      );
      return [url, ...descriptors].join(' ');
    })
    .filter(Boolean)
    .join(', ');
}

const POSITIVE_INTEGER = /^\d{1,5}$/;

/** Attributes whose empty value is meaningful (other empties are dropped). */
const EMPTY_VALUE_ATTRIBUTES = new Set([
  'alt',
  'data-smrt-inline-image',
  'data-smrt-thumbnail',
  'data-smrt-main',
]);

/**
 * Validate one allowed attribute's value. `null` — or '' outside
 * {@link EMPTY_VALUE_ATTRIBUTES} — drops the attribute.
 */
function allowedAttributeValue(name: string, value: string): string | null {
  switch (name) {
    case 'href':
      return allowedUrl(value, 'link');
    case 'src':
      return allowedUrl(value, 'image');
    case 'srcset':
      return allowedSrcset(value);
    case 'style':
      return sanitizeStyle(value);
    case 'width':
    case 'height':
    case 'start':
    case 'span':
    case 'colspan':
    case 'rowspan':
    case 'data-smrt-width':
      return POSITIVE_INTEGER.test(value.trim()) ? value.trim() : '';
    case 'loading':
      return value === 'lazy' || value === 'eager' ? value : '';
    case 'target':
      return value === '_blank' ? value : '';
    case 'rel':
      return value
        .split(/\s+/)
        .filter((token) => /^[a-z-]{1,32}$/i.test(token))
        .join(' ');
    case 'scope':
      return /^(?:row|col|rowgroup|colgroup)$/.test(value) ? value : '';
    case 'type':
      return /^[1aAiI]$/.test(value) ? value : '';
    case 'data-smrt-placement':
      return IMAGE_PLACEMENTS.has(value) ? value : '';
    case 'data-smrt-inline-image':
    case 'data-smrt-thumbnail':
    case 'data-smrt-main':
      // Boolean markers: keep the bare / `="true"` forms the editor writes.
      return value === '' || value === 'true' ? value : null;
    case 'data-smrt-asset-id':
      return /^[\w.:-]{1,128}$/.test(value) ? value : '';
    default:
      return value;
  }
}

interface SanitizeBodyOptions {
  /** Replace the thumbnail block image's `src` (already URL-checked). */
  thumbnailSrc?: string;
}

function transformBodyTag(
  tagName: string,
  attribs: Record<string, string>,
  options: SanitizeBodyOptions,
): { tagName: string; attribs: Record<string, string> } {
  const allowed = SANITIZER_ALLOWED_ATTRIBUTES[tagName] || [];
  const safe: Record<string, string> = {};

  for (const [rawName, rawValue] of Object.entries(attribs)) {
    const name = rawName.toLowerCase();
    if (!allowed.includes(name)) {
      continue;
    }
    const value = allowedAttributeValue(name, String(rawValue ?? ''));
    if (value === null) {
      continue;
    }
    if (value === '' && !EMPTY_VALUE_ATTRIBUTES.has(name)) {
      continue;
    }
    safe[name] = value;
  }

  if (
    tagName === 'img' &&
    options.thumbnailSrc &&
    BODY_THUMBNAIL_ATTRIBUTE in safe
  ) {
    safe.src = options.thumbnailSrc;
  }

  if (tagName === 'a' && safe.target === '_blank') {
    const rel = new Set((safe.rel || '').split(/\s+/).filter(Boolean));
    rel.add('noopener');
    rel.add('noreferrer');
    safe.rel = [...rel].join(' ');
  }

  return { tagName, attribs: safe };
}

function sanitizeBodyHtml(
  value: unknown,
  options: SanitizeBodyOptions = {},
): string {
  if (!value || typeof value !== 'string') {
    return '';
  }

  const html = sanitize(value, {
    allowedTags: [...INLINE_TAGS, ...BLOCK_CONTENT_TAGS],
    allowedAttributes: SANITIZER_ALLOWED_ATTRIBUTES,
    allowedClasses: {},
    allowedSchemes: [...LINK_SCHEMES],
    allowedSchemesByTag: { img: ['http', 'https', 'data'] },
    allowedSchemesAppliedToAttributes: ['href', 'src', 'cite'],
    allowProtocolRelative: true,
    // `style` values are rewritten by `sanitizeStyle` in the transform (a
    // width / max-width / `height: auto` allowlist), so the library's CSS
    // parser is not needed.
    parseStyleAttributes: false,
    disallowedTagsMode: 'discard',
    nonTextTags: SANITIZER_DROP_CONTENT_TAGS,
    transformTags: {
      '*': (tagName, attribs) =>
        transformBodyTag(tagName, attribs as Record<string, string>, options),
    },
    // An image whose source was refused is dropped rather than left broken.
    exclusiveFilter: (frame) => frame.tag === 'img' && !frame.attribs.src,
  });

  // sanitize-html serializes void elements XHTML-style (`<br />`). Emit the
  // HTML5 form the editor writes so bodies round-trip unchanged. Safe on the
  // serializer's output: `<` and `>` never appear raw inside text or
  // attribute values there, so this can only match a real tag.
  return html
    .replace(/<(img|br|hr|col)((?:\s+[^\s<>][^<>]*?)?)\s*\/>/g, '<$1$2>')
    .trim();
}

/**
 * Allowlist-sanitize body HTML for rendering with `{@html}`: headings,
 * paragraphs, lists, quotes, links (`http(s)`/`mailto`/`tel`/relative),
 * images (`http(s)`/relative/raster `data:`) with the editor's layout and
 * thumbnail markers, figures, tables, code, and inline emphasis. Everything
 * else — scripts, event handlers, `javascript:` URLs, iframes/embeds,
 * SVG/MathML, forms, classes, and all CSS except image width — is removed.
 */
export function sanitizeHtml(value: string): string {
  return sanitizeBodyHtml(value);
}

function renderInlineMarkdown(value: string): string {
  let html = value;

  // Markdown is HTML-escaped before inline rendering, so an image title's
  // quotes arrive as `&quot;`; accept both spellings.
  html = html.replace(
    /!\[([^\]]*)\]\(([^)\s]+)(?:\s+(?:"|&quot;)(.*?)(?:"|&quot;))?\)/g,
    (_match, alt: string, src: string, title = '') => {
      const safeSrc = sanitizeUrl(src);
      const safeAlt = escapeAttribute(decodeBasicEntities(alt));
      const decodedTitle = decodeBasicEntities(title);
      const thumbnailPlacement = parseMarkdownThumbnailTitle(decodedTitle);
      if (thumbnailPlacement) {
        return `<img src="${escapeAttribute(safeSrc)}" alt="${safeAlt}" ${BODY_THUMBNAIL_ATTRIBUTE}="true" data-smrt-inline-image="true" data-smrt-placement="${thumbnailPlacement}">`;
      }
      const titleAttr = decodedTitle
        ? ` title="${escapeAttribute(decodedTitle)}"`
        : '';
      return `<img src="${escapeAttribute(safeSrc)}" alt="${safeAlt}"${titleAttr}>`;
    },
  );
  html = html.replace(
    /\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g,
    (_match, label: string, href: string, title = '') => {
      const titleAttr = title
        ? ` title="${escapeAttribute(decodeBasicEntities(title))}"`
        : '';
      return `<a href="${escapeAttribute(sanitizeUrl(href))}"${titleAttr}>${label}</a>`;
    },
  );
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');

  return html;
}

export function renderMarkdownToHtml(markdown: string): string {
  if (!markdown || typeof markdown !== 'string') {
    return '';
  }

  const lines = escapeHtml(markdown).split('\n');
  const result: string[] = [];
  let inList = false;
  let inParagraph = false;

  function closeParagraph() {
    if (inParagraph) {
      result.push('</p>');
      inParagraph = false;
    }
  }

  function closeList() {
    if (inList) {
      result.push('</ul>');
      inList = false;
    }
  }

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed) {
      closeList();
      closeParagraph();
      continue;
    }

    const headingMatch = /^(#{1,3})\s+(.+)$/.exec(trimmed);
    if (headingMatch) {
      closeList();
      closeParagraph();
      const level = headingMatch[1].length;
      result.push(
        `<h${level}>${renderInlineMarkdown(headingMatch[2])}</h${level}>`,
      );
      continue;
    }

    const listMatch = /^[-*]\s+(.+)$/.exec(trimmed);
    if (listMatch) {
      closeParagraph();
      if (!inList) {
        result.push('<ul>');
        inList = true;
      }
      result.push(`<li>${renderInlineMarkdown(listMatch[1])}</li>`);
      continue;
    }

    closeList();
    if (!inParagraph) {
      result.push('<p>');
      inParagraph = true;
    } else {
      result.push('<br>');
    }
    result.push(renderInlineMarkdown(line));
  }

  closeList();
  closeParagraph();

  return sanitizeHtml(result.join('\n'));
}

function parseHtmlAttributes(value: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  value.replace(
    /([:\w-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g,
    (
      _match,
      name: string,
      _raw: string,
      doubleValue = '',
      singleValue = '',
      bareValue = '',
    ) => {
      attributes[name.toLowerCase()] = decodeBasicEntities(
        doubleValue || singleValue || bareValue || '',
      );
      return '';
    },
  );
  return attributes;
}

function normalizeImagePlacement(
  value: unknown,
): ContentBodyImagePlacement | undefined {
  return value === 'block' ||
    value === 'left' ||
    value === 'right' ||
    value === 'center' ||
    value === 'full'
    ? value
    : undefined;
}

function parseImageWidth(value: unknown): number | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return undefined;
  }

  const match = String(value).match(/(\d+(?:\.\d+)?)/);
  if (!match) {
    return undefined;
  }

  const width = Math.round(Number(match[1]));
  return Number.isFinite(width) && width > 0 ? width : undefined;
}

function parseStyleWidth(value: unknown): number | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const match = value.match(
    /(?:^|;)\s*(?:max-)?width\s*:\s*(\d+(?:\.\d+)?)px/i,
  );
  if (!match) {
    return undefined;
  }

  return parseImageWidth(match[1]);
}

function fallbackHtmlToMarkdown(html: string): string {
  let markdown = sanitizeHtml(html);

  markdown = markdown.replace(/<img\b([^>]*)>/gi, (_match, attrs: string) => {
    const parsed = parseHtmlAttributes(attrs);
    const src = sanitizeUrl(parsed.src || '');
    if (!src) {
      return '';
    }
    const thumbnailTitle = markdownThumbnailTitle(
      parsed[BODY_THUMBNAIL_ATTRIBUTE],
      parsed['data-smrt-placement'],
    );
    return `\n\n![${parsed.alt || ''}](${src}${thumbnailTitle})\n\n`;
  });
  markdown = markdown.replace(
    /<a\b([^>]*)>([\s\S]*?)<\/a>/gi,
    (_match, attrs: string, label: string) => {
      const parsed = parseHtmlAttributes(attrs);
      const href = sanitizeUrl(parsed.href || '');
      const text = stripHtml(label).trim() || href;
      return href ? `[${text}](${href})` : text;
    },
  );
  markdown = markdown.replace(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi, '\n\n# $1\n\n');
  markdown = markdown.replace(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi, '\n\n## $1\n\n');
  markdown = markdown.replace(
    /<h3\b[^>]*>([\s\S]*?)<\/h3>/gi,
    '\n\n### $1\n\n',
  );
  markdown = markdown.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, '\n- $1');
  markdown = markdown.replace(/<\/(?:p|div|section|article|ul|ol)>/gi, '\n\n');
  markdown = markdown.replace(/<br\s*\/?>/gi, '\n');
  markdown = markdown.replace(
    /<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi,
    '**$2**',
  );
  markdown = markdown.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, '*$2*');
  markdown = stripHtml(markdown);

  return normalizeMarkdownWhitespace(markdown);
}

export function stripHtml(value: string): string {
  return decodeBasicEntities(value.replace(/<[^>]*>/g, ''));
}

function normalizeMarkdownWhitespace(value: string): string {
  return decodeBasicEntities(value)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const MARKDOWN_TEXT_NODE = 3;
const MARKDOWN_ELEMENT_NODE = 1;

interface MarkdownDomNode {
  nodeType: number;
  textContent?: string | null;
  childNodes?: ArrayLike<MarkdownDomNode>;
  tagName?: string;
  getAttribute?: (name: string) => string | null;
}

function nodeToMarkdown(node: MarkdownDomNode): string {
  if (node.nodeType === MARKDOWN_TEXT_NODE) {
    return node.textContent || '';
  }

  if (node.nodeType !== MARKDOWN_ELEMENT_NODE) {
    return '';
  }

  const tag = node.tagName?.toLowerCase() || '';
  const children = Array.from(node.childNodes || [])
    .map(nodeToMarkdown)
    .join('');
  const trimmedChildren = children.trim();

  switch (tag) {
    case 'br':
      return '\n';
    case 'h1':
      return `\n\n# ${trimmedChildren}\n\n`;
    case 'h2':
      return `\n\n## ${trimmedChildren}\n\n`;
    case 'h3':
      return `\n\n### ${trimmedChildren}\n\n`;
    case 'p':
      return `\n\n${trimmedChildren}\n\n`;
    case 'strong':
    case 'b':
      return `**${trimmedChildren}**`;
    case 'em':
    case 'i':
      return `*${trimmedChildren}*`;
    case 'code':
      return `\`${trimmedChildren}\``;
    case 'a': {
      const href = sanitizeUrl(node.getAttribute?.('href') || '');
      return href ? `[${trimmedChildren || href}](${href})` : trimmedChildren;
    }
    case 'img': {
      const src = sanitizeUrl(node.getAttribute?.('src') || '');
      if (!src) {
        return '';
      }
      const alt = node.getAttribute?.('alt') || '';
      const thumbnailTitle = markdownThumbnailTitle(
        node.getAttribute?.(BODY_THUMBNAIL_ATTRIBUTE),
        node.getAttribute?.('data-smrt-placement'),
      );
      return `\n\n![${alt}](${src}${thumbnailTitle})\n\n`;
    }
    case 'li':
      return `- ${trimmedChildren}\n`;
    case 'ul':
    case 'ol':
      return `\n${children}\n`;
    default:
      return BLOCK_TAGS.includes(tag) ? `\n\n${trimmedChildren}\n\n` : children;
  }
}

export function htmlToMarkdown(html: string): string {
  const sanitized = sanitizeHtml(html);
  if (!sanitized) {
    return '';
  }

  const Parser = (globalThis as Record<string, unknown>).DOMParser;
  if (typeof Parser !== 'function') {
    return fallbackHtmlToMarkdown(sanitized);
  }

  // Structural view of the DOMParser API we rely on; avoids depending on the
  // DOM lib in this environment-agnostic module.
  const parser = new (
    Parser as new () => {
      parseFromString: (
        source: string,
        mimeType: string,
      ) => { body?: { childNodes?: ArrayLike<MarkdownDomNode> } | null };
    }
  )();
  const document = parser.parseFromString(
    `<body>${sanitized}</body>`,
    'text/html',
  );
  const markdown = Array.from(
    (document.body?.childNodes || []) as ArrayLike<MarkdownDomNode>,
  )
    .map(nodeToMarkdown)
    .join('');

  return normalizeMarkdownWhitespace(markdown);
}

export function normalizeEditorHtml(html: string): string {
  const sanitized = sanitizeHtml(html);
  if (!sanitized) {
    return '';
  }

  return sanitized.replace(
    /<p>\s*((?:<br\s*\/?>\s*)?<img\b[^>]*>(?:\s*<br\s*\/?>)?)\s*<\/p>/gi,
    (_match, imageHtml: string) =>
      imageHtml.replace(/^\s*<br\s*\/?>\s*|\s*<br\s*\/?>\s*$/gi, ''),
  );
}

export function bodyToEditorHtml(
  body: string,
  format: ContentBodyFormat,
): string {
  return format === 'markdown'
    ? normalizeEditorHtml(renderMarkdownToHtml(body || ''))
    : normalizeEditorHtml(body || '');
}

export function editorHtmlToBody(
  html: string,
  format: ContentBodyFormat,
): string {
  return format === 'markdown'
    ? htmlToMarkdown(html || '')
    : normalizeEditorHtml(html || '');
}

export function extractBodyImages(
  body: string,
  format: ContentBodyFormat = resolveBodyFormat(undefined, body),
): ContentBodyImage[] {
  if (!body || typeof body !== 'string') {
    return [];
  }

  if (format === 'markdown') {
    const images: ContentBodyImage[] = [];
    body.replace(
      /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g,
      (_match, alt: string, src: string, title = '') => {
        const safeSrc = sanitizeUrl(src);
        if (safeSrc) {
          const decodedTitle = decodeBasicEntities(title);
          const thumbnailPlacement = parseMarkdownThumbnailTitle(decodedTitle);
          images.push({
            src: safeSrc,
            alt: decodeBasicEntities(alt),
            ...(decodedTitle && !thumbnailPlacement
              ? { title: decodedTitle }
              : {}),
            ...(thumbnailPlacement
              ? { placement: thumbnailPlacement, thumbnail: true }
              : {}),
            index: images.length,
          });
        }
        return '';
      },
    );
    return images;
  }

  const images: ContentBodyImage[] = [];
  const bodyWithoutFigures = body.replace(
    /<figure\b([^>]*)>([\s\S]*?)<\/figure>/gi,
    (_match, figureAttrs: string, figureContent: string) => {
      const imageMatch = /<img\b([^>]*)>/i.exec(figureContent);
      if (!imageMatch) {
        return '';
      }

      const parsedFigure = parseHtmlAttributes(figureAttrs);
      const parsedImage = parseHtmlAttributes(imageMatch[1] || '');
      const src = sanitizeUrl(parsedImage.src || '');
      if (src) {
        const placement = normalizeImagePlacement(
          parsedFigure['data-smrt-placement'] ||
            parsedImage['data-smrt-placement'],
        );
        const width =
          parseImageWidth(
            parsedFigure['data-smrt-width'] || parsedImage['data-smrt-width'],
          ) ||
          parseStyleWidth(parsedFigure.style) ||
          parseStyleWidth(parsedImage.style);
        images.push({
          src,
          alt: parsedImage.alt || '',
          ...(parsedImage.title ? { title: parsedImage.title } : {}),
          ...(parsedImage['data-smrt-asset-id']
            ? { assetId: parsedImage['data-smrt-asset-id'] }
            : {}),
          ...(placement ? { placement } : {}),
          ...(width ? { width } : {}),
          ...(isThumbnailMarker(
            parsedFigure[BODY_THUMBNAIL_ATTRIBUTE] ||
              parsedImage[BODY_THUMBNAIL_ATTRIBUTE],
          )
            ? { thumbnail: true }
            : {}),
          ...(isThumbnailMarker(
            parsedFigure[BODY_MAIN_IMAGE_ATTRIBUTE] ||
              parsedImage[BODY_MAIN_IMAGE_ATTRIBUTE],
          )
            ? { main: true }
            : {}),
          index: images.length,
        });
      }

      return '';
    },
  );

  bodyWithoutFigures.replace(/<img\b([^>]*)>/gi, (_match, attrs: string) => {
    const parsed = parseHtmlAttributes(attrs);
    const src = sanitizeUrl(parsed.src || '');
    if (src) {
      const placement = normalizeImagePlacement(parsed['data-smrt-placement']);
      const width =
        parseImageWidth(parsed['data-smrt-width']) ||
        parseStyleWidth(parsed.style);
      images.push({
        src,
        alt: parsed.alt || '',
        ...(parsed.title ? { title: parsed.title } : {}),
        ...(parsed['data-smrt-asset-id']
          ? { assetId: parsed['data-smrt-asset-id'] }
          : {}),
        ...(placement ? { placement } : {}),
        ...(width ? { width } : {}),
        ...(isThumbnailMarker(parsed[BODY_THUMBNAIL_ATTRIBUTE])
          ? { thumbnail: true }
          : {}),
        ...(isThumbnailMarker(parsed[BODY_MAIN_IMAGE_ATTRIBUTE])
          ? { main: true }
          : {}),
        index: images.length,
      });
    }
    return '';
  });

  return images;
}

/**
 * Structural view of the asset-like inputs accepted by the image helpers.
 * Callers pass assorted asset shapes (Asset models, plain DTOs, etc.); only
 * these optional fields are read.
 */
export interface ImageAssetLike {
  id?: unknown;
  sourceUri?: unknown;
  url?: unknown;
  src?: unknown;
  alt?: unknown;
  name?: unknown;
  title?: unknown;
  width?: unknown;
}

export function getImageSource(
  asset: ImageAssetLike | null | undefined,
): string {
  return String(asset?.sourceUri || asset?.url || asset?.src || '');
}

export function getImageAlt(asset: ImageAssetLike | null | undefined): string {
  return String(asset?.alt || asset?.name || asset?.title || 'Image');
}

export function imageAssetToHtml(
  asset: ImageAssetLike | null | undefined,
): string {
  const src = sanitizeUrl(getImageSource(asset));
  if (!src) {
    return '';
  }

  const assetId = asset?.id
    ? ` data-smrt-asset-id="${escapeAttribute(String(asset.id))}"`
    : '';
  const width = Math.max(
    160,
    Math.min(520, Math.round(Number(asset?.width) || 520)),
  );

  return `<img src="${escapeAttribute(src)}" alt="${escapeAttribute(getImageAlt(asset))}"${assetId} data-smrt-inline-image="true" data-smrt-placement="block" data-smrt-width="${width}" style="width: ${width}px; max-width: 100%; height: auto">`;
}

// ---------------------------------------------------------------------------
// Thumbnail block
//
// When content gets a thumbnail (featured image) it is also shown in the body
// at a standard spot chosen from its shape: a wide picture becomes a
// full-width header image at the top; a portrait or square one floats at the
// top right of the first paragraph so the text wraps beside it (renderers
// stack it full width on phones). The block carries a stable marker so it is
// replaced — never duplicated — when the thumbnail changes, and removed when
// the thumbnail is cleared. HTML bodies mark the `<img>` with
// `data-smrt-thumbnail="true"`; Markdown bodies use the image title
// `smrt-thumbnail:<placement>`, which the Markdown renderer turns back into
// the same marked `<img>`.
// ---------------------------------------------------------------------------

/** Where the thumbnail block sits: header (`full`) or floated `right`. */
export type ContentBodyThumbnailPlacement = 'full' | 'right';

/** Width ÷ height at or above which a thumbnail counts as wide (a header). */
export const THUMBNAIL_WIDE_ASPECT_RATIO = 1.3;

/** Attribute that marks the thumbnail block's `<img>` in HTML bodies. */
export const BODY_THUMBNAIL_ATTRIBUTE = 'data-smrt-thumbnail';

/**
 * Attribute that marks a picture already in the story as the one the person
 * chose as the main picture (HTML bodies). It travels with the picture, so a
 * choice sticks when pictures are moved or reordered.
 */
export const BODY_MAIN_IMAGE_ATTRIBUTE = 'data-smrt-main';

const MARKDOWN_THUMBNAIL_TITLE_PREFIX = 'smrt-thumbnail:';

export interface ContentBodyThumbnail {
  /** Image URL written into the body. */
  src: string;
  /** Alternative text (default: empty — the article title usually says it). */
  alt?: string | null;
  /** Asset id, kept on the HTML `<img>` as `data-smrt-asset-id`. */
  assetId?: string | null;
  /** Natural width in pixels, used with `height` to choose the placement. */
  width?: number | null;
  /** Natural height in pixels. */
  height?: number | null;
  /** Force a placement instead of deriving it from `width`/`height`. */
  placement?: ContentBodyThumbnailPlacement;
}

/**
 * The standard thumbnail placement for an image of this size: wide
 * (ratio ≥ {@link THUMBNAIL_WIDE_ASPECT_RATIO}) → `full` header; portrait or
 * square → `right`. Unknown sizes default to `full`.
 */
export function thumbnailPlacementForSize(
  width: unknown,
  height: unknown,
): ContentBodyThumbnailPlacement {
  const w = Number(width);
  const h = Number(height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    return 'full';
  }
  return w / h >= THUMBNAIL_WIDE_ASPECT_RATIO ? 'full' : 'right';
}

function isThumbnailMarker(value: unknown): boolean {
  return value === 'true' || value === '' || value === true;
}

function parseMarkdownThumbnailTitle(
  title: string,
): ContentBodyThumbnailPlacement | undefined {
  if (!title.startsWith(MARKDOWN_THUMBNAIL_TITLE_PREFIX)) {
    return undefined;
  }
  const placement = title.slice(MARKDOWN_THUMBNAIL_TITLE_PREFIX.length);
  return placement === 'full' || placement === 'right' ? placement : undefined;
}

function markdownThumbnailTitle(
  marker: string | null | undefined,
  placement: string | null | undefined,
): string {
  if (marker !== 'true' && marker !== '') {
    return '';
  }
  const resolved: ContentBodyThumbnailPlacement =
    placement === 'right' ? 'right' : 'full';
  return ` "${MARKDOWN_THUMBNAIL_TITLE_PREFIX}${resolved}"`;
}

const HTML_THUMBNAIL_FIGURE_PATTERN =
  /\s*<figure\b[^>]*>(?:(?!<\/figure>)[\s\S])*?<img\b[^>]*\bdata-smrt-thumbnail\s*=[^>]*>[\s\S]*?<\/figure>\s*/gi;
const HTML_THUMBNAIL_MARKED_FIGURE_PATTERN =
  /\s*<figure\b[^>]*\bdata-smrt-thumbnail\s*=[^>]*>[\s\S]*?<\/figure>\s*/gi;
const HTML_THUMBNAIL_PARAGRAPH_PATTERN =
  /\s*<p\b[^>]*>\s*(?:<br\s*\/?>\s*)?<img\b[^>]*\bdata-smrt-thumbnail\s*=[^>]*>\s*(?:<br\s*\/?>\s*)?<\/p>\s*/gi;
const HTML_THUMBNAIL_IMAGE_PATTERN =
  /\s*<img\b[^>]*\bdata-smrt-thumbnail\s*=[^>]*>\s*/gi;
const MARKDOWN_THUMBNAIL_LINE_PATTERN =
  /^[ \t]*!\[[^\]]*\]\([^)\s]+\s+"smrt-thumbnail:(?:full|right)"\)[ \t]*(?:\n|$)/gm;

/** True when the body already contains a thumbnail block. */
export function bodyHasThumbnail(
  body: string | null | undefined,
  format?: ContentBodyFormat | null,
): boolean {
  if (!body) {
    return false;
  }
  return extractBodyImages(body, resolveBodyFormat(format, body)).some(
    (image) => image.thumbnail,
  );
}

/** The body without its thumbnail block (unchanged when it has none). */
export function removeThumbnailFromBody(
  body: string | null | undefined,
  format?: ContentBodyFormat | null,
): string {
  const source = body || '';
  if (!source) {
    return '';
  }
  const resolved = resolveBodyFormat(format, source);
  if (resolved === 'markdown') {
    if (!source.match(MARKDOWN_THUMBNAIL_LINE_PATTERN)) {
      return source;
    }
    return source
      .replace(MARKDOWN_THUMBNAIL_LINE_PATTERN, '')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/^\n+/, '');
  }

  const stripped = source
    .replace(HTML_THUMBNAIL_MARKED_FIGURE_PATTERN, '\n')
    .replace(HTML_THUMBNAIL_FIGURE_PATTERN, '\n')
    .replace(HTML_THUMBNAIL_PARAGRAPH_PATTERN, '\n')
    .replace(HTML_THUMBNAIL_IMAGE_PATTERN, '\n');
  return stripped === source ? source : stripped.trim();
}

function thumbnailHtml(
  thumbnail: ContentBodyThumbnail,
  placement: ContentBodyThumbnailPlacement,
): string {
  const src = sanitizeUrl(thumbnail.src || '');
  if (!src) {
    return '';
  }
  const assetId = thumbnail.assetId
    ? ` data-smrt-asset-id="${escapeAttribute(String(thumbnail.assetId))}"`
    : '';
  return `<img src="${escapeAttribute(src)}" alt="${escapeAttribute(String(thumbnail.alt || ''))}"${assetId} ${BODY_THUMBNAIL_ATTRIBUTE}="true" data-smrt-inline-image="true" data-smrt-placement="${placement}">`;
}

function thumbnailMarkdown(
  thumbnail: ContentBodyThumbnail,
  placement: ContentBodyThumbnailPlacement,
): string {
  const src = sanitizeUrl(thumbnail.src || '');
  if (!src || /\s/.test(src)) {
    return '';
  }
  const alt = String(thumbnail.alt || '').replace(/[[\]\n]/g, ' ');
  return `![${alt}](${src} "${MARKDOWN_THUMBNAIL_TITLE_PREFIX}${placement}")`;
}

/** Index of the first Markdown paragraph (not a heading, list or image). */
function firstMarkdownParagraphOffset(markdown: string): number {
  const blockPattern = /(^|\n\n)([^\n][\s\S]*?)(?=\n\n|$)/g;
  for (const match of markdown.matchAll(blockPattern)) {
    const block = match[2] || '';
    const trimmed = block.trimStart();
    if (!trimmed || /^(?:#{1,6}\s|[-*]\s|!\[|>)/.test(trimmed)) {
      continue;
    }
    return (match.index ?? 0) + (match[1] || '').length;
  }
  return -1;
}

/**
 * Put `thumbnail` into `body` at its standard spot, replacing any previous
 * thumbnail block: `full` goes first in the body; `right` goes immediately
 * before the first paragraph, floated so that paragraph wraps beside it.
 * The placement comes from `thumbnail.placement` or its width/height
 * ({@link thumbnailPlacementForSize}). Returns the body unchanged (minus any
 * old block) when the image has no usable `src`.
 */
export function placeThumbnailInBody(
  body: string | null | undefined,
  format: ContentBodyFormat | null | undefined,
  thumbnail: ContentBodyThumbnail,
): string {
  const source = body || '';
  const resolved = resolveBodyFormat(format, source);
  const withoutOld = removeThumbnailFromBody(source, resolved);
  const placement =
    thumbnail.placement ??
    thumbnailPlacementForSize(thumbnail.width, thumbnail.height);

  if (resolved === 'markdown') {
    const block = thumbnailMarkdown(thumbnail, placement);
    if (!block) {
      return withoutOld;
    }
    const trimmed = withoutOld.replace(/^\n+/, '');
    if (!trimmed) {
      return block;
    }
    const offset =
      placement === 'right' ? firstMarkdownParagraphOffset(trimmed) : 0;
    const at = offset < 0 ? 0 : offset;
    return `${trimmed.slice(0, at)}${block}\n\n${trimmed.slice(at)}`;
  }

  const block = thumbnailHtml(thumbnail, placement);
  if (!block) {
    return withoutOld;
  }
  const trimmed = withoutOld.trim();
  if (!trimmed) {
    return block;
  }
  let at = 0;
  if (placement === 'right') {
    const paragraph = /<p\b/i.exec(trimmed);
    at = paragraph ? paragraph.index : 0;
  }
  return `${trimmed.slice(0, at)}${block}\n${trimmed.slice(at)}`;
}

export interface RenderContentBodyOptions {
  /**
   * Replace the thumbnail block's image URL — for renderers (e.g. a public
   * site) that serve assets from a different origin than the editor that
   * wrote the body.
   */
  thumbnailSrc?: string | null;
}

/**
 * Sanitized HTML for a stored body in either format — what a public page
 * renders. Markdown thumbnail blocks come out as the same marked `<img>` as
 * HTML ones, so one stylesheet handles both.
 */
export function renderContentBodyHtml(
  body: string | null | undefined,
  format?: ContentBodyFormat | null,
  options: RenderContentBodyOptions = {},
): string {
  const source = body || '';
  if (!source) {
    return '';
  }
  const resolved = resolveBodyFormat(format, source);
  const replacement = allowedUrl(options.thumbnailSrc || '', 'image');
  // The thumbnail swap happens on the parsed attribute inside the sanitizer,
  // never by pattern-matching the serialized HTML (an `alt` text containing
  // `src=` could otherwise be rewritten into a new attribute).
  return sanitizeBodyHtml(
    resolved === 'markdown' ? renderMarkdownToHtml(source) : source,
    replacement ? { thumbnailSrc: replacement } : {},
  );
}

// ---------------------------------------------------------------------------
// Main picture
//
// The first picture in the story is the main picture (the thumbnail) unless
// the person chose one: either a picture in the story marked with
// `data-smrt-main="true"` (`setBodyMainImage`), or a thumbnail block placed
// for a picture that is not otherwise in the story (`placeThumbnailInBody`).
// A choice sticks until it is cleared, whatever order the pictures are in.
// Only pictures with an asset id count; Markdown bodies carry no asset ids,
// so they resolve to `none`.
// ---------------------------------------------------------------------------

/** How the main picture was decided. */
export type ContentMainPictureMode = 'chosen' | 'automatic' | 'none';

export interface ContentMainPicture {
  /** The main picture's asset id, or null when there is none. */
  assetId: string | null;
  /**
   * `chosen`: the person picked it. `automatic`: the first picture in the
   * story. `none`: the story has no pictures with an asset id, so the
   * current value (passed in) is kept as it is.
   */
  mode: ContentMainPictureMode;
}

/**
 * The content's main picture according to its body: the chosen picture when
 * there is one, otherwise the first picture in the story. Returns `none`
 * with `currentAssetId` when the story has no pictures with asset ids, so
 * a caller never clears a thumbnail set some other way.
 */
export function resolveBodyMainPicture(
  body: string | null | undefined,
  format?: ContentBodyFormat | null,
  currentAssetId: string | null = null,
): ContentMainPicture {
  const source = body || '';
  const images = source
    ? extractBodyImages(source, resolveBodyFormat(format, source)).filter(
        (image) => Boolean(image.assetId),
      )
    : [];
  const chosen =
    images.find((image) => image.thumbnail) ??
    images.find((image) => image.main);
  if (chosen?.assetId) {
    return { assetId: chosen.assetId, mode: 'chosen' };
  }
  if (images[0]?.assetId) {
    return { assetId: images[0].assetId, mode: 'automatic' };
  }
  return { assetId: currentAssetId, mode: 'none' };
}

const MAIN_IMAGE_ATTRIBUTE_PATTERN =
  /\s+data-smrt-main(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?/gi;

function withoutMainMarker(tag: string): string {
  return tag.replace(MAIN_IMAGE_ATTRIBUTE_PATTERN, '');
}

/**
 * Mark the first picture in the story with `assetId` as the chosen main
 * picture, clearing the mark from every other picture. `null` clears the
 * choice, so the first picture is the main picture again. HTML bodies only;
 * a Markdown body, or one without that picture, is returned with only the
 * old marks cleared.
 */
export function setBodyMainImage(
  body: string | null | undefined,
  format: ContentBodyFormat | null | undefined,
  assetId: string | null,
): string {
  const source = body || '';
  if (!source || resolveBodyFormat(format, source) !== 'html') {
    return source;
  }
  const cleared = source.replace(/<(img|figure)\b[^>]*>/gi, withoutMainMarker);
  if (!assetId) {
    return cleared;
  }
  let marked = false;
  return cleared.replace(
    /<img\b([^>]*?)(\s*\/?)>/gi,
    (tag, attrs: string, end: string) => {
      if (marked) {
        return tag;
      }
      const parsed = parseHtmlAttributes(attrs);
      if (
        parsed['data-smrt-asset-id'] !== assetId ||
        isThumbnailMarker(parsed[BODY_THUMBNAIL_ATTRIBUTE])
      ) {
        return tag;
      }
      marked = true;
      return `<img${attrs} ${BODY_MAIN_IMAGE_ATTRIBUTE}="true"${end}>`;
    },
  );
}

/** True when the story contains the picture with this asset id (not the thumbnail block). */
export function bodyHasImage(
  body: string | null | undefined,
  format: ContentBodyFormat | null | undefined,
  assetId: string,
): boolean {
  const source = body || '';
  if (!source || !assetId) {
    return false;
  }
  return extractBodyImages(source, resolveBodyFormat(format, source)).some(
    (image) => !image.thumbnail && image.assetId === assetId,
  );
}
