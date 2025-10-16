/**
 * Web and URL utility functions
 *
 * General-purpose utilities for working with URLs and web content.
 * Used by scrapers, note systems, and content processors.
 */

import { createHash } from 'node:crypto';

/**
 * Normalize URL for consistent key storage
 * Removes tracking params, sorts query string, lowercases, etc.
 *
 * @param url - The URL to normalize
 * @returns Normalized URL string
 */
export function normalizeUrl(url: string): string {
  const parsed = new URL(url);

  // Lowercase scheme and host
  parsed.protocol = parsed.protocol.toLowerCase();
  parsed.hostname = parsed.hostname.toLowerCase();

  // Remove www prefix
  parsed.hostname = parsed.hostname.replace(/^www\./, '');

  // Remove default ports
  if (
    (parsed.protocol === 'http:' && parsed.port === '80') ||
    (parsed.protocol === 'https:' && parsed.port === '443')
  ) {
    parsed.port = '';
  }

  // Remove fragment
  parsed.hash = '';

  // Sort and filter query params
  const params = new URLSearchParams(parsed.search);
  const filtered = new URLSearchParams();
  const trackingParams = [
    'utm_source',
    'utm_medium',
    'utm_campaign',
    'utm_content',
    'utm_term',
    'fbclid',
    'gclid',
    'msclkid',
    '_ga',
    'mc_cid',
    'mc_eid',
  ];

  Array.from(params.keys())
    .sort()
    .forEach((key) => {
      if (!trackingParams.includes(key)) {
        filtered.set(key, params.get(key)!);
      }
    });

  parsed.search = filtered.toString();

  return parsed.toString();
}

/**
 * Generate hierarchical scope from URL for organized note storage
 *
 * @param url - The URL to generate scope from
 * @param baseScope - Base scope prefix (default: 'discovery/parser')
 * @returns Hierarchical scope string
 *
 * @example
 * generateScopeFromUrl('https://cityofboston.gov/meetings/minutes')
 * // Returns: 'discovery/parser/cityofboston.gov/meetings'
 */
export function generateScopeFromUrl(
  url: string,
  baseScope = 'discovery/parser',
): string {
  const parsed = new URL(normalizeUrl(url));
  const domain = parsed.hostname;
  const pathParts = parsed.pathname.split('/').filter((p) => p);

  // Use first path segment as page type (e.g., 'meetings', 'documents')
  const pageType = pathParts[0] || 'index';

  return `${baseScope}/${domain}/${pageType}`;
}

/**
 * Hash page content for change detection
 * Uses SHA-256 to create a unique fingerprint of the HTML
 *
 * @param html - Page HTML content
 * @returns SHA-256 hash as hex string
 */
export function hashPageContent(html: string): string {
  return createHash('sha256').update(html).digest('hex');
}
