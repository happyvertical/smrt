/**
 * Sets rate limit configuration for a specific domain
 *
 * Configures custom rate limiting for a specific domain. This allows you to
 * set different limits for different services based on their API requirements.
 *
 * @param domain - Domain to set limits for (e.g., 'api.github.com')
 * @param limit - Maximum number of requests per interval
 * @param interval - Interval in milliseconds (time window for the limit)
 *
 * @example
 * ```typescript
 * // Set GitHub API to 30 requests per minute
 * await addRateLimit('api.github.com', 30, 60000);
 *
 * // Set custom API to 10 requests per 5 seconds
 * await addRateLimit('my-api.example.com', 10, 5000);
 * ```
 */
export declare function addRateLimit(domain: string, limit: number, interval: number): Promise<void>;
/**
 * Gets rate limit configuration for a specific domain
 *
 * Retrieves the current rate limiting configuration for a domain.
 * If no specific configuration exists, returns the default configuration.
 *
 * @param domain - Domain to get limits for
 * @returns Promise resolving to rate limit configuration with limit and interval properties
 *
 * @example
 * ```typescript
 * const config = await getRateLimit('api.github.com');
 * console.log(`GitHub API: ${config.limit} requests per ${config.interval}ms`);
 * ```
 */
export declare function getRateLimit(domain: string): Promise<{
    limit: number;
    interval: number;
}>;
/**
 * Fetches a URL and returns the response as text with automatic rate limiting
 *
 * Convenience function that performs a rate-limited fetch and returns the
 * response body as a text string. Ideal for fetching HTML, CSS, plain text,
 * or other text-based content.
 *
 * @param url - URL to fetch
 * @returns Promise resolving to the response body as a string
 * @throws {Error} If the fetch fails or response is not ok
 *
 * @example
 * ```typescript
 * const html = await fetchText('https://example.com');
 * console.log('Page content:', html);
 *
 * const readme = await fetchText('https://raw.githubusercontent.com/user/repo/main/README.md');
 * ```
 */
export declare function fetchText(url: string): Promise<string>;
/**
 * Fetches a URL and returns the response as parsed JSON with automatic rate limiting
 *
 * Convenience function that performs a rate-limited fetch and parses the
 * response body as JSON. Perfect for consuming REST APIs and JSON endpoints.
 *
 * @param url - URL to fetch
 * @returns Promise resolving to the parsed JSON response (any type)
 * @throws {Error} If the fetch fails, response is not ok, or JSON parsing fails
 *
 * @example
 * ```typescript
 * const data = await fetchJSON('https://api.github.com/user');
 * console.log('User data:', data);
 *
 * const config = await fetchJSON('https://example.com/api/config');
 * ```
 */
export declare function fetchJSON(url: string): Promise<any>;
/**
 * Fetches a URL and returns the response as a Buffer with automatic rate limiting
 *
 * Convenience function that performs a rate-limited fetch and returns the
 * response body as a Buffer. Ideal for fetching binary data like images,
 * documents, or other non-text content.
 *
 * @param url - URL to fetch
 * @returns Promise resolving to the response body as a Buffer
 * @throws {Error} If the fetch fails or response is not ok
 *
 * @example
 * ```typescript
 * const imageBuffer = await fetchBuffer('https://example.com/image.png');
 * await fs.writeFile('downloaded-image.png', imageBuffer);
 *
 * const pdfBuffer = await fetchBuffer('https://example.com/document.pdf');
 * ```
 */
export declare function fetchBuffer(url: string): Promise<Buffer>;
/**
 * Fetches a URL and saves the response directly to a file with automatic rate limiting
 *
 * Convenience function that performs a rate-limited fetch and writes the
 * response body directly to a local file. Efficient for downloading files
 * without loading the entire content into memory.
 *
 * @param url - URL to fetch
 * @param filepath - Local file path where the content should be saved
 * @returns Promise that resolves when the file is saved successfully
 * @throws {Error} If the fetch fails, response is not ok, or file write fails
 *
 * @example
 * ```typescript
 * await fetchToFile('https://example.com/large-file.zip', './downloads/file.zip');
 * console.log('File downloaded successfully');
 *
 * await fetchToFile('https://api.example.com/report.pdf', './reports/daily.pdf');
 * ```
 */
export declare function fetchToFile(url: string, filepath: string): Promise<void>;
//# sourceMappingURL=fetch.d.ts.map