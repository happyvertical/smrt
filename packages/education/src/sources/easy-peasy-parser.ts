/** A pointer-only representation of an Easy Peasy lesson. */
export interface ParsedSourceLesson {
  day: number;
  title: string;
  externalRef: string;
  externalUrl: string;
  worksheet: boolean;
  printableUrl?: string;
}

export interface ParsedSourceCourse {
  title: string;
  lessons: ParsedSourceLesson[];
  packetUrl?: string;
}

const approvedHosts = new Set([
  'allinonehomeschool.com',
  'www.allinonehomeschool.com',
]);

/**
 * Resolve and constrain source URLs before either fetching or retaining them.
 * Easy Peasy links must remain HTTPS links to the source site; imported data
 * must never become an open redirect or a pointer to a third-party PDF.
 */
export function validateEasyPeasyUrl(value: string, baseUrl?: string): string {
  let url: URL;
  try {
    url = new URL(value, baseUrl);
  } catch {
    throw new Error('Easy Peasy URL is invalid.');
  }
  if (url.protocol !== 'https:' || url.port || !approvedHosts.has(url.hostname))
    throw new Error('Easy Peasy URL must use an approved HTTPS source host.');
  if (url.username || url.password)
    throw new Error('Easy Peasy URL must not include credentials.');
  return url.toString();
}

interface HeadingMatch {
  index: number;
  end: number;
  text: string;
  /** The official daily container is authoritative even when it lacks a heading. */
  day?: number;
  fragment?: string;
  title?: string;
  containerEnd?: number;
}

interface LinkMatch {
  href: string;
  text: string;
}

