import { XMLParser } from 'fast-xml-parser';

export type ContentFeedFormat = 'rss' | 'atom';

export interface ParsedContentFeedItem {
  title: string;
  url: string;
  guid: string | null;
  author: string | null;
  publishedAt: Date | null;
  updatedAt: Date | null;
  summary: string | null;
  categories: string[];
}

export interface ParsedContentFeed {
  format: ContentFeedFormat;
  title: string | null;
  homepageUrl: string | null;
  items: ParsedContentFeedItem[];
}

function asArray<T>(value: T | T[] | null | undefined): T[] {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function textFromNode(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number') {
    return String(value).trim();
  }
  if (typeof value !== 'object') return '';

  const record = value as Record<string, unknown>;
  return String(record['#text'] ?? record.__cdata ?? record.href ?? '').trim();
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    const text = textFromNode(value);
    if (text) return text;
  }
  return '';
}

function parseDate(value: unknown): Date | null {
  const text = textFromNode(value);
  if (!text) return null;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function stripHtml(value: string): string {
  return value
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function excerpt(value: unknown): string | null {
  const text = stripHtml(textFromNode(value));
  if (!text) return null;
  return text.length > 500 ? `${text.slice(0, 497).trim()}...` : text;
}

function parseCategories(value: unknown): string[] {
  return Array.from(
    new Set(
      asArray(value)
        .map((entry) => {
          if (entry && typeof entry === 'object') {
            return firstText(entry, (entry as Record<string, unknown>).term);
          }
          return textFromNode(entry);
        })
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  );
}

function parseAuthor(value: unknown): string | null {
  if (Array.isArray(value)) return parseAuthor(value[0]);
  if (value && typeof value === 'object') {
    return firstText((value as Record<string, unknown>).name, value) || null;
  }
  return textFromNode(value) || null;
}

function resolveUrl(value: string, baseUrl?: string | null): string {
  if (!value) return '';
  if (!baseUrl) return value;

  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return value;
  }
}

function parseRssLink(value: unknown, baseUrl?: string | null): string {
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return resolveUrl(
      firstText(record.href, record['#text'], record.__cdata),
      baseUrl,
    );
  }
  return resolveUrl(textFromNode(value), baseUrl);
}

function parseAtomLink(value: unknown, baseUrl?: string | null): string {
  const links = asArray(value);
  const alternate =
    links.find((entry) => {
      if (!entry || typeof entry !== 'object') return false;
      return (
        String((entry as Record<string, unknown>).rel ?? 'alternate') ===
        'alternate'
      );
    }) ?? links[0];

  if (alternate && typeof alternate === 'object') {
    return resolveUrl(
      firstText((alternate as Record<string, unknown>).href, alternate),
      baseUrl,
    );
  }
  return resolveUrl(textFromNode(alternate), baseUrl);
}

function dedupeItems(items: ParsedContentFeedItem[]): ParsedContentFeedItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = item.guid || item.url;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function parseContentFeed(
  xml: string,
  baseUrl?: string | null,
): ParsedContentFeed {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    cdataPropName: '__cdata',
    textNodeName: '#text',
    removeNSPrefix: true,
    trimValues: true,
  });
  // Parsed XML is an untyped node tree; every field is read through the
  // unknown-tolerant helpers above, so a loose record shape is sufficient.
  type FeedNode = Record<string, unknown>;
  const doc = parser.parse(xml) as {
    rss?: { channel?: FeedNode };
    channel?: FeedNode;
    feed?: FeedNode;
  };

  if (doc.rss?.channel || doc.channel) {
    const channel = (doc.rss?.channel ?? doc.channel) as FeedNode;
    return {
      format: 'rss',
      title: firstText(channel.title) || null,
      homepageUrl: parseRssLink(channel.link, baseUrl) || null,
      items: dedupeItems(
        asArray<FeedNode>(channel.item as FeedNode | FeedNode[] | undefined)
          .map(
            (item): ParsedContentFeedItem => ({
              title: firstText(item.title),
              url:
                parseRssLink(item.link, baseUrl) ||
                resolveUrl(firstText(item.guid), baseUrl),
              guid: firstText(item.guid, item.id) || null,
              author: parseAuthor(item.author ?? item.creator),
              publishedAt: parseDate(
                item.pubDate ?? item.published ?? item.date,
              ),
              updatedAt: parseDate(item.updated),
              summary: excerpt(
                item.description ?? item.summary ?? item.content,
              ),
              categories: parseCategories(item.category),
            }),
          )
          .filter((item) => item.title && item.url),
      ),
    };
  }

  if (doc.feed) {
    const feed = doc.feed;
    return {
      format: 'atom',
      title: firstText(feed.title) || null,
      homepageUrl: parseAtomLink(feed.link, baseUrl) || null,
      items: dedupeItems(
        asArray<FeedNode>(feed.entry as FeedNode | FeedNode[] | undefined)
          .map(
            (entry): ParsedContentFeedItem => ({
              title: firstText(entry.title),
              url: parseAtomLink(entry.link, baseUrl),
              guid: firstText(entry.id) || null,
              author: parseAuthor(entry.author),
              publishedAt: parseDate(entry.published ?? entry.updated),
              updatedAt: parseDate(entry.updated),
              summary: excerpt(entry.summary ?? entry.content),
              categories: parseCategories(entry.category),
            }),
          )
          .filter((item) => item.title && item.url),
      ),
    };
  }

  throw new Error('Unsupported feed format');
}
