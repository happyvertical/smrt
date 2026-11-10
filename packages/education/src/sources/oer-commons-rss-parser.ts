import type { CatalogSourceRecord } from '../catalog-contracts.js';

const maximumFeedBytes = 2_000_000;
const namedEntities: Readonly<Record<string, string>> = {
  '&amp;': '&',
  '&apos;': "'",
  '&gt;': '>',
  '&lt;': '<',
  '&quot;': '"',
};

function decode(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(
      /&(?:amp|apos|gt|lt|quot);/g,
      (entity) => namedEntities[entity] ?? entity,
    )
    .replace(/\s+/g, ' ')
    .trim();
}

function element(xml: string, names: readonly string[]): string | undefined {
  for (const name of names) {
    const match = new RegExp(
      `<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}\\s*>`,
      'i',
    ).exec(xml);
    const value = match ? decode(match[1]) : '';
    if (value) return value;
  }
  return undefined;
}

function elements(xml: string, names: readonly string[]): string[] {
  const values: string[] = [];
  for (const name of names) {
    const expression = new RegExp(
      `<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}\\s*>`,
      'gi',
    );
    for (const match of xml.matchAll(expression)) {
      const value = decode(match[1]);
      if (value) values.push(value);
    }
  }
  return [...new Set(values)];
}

function https(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Parses a configured OER Commons/ISKME RSS or Dublin Core feed without entity
 * expansion or external resolution. The configured feed is authoritative for
 * scope; this parser never represents its page as global catalog coverage.
 */
export function parseOerCommonsRssFeed(
  xml: string,
  revision: string,
): CatalogSourceRecord[] {
  if (new TextEncoder().encode(xml).byteLength > maximumFeedBytes)
    throw new Error('OER Commons RSS feed exceeds the 2 MB metadata limit.');
  if (/<!DOCTYPE|<!ENTITY/i.test(xml))
    throw new Error('OER Commons RSS feed must not contain DTDs or entities.');
  if (!revision.trim())
    throw new Error('OER Commons feed revision is required.');

  const records: CatalogSourceRecord[] = [];
  const items = xml.match(/<item\b[^>]*>[\s\S]*?<\/item\s*>/gi) ?? [];
  for (const item of items) {
    const canonicalUrl = https(element(item, ['link', 'dc:identifier']));
    const stableId = element(item, ['guid', 'dc:identifier']) ?? canonicalUrl;
    const title = element(item, ['title', 'dc:title']);
    if (!canonicalUrl || !stableId || !title) continue;
    const rights = element(item, ['license', 'dc:rights', 'rights']);
    const licenseUrl = https(rights);
    records.push({
      providerId: 'oer-commons',
      stableId,
      revision: element(item, ['dc:date', 'pubDate']) ?? revision,
      canonicalUrl,
      title,
      suppliedDescription: element(item, ['description', 'dc:description']),
      author: element(item, ['dc:creator', 'author']),
      subjects: elements(item, ['category', 'dc:subject']),
      language: element(item, ['dc:language', 'language']),
      resourceType: element(item, ['dc:type']) ?? 'resource',
      availableFormats: elements(item, ['dc:format']),
      licenseEvidence: rights
        ? {
            // A feed label is provenance, not a license validation decision.
            state: 'unknown',
            identifier: rights,
            ...(licenseUrl ? { sourceUrl: licenseUrl } : {}),
            retrievedAt: revision,
          }
        : { state: 'unknown', retrievedAt: revision },
      visibility: 'catalog',
    });
  }
  if (!records.length)
    throw new Error('OER Commons RSS feed has no complete metadata items.');
  return records;
}
