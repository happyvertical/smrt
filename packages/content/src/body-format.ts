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
  index: number;
}

export const DEFAULT_CONTENT_BODY_FORMAT: ContentBodyFormat = 'html';

const HTML_TAG_PATTERN =
  /<\/?(?:article|aside|blockquote|br|div|figure|figcaption|h[1-6]|hr|img|li|ol|p|pre|section|span|strong|em|b|i|u|a|ul|table|tbody|td|th|thead|tr)(?:\s[^>]*)?>/i;
// HTML attribute boundary: the HTML5 tree builder starts a new attribute after
// whitespace, `/`, OR the closing quote/backtick of the previous value. A naive
// `\s+`-only boundary lets `src="x"onerror="..."` survive sanitization because
// `onerror` is glued to the preceding `"` — the browser still parses it as a
// separate (executing) attribute. Match either runs of whitespace/`/`
// (captured in group 1 and consumed) OR a non-consuming lookbehind for a
// quote/backtick (group 1 undefined; the char is the previous value's own
// closing delimiter and must stay). `reemitSeparator()` turns the captured
// group back into a single separating space when one was consumed (S5 #1388).
const ATTR_BOUNDARY = '(?:([\\s/]+)|(?<=["\'`]))';

// Re-emit an attribute separator after a removed/rewritten attribute. When the
// boundary consumed whitespace/`/` (group 1 present), emit one space so the
// rebuilt attribute doesn't glue onto the tag name or previous attribute. When
// the boundary was a non-consumed quote/backtick (group 1 undefined), that
// delimiter already separates the attributes, so emit nothing.
function reemitSeparator(consumed: string | undefined): string {
  return consumed ? ' ' : '';
}

const URL_ATTRIBUTE_PATTERN = new RegExp(
  `${ATTR_BOUNDARY}(href|src|xlink:href|formaction|action|poster)\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`,
  'gi',
);
const SRCSET_ATTRIBUTE_PATTERN = new RegExp(
  `${ATTR_BOUNDARY}srcset\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`,
  'gi',
);

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

function sanitizeSrcset(value: string): string {
  return decodeBasicEntities(value)
    .split(',')
    .map((candidate) => {
      const parts = candidate.trim().split(/\s+/);
      const url = sanitizeUrl(parts.shift() || '');
      if (!url || url === '#') {
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

export function sanitizeHtml(value: string): string {
  if (!value || typeof value !== 'string') {
    return '';
  }

  let html = value;
  html = html.replace(/<!--[\s\S]*?-->/g, '');
  // This lightweight sanitizer intentionally removes SVG/MathML instead of
  // attempting namespace-aware SVG/MathML sanitization. Consumers needing rich
  // inline diagrams should run a dedicated sanitizer before storing content.
  html = html.replace(
    /<\s*(script|style|iframe|object|embed|link|meta|base|svg|math)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi,
    '',
  );
  html = html.replace(
    /<\s*(script|style|iframe|object|embed|link|meta|base|svg|math)\b[^>]*\/?>/gi,
    '',
  );
  // Drop event handlers (`onclick`, etc.) and internal editor markers entirely.
  // A consumed whitespace/`/` separator and a non-consumed quote boundary both
  // collapse to nothing: the attribute that follows (if any) keeps its own
  // leading boundary, so removal never needs to leave a separator behind.
  html = html.replace(
    new RegExp(
      `${ATTR_BOUNDARY}on[a-z]+\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s>]*)`,
      'gi',
    ),
    '',
  );
  html = html.replace(
    new RegExp(
      `${ATTR_BOUNDARY}data-smrt-(?:selected|moving|resizing)\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s>]*)`,
      'gi',
    ),
    '',
  );
  html = html.replace(
    new RegExp(
      `${ATTR_BOUNDARY}style\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`,
      'gi',
    ),
    (
      _match,
      separator: string | undefined,
      _raw: string,
      doubleValue = '',
      singleValue = '',
      bareValue = '',
    ) => {
      const safeStyle = sanitizeStyle(doubleValue || singleValue || bareValue);
      const sep = reemitSeparator(separator);
      return safeStyle ? `${sep}style="${escapeAttribute(safeStyle)}"` : sep;
    },
  );
  html = html.replace(
    SRCSET_ATTRIBUTE_PATTERN,
    (
      _match,
      separator: string | undefined,
      _raw: string,
      doubleValue = '',
      singleValue = '',
      bareValue = '',
    ) => {
      const safeSrcset = sanitizeSrcset(
        doubleValue || singleValue || bareValue,
      );
      const sep = reemitSeparator(separator);
      return safeSrcset ? `${sep}srcset="${escapeAttribute(safeSrcset)}"` : sep;
    },
  );
  html = html.replace(
    URL_ATTRIBUTE_PATTERN,
    (
      _match,
      separator: string | undefined,
      name: string,
      _raw: string,
      doubleValue = '',
      singleValue = '',
      bareValue = '',
    ) => {
      const quote = doubleValue ? '"' : singleValue ? "'" : '"';
      const rawValue = doubleValue || singleValue || bareValue;
      return `${reemitSeparator(separator)}${name}=${quote}${escapeAttribute(sanitizeUrl(rawValue))}${quote}`;
    },
  );

  return html.trim();
}

function renderInlineMarkdown(value: string): string {
  let html = value;

  html = html.replace(
    /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g,
    (_match, alt: string, src: string, title = '') => {
      const safeSrc = sanitizeUrl(src);
      const safeAlt = escapeAttribute(decodeBasicEntities(alt));
      const titleAttr = title
        ? ` title="${escapeAttribute(decodeBasicEntities(title))}"`
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
    return `\n\n![${parsed.alt || ''}](${src})\n\n`;
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
      return `\n\n![${alt}](${src})\n\n`;
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
  const parser = new (Parser as new () => {
    parseFromString: (
      source: string,
      mimeType: string,
    ) => { body?: { childNodes?: ArrayLike<MarkdownDomNode> } | null };
  })();
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
          images.push({
            src: safeSrc,
            alt: decodeBasicEntities(alt),
            ...(title ? { title: decodeBasicEntities(title) } : {}),
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

export function getImageSource(asset: ImageAssetLike | null | undefined): string {
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
