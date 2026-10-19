import type { CatalogSourceRecord } from '../catalog-contracts.js';

const host = 'im.kendallhunt.com';

function text(value: string): string {
  return value
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parses the publicly linked K-5 family curriculum index published by the IM
 * Certified Kendall Hunt site. It is deliberately metadata-only: unit and
 * lesson pages are not fetched or acquired here.
 */
export function parseIllustrativeMathematicsK5Index(
  html: string,
  revision: string,
  pageUrl = 'https://im.kendallhunt.com/k5/curriculum.html',
): CatalogSourceRecord[] {
  const index = new URL(pageUrl);
  if (index.protocol !== 'https:' || index.hostname !== host)
    throw new Error(
      'Illustrative Mathematics index must use the official HTTPS host.',
    );
  if (!revision.trim())
    throw new Error('Illustrative Mathematics revision is required.');

  const records: CatalogSourceRecord[] = [];
  const seen = new Set<string>();
  const anchors = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;
  for (const match of html.matchAll(anchors)) {
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(match[1])?.[1];
    if (!href) continue;
    const url = new URL(href, index);
    const grade =
      /^\/K5\/families\/(kindergarten|grade-[1-5])\/units\.html$/i.exec(
        url.pathname,
      )?.[1];
    if (!grade || url.hostname !== host || seen.has(url.pathname)) continue;
    seen.add(url.pathname);
    const gradeLabel =
      grade === 'kindergarten' ? 'K' : grade.slice('grade-'.length);
    records.push({
      providerId: 'illustrative-mathematics',
      stableId: `k5-family-${grade.toLowerCase()}`,
      revision,
      canonicalUrl: url.toString(),
      title: `IM K-5 Math Grade ${gradeLabel}`,
      suppliedDescription: text(match[2]) || undefined,
      subjects: ['mathematics'],
      gradeRange: { min: gradeLabel, max: gradeLabel },
      language: 'en',
      resourceType: 'course',
      availableFormats: ['html'],
      licenseEvidence: {
        state: 'verified',
        identifier: 'CC BY',
        version: '4.0',
        sourceUrl: 'https://creativecommons.org/licenses/by/4.0/',
        retrievedAt: revision,
        permittedOperations: [
          'link',
          'adapt',
          'redistribute',
          'commercial-use',
        ],
      },
      visibility: 'catalog',
    });
  }
  if (!records.length)
    throw new Error(
      'Illustrative Mathematics K-5 index has no family-grade links.',
    );
  return records;
}
