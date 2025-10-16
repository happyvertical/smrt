/**
 * Web and URL utility functions
 *
 * General-purpose utilities for working with URLs and web content.
 * Used by scrapers, note systems, and content processors.
 */
/**
 * Normalize URL for consistent key storage
 * Removes tracking params, sorts query string, lowercases, etc.
 *
 * @param url - The URL to normalize
 * @returns Normalized URL string
 */
export declare function normalizeUrl(url: string): string;
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
export declare function generateScopeFromUrl(url: string, baseScope?: string): string;
/**
 * Hash page content for change detection
 * Uses SHA-256 to create a unique fingerprint of the HTML
 *
 * @param html - Page HTML content
 * @returns SHA-256 hash as hex string
 */
export declare function hashPageContent(html: string): string;
//# sourceMappingURL=web.d.ts.map