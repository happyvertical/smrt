import { writeFile } from 'node:fs/promises';

/**
 * Rate limiter for controlling fetch request frequency by domain
 *
 * This class implements a per-domain rate limiting system to prevent
 * overwhelming servers with too many concurrent requests. It maintains
 * separate limits for each domain and automatically delays requests
 * when limits are exceeded.
 *
 * @internal
 */
class RateLimiter {
  /**
   * Map of domains to their rate limit configurations
   * Each domain tracks: lastRequest time, request limit, interval, and current queue size
   */
  private domains: Map<
    string,
    {
      lastRequest: number;
      limit: number;
      interval: number;
      queue: number;
    }
  > = new Map();

  /**
   * Default maximum number of requests per interval
   * Applied to domains that don't have specific limits configured
   */
  private defaultLimit = 6;

  /**
   * Default interval in milliseconds (500ms)
   * Time window for the request limit enforcement
   */
  private defaultInterval = 500;

  /**
   * Creates a new RateLimiter with default settings
   * Initializes with a 'default' domain configuration used as fallback
   */
  constructor() {
    // Initialize with default settings
    this.domains.set('default', {
      lastRequest: 0,
      limit: this.defaultLimit,
      interval: this.defaultInterval,
      queue: 0,
    });
  }

  /**
   * Extracts the domain from a URL for rate limiting purposes
   *
   * @param url - URL to extract domain from
   * @returns Domain string (hostname) or 'default' if the URL is invalid
   *
   * @internal
   */
  private getDomain(url: string): string {
    try {
      return new URL(url).hostname;
    } catch {
      return 'default';
    }
  }

  /**
   * Waits until the next request can be made according to rate limits
   *
   * This method implements the core rate limiting logic. It checks if the
   * current request would exceed the domain's rate limit and delays if necessary.
   *
   * @param url - URL to check rate limits for (domain extracted automatically)
   * @returns Promise that resolves when the request can proceed safely
   *
   * @internal
   */
  async waitForNext(url: string): Promise<void> {
    const domain = this.getDomain(url);
    const now = Date.now();

    const domainConfig =
      this.domains.get(domain) || this.domains.get('default')!;

    // Wait if we're over the limit
    if (domainConfig.queue >= domainConfig.limit) {
      const timeToWait = Math.max(
        0,
        domainConfig.lastRequest + domainConfig.interval - now,
      );
      if (timeToWait > 0) {
        await new Promise((resolve) => setTimeout(resolve, timeToWait));
      }
      domainConfig.queue = 0;
    }

    domainConfig.lastRequest = now;
    domainConfig.queue++;
  }

  /**
   * Sets rate limit for a specific domain
   *
   * @param domain - Domain to set limits for
   * @param limit - Maximum number of requests per interval
   * @param interval - Interval in milliseconds
   */
  setDomainLimit(domain: string, limit: number, interval: number) {
    this.domains.set(domain, {
      lastRequest: 0,
      limit,
      interval,
      queue: 0,
    });
  }

  /**
   * Gets rate limit configuration for a domain
   *
   * @param domain - Domain to get limits for
   * @returns Rate limit configuration
   */
  getDomainLimit(domain: string) {
    return this.domains.get(domain) || this.domains.get('default')!;
  }
}

// Create singleton instance
const rateLimiter = new RateLimiter();

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
export async function addRateLimit(
  domain: string,
  limit: number,
  interval: number,
) {
  rateLimiter.setDomainLimit(domain, limit, interval);
}

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
export async function getRateLimit(
  domain: string,
): Promise<{ limit: number; interval: number }> {
  const config = rateLimiter.getDomainLimit(domain);
  return {
    limit: config.limit,
    interval: config.interval,
  };
}

/**
 * Performs a fetch request with automatic rate limiting
 *
 * This is the core fetch function that applies rate limiting based on the
 * target domain. It automatically delays requests when necessary to respect
 * the configured rate limits.
 *
 * @param url - URL to fetch
 * @param options - Standard fetch RequestInit options
 * @returns Promise resolving to a Response object
 *
 * @internal
 */
async function rateLimitedFetch(
  url: string,
  options?: RequestInit,
): Promise<Response> {
  await rateLimiter.waitForNext(url);
  return fetch(url, options);
}

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
export async function fetchText(url: string): Promise<string> {
  const response = await rateLimitedFetch(url);
  return response.text();
}

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
export async function fetchJSON(url: string): Promise<any> {
  const response = await rateLimitedFetch(url);
  return response.json();
}

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
export async function fetchBuffer(url: string): Promise<Buffer> {
  const response = await rateLimitedFetch(url);
  return Buffer.from(await response.arrayBuffer());
}

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
export async function fetchToFile(
  url: string,
  filepath: string,
): Promise<void> {
  const response = await rateLimitedFetch(url);
  const buffer = await response.arrayBuffer();
  await writeFile(filepath, Buffer.from(buffer));
}