function decodeHtml(value: string): string {
  return value.replace(
    /&(#x[\da-f]+|#\d+|amp|apos|gt|lt|nbsp|quot);/gi,
    (entity) => {
      const named: Record<string, string> = {
        '&amp;': '&',
        '&apos;': "'",
        '&gt;': '>',
        '&lt;': '<',
        '&nbsp;': ' ',
        '&quot;': '"',
      };
      const lower = entity.toLowerCase();
      if (lower in named) return named[lower];
      const number = lower.startsWith('&#x')
        ? Number.parseInt(lower.slice(3, -1), 16)
        : Number.parseInt(lower.slice(2, -1), 10);
      return Number.isSafeInteger(number) && number <= 0x10ffff
        ? String.fromCodePoint(number)
        : entity;
    },
  );
}

function textContent(value: string): string {
  return decodeHtml(value.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function attribute(attributes: string, name: string): string | undefined {
  const match = new RegExp(
    `(?:^|[\\t\\n\\f\\r ])${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
    'i',
  ).exec(attributes);
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

function lessonHeadings(html: string): HeadingMatch[] {
  const containers: HeadingMatch[] = [];
  const divs = /<div\b([^>]*)>/gi;
  for (const match of html.matchAll(divs)) {
    const id = attribute(match[1], 'id');
    const marker = /^(day|week)(\d+)$/i.exec(id ?? '');
    if (!marker) continue;
    const number = Number.parseInt(marker[2], 10);
    if (!Number.isSafeInteger(number) || number < 1)
      throw new Error(`Easy Peasy daily container is malformed: ${id}`);
    const weekly = marker[1].toLowerCase() === 'week';
    const index = match.index ?? 0;
    const end = index + match[0].length;
    const closing = /<\/div\s*>/i.exec(html.slice(end));
    containers.push({
      index,
      end,
      text: weekly ? `Week ${number}` : `Lesson ${number}`,
      day: number,
      fragment: `${weekly ? 'week' : 'day'}${number}`,
      ...(weekly ? { title: `Week ${number}` } : {}),
      containerEnd: closing
        ? end + (closing.index ?? 0) + closing[0].length
        : end,
    });
  }
  containers.sort((left, right) => left.index - right.index);
  const isInDailyContainer = (index: number): boolean =>
    containers.some(
      (container) =>
        container.index <= index &&
        index < (container.containerEnd ?? container.end),
    );

  const matches: HeadingMatch[] = [...containers];
  const weeks = /<(?:strong|b)\b([^>]*)>([\s\S]*?)<\/(?:strong|b)\s*>/gi;
  for (const match of html.matchAll(weeks)) {
    if (isInDailyContainer(match.index ?? 0)) continue;
    const id = attribute(match[1], 'id');
    const day = /^week(\d+)$/i.exec(id ?? '')?.[1];
    const text = textContent(match[2]);
    if (!day || !/^week\s+\d+\s*$/i.test(text)) continue;
    const number = Number.parseInt(day, 10);
    if (!Number.isSafeInteger(number) || number < 1)
      throw new Error(`Easy Peasy weekly marker is malformed: ${id}`);
    const statedMatch = /^week\s+(\d+)/i.exec(text);
    if (!statedMatch) continue;
    const stated = Number.parseInt(statedMatch[1], 10);
    if (stated !== number)
      throw new Error('Easy Peasy weekly container and marker disagree.');
    matches.push({
      index: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
      text,
      day: number,
      fragment: `week${number}`,
      title: `Week ${number}`,
    });
  }
  const headings = /<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]\s*>/gi;
  for (const match of html.matchAll(headings)) {
    if (isInDailyContainer(match.index ?? 0)) continue;
    matches.push({
      index: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
      text: textContent(match[1]),
    });
  }
  const blocks = /<(p|li)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi;
  for (const block of html.matchAll(blocks)) {
    if (isInDailyContainer(block.index ?? 0)) continue;
    const bold = /<(?:strong|b)\b[^>]*>([\s\S]*?)<\/(?:strong|b)\s*>/i.exec(
      block[2],
    );
    if (!bold) continue;
    const text = textContent(bold[1]);
    if (!/^lesson\b/i.test(text)) continue;
    const boldIndex = (block.index ?? 0) + block[0].indexOf(bold[0]);
    matches.push({
      index: block.index ?? 0,
      end: boldIndex + bold[0].length,
      text,
    });
  }
  const sorted = matches.sort((left, right) => left.index - right.index);
  const boldMarkers = /<(strong|b)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi;
  for (const marker of html.matchAll(boldMarkers)) {
    if (!/^lesson\b/i.test(textContent(marker[2]))) continue;
    const index = marker.index ?? 0;
    const end = index + marker[0].length;
    const accountedFor =
      isInDailyContainer(index) ||
      sorted.some(
        (heading) =>
          /^lesson\b/i.test(heading.text) &&
          (heading.index === index ||
            (heading.index <= index && end <= heading.end)),
      );
    if (!accountedFor)
      throw new Error('Easy Peasy lesson marker layout is unsupported.');
  }
  return sorted;
}

function lessonMarkerText(segment: string): string | undefined {
  const markers = /<(?:strong|b)\b[^>]*>([\s\S]*?)<\/(?:strong|b)\s*>/gi;
  for (const marker of segment.matchAll(markers)) {
    const text = textContent(marker[1]);
    if (/^lesson\b/i.test(text)) return text;
  }
  return undefined;
}

function parseLessonMarker(value: string): { day: number; worksheet: boolean } {
  const match = /^lesson\s+(\d+)\s*(\*|\(\*\))?(?:\s*\(|\s*$)/i.exec(value);
  if (!match)
    throw new Error(`Easy Peasy lesson heading is malformed: ${value}`);
  return {
    day: Number.parseInt(match[1], 10),
    worksheet: match[2] === '*' || match[2] === '(*)',
  };
}

/** Reject incomplete lesson markup before the tolerant extractors can skip it. */
function rejectUnterminatedLessonTags(html: string): void {
  const openings = /<(h[1-6]|strong|b)\b[^>]*>\s*(?:<[^>]*>\s*)*lesson\b/gi;
  const candidates = [...html.matchAll(openings)];
  for (let index = 0; index < candidates.length; index += 1) {
    const opening = candidates[index];
    const tag = opening[1].toLowerCase();
    const afterOpening = (opening.index ?? 0) + opening[0].length;
    const closing = new RegExp(`<\\/${tag}\\s*>`, 'i').exec(
      html.slice(afterOpening),
    );
    const closingIndex = closing
      ? afterOpening + (closing.index ?? 0)
      : Number.POSITIVE_INFINITY;
    const nextOpening =
      candidates[index + 1]?.index ?? Number.POSITIVE_INFINITY;
    if (closingIndex > nextOpening || !Number.isFinite(closingIndex))
      throw new Error(
        'Easy Peasy lesson heading is unterminated or mismatched.',
      );
  }
}

function links(html: string): LinkMatch[] {
  const result: LinkMatch[] = [];
  const anchors = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;
  for (const match of html.matchAll(anchors)) {
    const href = attribute(match[1], 'href');
    if (href)
      result.push({ href: decodeHtml(href), text: textContent(match[2]) });
  }
  return result;
}

function isPdfLink(link: LinkMatch): boolean {
  return /\.pdf(?:[?#]|$)/i.test(link.href);
}

function isAnswerLink(link: LinkMatch): boolean {
  return /\banswers?(?:\s+key)?\b/i.test(`${link.href} ${link.text}`);
}

function isPacketLink(link: LinkMatch): boolean {
  return /\b(?:packet|whole course|complete course)\b/i.test(link.text);
}

function isSupplementalPdfLink(link: LinkMatch): boolean {
  return /\b(?:directions?|instructions?)\b/i.test(`${link.href} ${link.text}`);
}

function courseTitle(html: string): string {
  const entryTitle =
    /<h1\b(?=[^>]*\bclass=(?:"[^"]*\bentry-title\b[^"]*"|'[^']*\bentry-title\b[^']*'|[^\s>]*\bentry-title\b))[^>]*>([\s\S]*?)<\/h1\s*>/i.exec(
      html,
    )?.[1];
  const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i.exec(html)?.[1];
  const title = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html)?.[1];
  const value = textContent(entryTitle ?? h1 ?? title ?? '');
  if (!value) throw new Error('Easy Peasy page has no title.');
  return value;
}

function isApprovedSourcePdf(link: LinkMatch, pageUrl: string): boolean {
  try {
    sourcePdf(link, pageUrl);
    return true;
  } catch {
    return false;
  }
}

function sourcePdf(link: LinkMatch, pageUrl: string): string {
  const url = validateEasyPeasyUrl(link.href, pageUrl);
  const parsed = new URL(url);
  if (!parsed.pathname.startsWith('/wp-content/'))
    throw new Error('Easy Peasy PDF must be hosted under wp-content.');
  if (!/\.pdf$/i.test(parsed.pathname))
    throw new Error('Easy Peasy printable URL must be a PDF.');
  return url;
}

function canonicalWorksheetLink(
  links: LinkMatch[],
  pageUrl: string,
): LinkMatch[] {
  if (links.length < 2) return links;
  const stem = (link: LinkMatch): string => {
    const pathname = new URL(link.href, pageUrl).pathname;
    return pathname
      .slice(pathname.lastIndexOf('/') + 1)
      .replace(/\.pdf$/i, '')
      .toLowerCase();
  };
  const escapeRegex = (value: string): string =>
    value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const canonical = links.filter((candidate) => {
    const candidateStem = stem(candidate);
    const variant = new RegExp(`^${escapeRegex(candidateStem)}(?:[-_ ]?\\d+)$`);
    return links.every(
      (link) => link === candidate || variant.test(stem(link)),
    );
  });
  // Multi-page worksheet variants retain the course-day pointer and one
  // canonical printable URL; unrelated multiple PDFs remain a hard failure.
  return canonical.length === 1 ? canonical : links;
}

interface PrintablePointer {
  printableUrl?: string;
  hasSourcePdf: boolean;
}

function printableFor(
  segment: string,
  pageUrl: string,
  day: number,
): PrintablePointer {
  const pdfLinks = links(segment)
    .filter(isPdfLink)
    .filter(
      (link) =>
        !isAnswerLink(link) &&
        !isPacketLink(link) &&
        !isSupplementalPdfLink(link) &&
        isApprovedSourcePdf(link, pageUrl),
    );
  const ownDay = new RegExp(`(?:day|lesson)[\\s_-]*${day}(?:\\D|$)`, 'i');
  const dayLinks = pdfLinks.filter((link) =>
    ownDay.test(`${link.href} ${link.text}`),
  );
  const candidates = canonicalWorksheetLink(
    dayLinks.length ? dayLinks : pdfLinks,
    pageUrl,
  );
  if (candidates.length > 1)
    // The course page remains the lesson pointer; this bounded model deliberately
    // retains no printable when the source publishes multiple source PDFs.
    return { hasSourcePdf: true };
  return candidates[0]
    ? { printableUrl: sourcePdf(candidates[0], pageUrl), hasSourcePdf: true }
    : { hasSourcePdf: false };
}

function packetFor(html: string, pageUrl: string): string | undefined {
  const packets = links(html).filter(
    (link) => isPdfLink(link) && !isAnswerLink(link) && isPacketLink(link),
  );
  if (packets.length > 1)
    throw new Error('Easy Peasy page has ambiguous packet PDFs.');
  return packets[0] ? sourcePdf(packets[0], pageUrl) : undefined;
}

/** Parse only the course title, day pointers, and source-hosted printable links. */
export function parseEasyPeasyPage(
  html: string,
  pageUrl: string,
): ParsedSourceCourse {
  const normalizedPageUrl = validateEasyPeasyUrl(pageUrl);
  const source = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  rejectUnterminatedLessonTags(source);
  const title = courseTitle(source);
  const headings = lessonHeadings(source);
  const lessons: ParsedSourceLesson[] = [];
  const days = new Set<number>();

  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index];
    if (heading.day === undefined && !/^lesson\b/i.test(heading.text)) continue;
    const segment = source.slice(heading.end, headings[index + 1]?.index);
    const marker =
      heading.day === undefined ? heading.text : lessonMarkerText(segment);
    let parsedMarker: { day: number; worksheet: boolean } | undefined;
    if (marker) {
      try {
        parsedMarker = parseLessonMarker(marker);
      } catch (error) {
        // A source-controlled day/week container remains authoritative when it
        // includes a decorative nonnumeric "Lesson" label.
        if (heading.day === undefined) throw error;
      }
    }
    const day = heading.day ?? parsedMarker?.day;
    if (
      !day ||
      (heading.day !== undefined && parsedMarker && parsedMarker.day !== day)
    )
      throw new Error('Easy Peasy daily container and lesson marker disagree.');
    if (!Number.isSafeInteger(day) || day < 1 || days.has(day))
      throw new Error(`Easy Peasy lesson day is invalid or duplicated: ${day}`);
    days.add(day);
    const printable = printableFor(segment, normalizedPageUrl, day);
    // Some official daily containers put the worksheet asterisk on a child
    // activity label rather than the Lesson marker. A source-hosted printable
    // is sufficient evidence without retaining that activity text.
    const worksheet = parsedMarker?.worksheet ?? printable.hasSourcePdf;
    const page = new URL(normalizedPageUrl);
    page.hash = heading.fragment ?? `lesson-${day}`;
    lessons.push({
      day,
      title: heading.title ?? `Lesson ${day}`,
      externalRef: `lesson:${day}`,
      externalUrl: page.toString(),
      worksheet,
      ...(printable.printableUrl
        ? { printableUrl: printable.printableUrl }
        : {}),
    });
  }
  if (!lessons.length)
    throw new Error('Easy Peasy page has no lesson headings.');
  const packetUrl = packetFor(source, normalizedPageUrl);
  return { title, lessons, ...(packetUrl ? { packetUrl } : {}) };
}
