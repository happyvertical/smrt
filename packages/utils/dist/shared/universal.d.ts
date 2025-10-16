import { createId as cuid2CreateId, isCuid } from '@paralleldrive/cuid2';
import { add, isValid } from 'date-fns';
import { default as pluralize } from 'pluralize';
/**
 * Generates a unique identifier using CUID2 (preferred) or UUID fallback
 *
 * CUID2 is more secure and collision-resistant than UUIDs, but UUID is provided
 * as a fallback for RFC4122 compliance requirements.
 *
 * @param type - ID type: 'cuid2' (default) or 'uuid'
 * @returns A unique identifier string
 * @example
 * ```typescript
 * const id = makeId(); // CUID2: "ckx5f8h3z0000qzrmn831i7rn"
 * const uuid = makeId('uuid'); // UUID: "f47ac10b-58cc-4372-a567-0e02b2c3d479"
 * ```
 */
export declare const makeId: (type?: "cuid2" | "uuid") => string;
/**
 * Generates a CUID2 identifier (collision-resistant, more secure than UUID)
 *
 * CUID2 provides better entropy and security compared to UUID v4, making it
 * ideal for distributed systems and user-facing identifiers.
 *
 * @returns A CUID2 identifier string
 * @example
 * ```typescript
 * const id = createId(); // "ckx5f8h3z0000qzrmn831i7rn"
 * ```
 */
export declare const createId: typeof cuid2CreateId;
/**
 * Checks if a string is a valid CUID2
 */
export { isCuid };
/**
 * Converts a string to a URL-friendly slug
 *
 * Handles international characters, removes special characters, and replaces
 * spaces with hyphens. Ampersands are converted to "-38-" for uniqueness.
 *
 * @param str - The string to convert to a slug
 * @returns A URL-friendly slug string
 * @example
 * ```typescript
 * makeSlug("My Example Title & Co."); // "my-example-title-38-co"
 * makeSlug("Café España"); // "cafe-espana"
 * ```
 */
export declare const makeSlug: (str: string) => string;
/**
 * Extracts the filename from a URL's pathname
 *
 * Returns the last segment of the URL path. If no filename is found,
 * defaults to 'index.html'.
 *
 * @param url - The URL to extract filename from
 * @returns The filename from the URL
 * @throws {TypeError} When URL is invalid
 * @example
 * ```typescript
 * urlFilename("https://example.com/path/file.pdf"); // "file.pdf"
 * urlFilename("https://example.com/path/"); // "index.html"
 * ```
 */
export declare const urlFilename: (url: string) => string;
/**
 * Converts a URL to a file path by joining hostname and pathname
 *
 * Creates a file system compatible path from a URL by combining the hostname
 * with the pathname segments, useful for creating local file structures.
 *
 * @param url - The URL to convert to a path
 * @returns A file path string with hostname and path segments
 * @throws {TypeError} When URL is invalid
 * @example
 * ```typescript
 * urlPath("https://example.com/path/to/resource"); // "example.com/path/to/resource"
 * ```
 */
export declare const urlPath: (url: string) => string;
/**
 * Creates a Promise that resolves after a specified duration
 *
 * Useful for adding delays in async functions or rate limiting operations.
 *
 * @param duration - Time to wait in milliseconds
 * @returns Promise that resolves after the specified duration
 * @example
 * ```typescript
 * await sleep(1000); // Wait 1 second
 * console.log('1 second has passed');
 * ```
 */
export declare const sleep: (duration: number) => Promise<void>;
/**
 * Repeatedly calls a function until it returns a defined value or times out
 *
 * Polls an async function at regular intervals until it returns a defined value
 * or the timeout is reached. Useful for waiting for conditions to be met.
 *
 * @param it - Async function to poll
 * @param options - Configuration options
 * @param options.timeout - Maximum time to wait in milliseconds (0 = no timeout)
 * @param options.delay - Time between polling attempts in milliseconds
 * @returns Promise that resolves with the function result or rejects on timeout
 * @throws {TimeoutError} When timeout is reached before function returns defined value
 * @example
 * ```typescript
 * // Wait for a file to exist
 * const fileExists = await waitFor(
 *   async () => {
 *     try {
 *       await fs.access('/path/to/file');
 *       return true;
 *     } catch {
 *       return undefined; // Keep polling
 *     }
 *   },
 *   { timeout: 10000, delay: 500 }
 * );
 * ```
 */
export declare function waitFor(it: () => Promise<any>, { timeout, delay }?: {
    timeout?: number;
    delay?: number;
}): Promise<any>;
/**
 * Type guard to check if a value is an array
 *
 * @param obj - Value to check
 * @returns True if value is an array, with TypeScript type narrowing
 * @example
 * ```typescript
 * if (isArray(data)) {
 *   // TypeScript knows data is unknown[]
 *   data.forEach(item => console.log(item));
 * }
 * ```
 */
export declare const isArray: (obj: unknown) => obj is unknown[];
/**
 * Type guard to check if a value is a plain object
 *
 * Checks for objects that are not null, arrays, or other non-plain object types.
 *
 * @param obj - Value to check
 * @returns True if value is a plain object, with TypeScript type narrowing
 * @example
 * ```typescript
 * if (isPlainObject(data)) {
 *   // TypeScript knows data is Record<string, unknown>
 *   Object.keys(data).forEach(key => console.log(key, data[key]));
 * }
 * ```
 */
export declare const isPlainObject: (obj: unknown) => obj is Record<string, unknown>;
/**
 * Checks if a string is a valid URL
 *
 * Uses the URL constructor to validate the string format. Returns false
 * for any string that cannot be parsed as a valid URL.
 *
 * @param url - String to validate as URL
 * @returns True if string is a valid URL
 * @example
 * ```typescript
 * isUrl("https://example.com"); // true
 * isUrl("not-a-url"); // false
 * ```
 */
export declare const isUrl: (url: string) => boolean;
/**
 * Converts a string to camelCase
 *
 * Handles kebab-case, snake_case, and space-separated strings.
 * Removes special characters and ensures proper camelCase formatting.
 *
 * @param str - String to convert
 * @returns camelCase formatted string
 * @example
 * ```typescript
 * camelCase("hello-world"); // "helloWorld"
 * camelCase("snake_case_string"); // "snakeCaseString"
 * camelCase("Some Title"); // "someTitle"
 * ```
 */
export declare const camelCase: (str: string) => string;
/**
 * Converts a string to snake_case
 *
 * Handles camelCase, kebab-case, and space-separated strings.
 * Converts to lowercase with underscore separators.
 *
 * @param str - String to convert
 * @returns snake_case formatted string
 * @example
 * ```typescript
 * snakeCase("helloWorld"); // "hello_world"
 * snakeCase("kebab-case-string"); // "kebab_case_string"
 * snakeCase("Some Title"); // "some_title"
 * ```
 */
export declare const snakeCase: (str: string) => string;
/**
 * Recursively converts all object keys to camelCase
 *
 * Deeply traverses an object or array and converts all keys to camelCase.
 * Preserves the structure and values, only transforming key names.
 *
 * @param obj - Object or array to transform
 * @returns New object/array with camelCase keys
 * @example
 * ```typescript
 * keysToCamel({
 *   user_name: "john",
 *   user_details: { first_name: "John" }
 * }); // { userName: "john", userDetails: { firstName: "John" } }
 * ```
 */
export declare const keysToCamel: (obj: unknown) => unknown;
/**
 * Recursively converts all object keys to snake_case
 *
 * Deeply traverses an object or array and converts all keys to snake_case.
 * Preserves the structure and values, only transforming key names.
 *
 * @param obj - Object or array to transform
 * @returns New object/array with snake_case keys
 * @example
 * ```typescript
 * keysToSnake({
 *   userName: "john",
 *   userDetails: { firstName: "John" }
 * }); // { user_name: "john", user_details: { first_name: "John" } }
 * ```
 */
export declare const keysToSnake: (obj: unknown) => unknown;
/**
 * Converts a domain string to camelCase
 *
 * Convenience function that applies camelCase conversion to domain strings.
 * Useful for converting API service names or domain identifiers.
 *
 * @param domain - Domain string to convert
 * @returns camelCase formatted domain string
 * @example
 * ```typescript
 * domainToCamel("api-service"); // "apiService"
 * domainToCamel("user_management"); // "userManagement"
 * ```
 */
export declare const domainToCamel: (domain: string) => string;
/**
 * Creates a visual progress indicator by cycling through a sequence of characters
 *
 * Useful for creating animated progress indicators in CLI applications.
 * Cycles through provided characters or defaults to dot sequences.
 *
 * @param tick - Current tick state (null to start)
 * @param options - Configuration options
 * @param options.chars - Array of characters to cycle through
 * @returns Next character in the sequence
 * @example
 * ```typescript
 * let tick = null;
 * setInterval(() => {
 *   tick = logTicker(tick);
 *   process.stdout.write(`\rProcessing ${tick}`);
 * }, 500);
 * // Outputs: "Processing ." → "Processing .." → "Processing ..."
 * ```
 */
export declare const logTicker: (tick: string | null, options?: {
    chars?: string[];
}) => string;
/**
 * Parses an Amazon date string format (YYYYMMDDTHHMMSSZ) to a Date object
 *
 * Specifically handles the compact date format used by Amazon AWS services.
 * Validates the format and throws detailed errors for invalid inputs.
 *
 * @param dateStr - Amazon date string in format YYYYMMDDTHHMMSSZ
 * @returns Parsed Date object
 * @throws {ParsingError} When date string format is invalid
 * @example
 * ```typescript
 * parseAmazonDateString('20220223T215409Z');
 * // Returns: Date object for February 23, 2022, 21:54:09 UTC
 * ```
 */
export declare const parseAmazonDateString: (dateStr: string) => Date;
/**
 * Extracts and parses a date from a string
 *
 * Intelligently extracts dates from filenames or text strings by looking for
 * common date patterns. Supports multiple formats including:
 * - ISO dates (2023-01-15, 2023/01/15)
 * - US dates (01/15/2023, 01-15-2023)
 * - Natural language (January 15, 2023, Oct 14 2025)
 * - Filenames with dates (Report_January_15_2023.pdf)
 *
 * @param str - String containing date information (filename, title, or text)
 * @returns Parsed Date object or null if no valid date found
 * @example
 * ```typescript
 * dateInString("Report_January_15_2023.pdf"); // Date(2023, 0, 15)
 * dateInString("Regular Council Meeting October 14, 2025"); // Date(2025, 9, 14)
 * dateInString("financial-report-dec-2023.pdf"); // Date(2023, 11, 1)
 * dateInString("2023-01-15"); // Date(2023, 0, 15)
 * dateInString("no-date-here.pdf"); // null
 * ```
 */
export declare const dateInString: (str: string) => Date | null;
/**
 * Formats a date string into a human-readable format using the system locale
 *
 * Uses the Intl.DateTimeFormat API to create localized, human-readable date strings.
 * Automatically adapts to the user's system locale settings.
 *
 * @param dateString - ISO date string or any valid date string
 * @returns Human-readable date string in system locale
 * @example
 * ```typescript
 * prettyDate("2023-01-15T12:00:00Z"); // "January 15, 2023" (in English locale)
 * ```
 */
export declare const prettyDate: (dateString: string) => string;
/**
 * String pluralization utilities using the pluralize library
 *
 * Re-exports the pluralize library function for word pluralization.
 * Handles English pluralization rules including irregular forms.
 *
 * @example
 * ```typescript
 * pluralizeWord("cat"); // "cats"
 * pluralizeWord("mouse"); // "mice"
 * singularize("cats"); // "cat"
 * isPlural("cats"); // true
 * isSingular("cat"); // true
 * ```
 */
export declare const pluralizeWord: typeof pluralize;
export declare const singularize: typeof pluralize.singular;
export declare const isPlural: typeof pluralize.isPlural;
export declare const isSingular: typeof pluralize.isSingular;
/**
 * Enhanced date utilities using date-fns library
 *
 * Re-exports commonly used date-fns functions for date manipulation and formatting.
 * Provides more reliable date handling than native Date methods.
 *
 * @param date - Date object or ISO string to format
 * @param formatStr - Format string (defaults to 'yyyy-MM-dd')
 * @returns Formatted date string
 * @example
 * ```typescript
 * formatDate(new Date(), 'yyyy-MM-dd'); // "2023-01-15"
 * formatDate(new Date(), 'MM/dd/yyyy'); // "01/15/2023"
 * parseDate('2023-01-15'); // Date object
 * isValidDate(new Date()); // true
 * addInterval(new Date(), { days: 7 }); // Date 7 days from now
 * ```
 */
export declare const formatDate: (date: Date | string, formatStr?: string) => string;
export declare const parseDate: (dateStr: string, formatStr?: string) => Date;
export declare const isValidDate: typeof isValid;
export declare const addInterval: typeof add;
/**
 * Gets a temporary directory path (cross-platform)
 *
 * Creates a platform-appropriate temporary directory path under the .have-sdk namespace.
 * Uses environment variables in Node.js or falls back to /tmp.
 *
 * @param subfolder - Optional subfolder name within the temp directory
 * @returns Cross-platform temporary directory path
 * @example
 * ```typescript
 * getTempDirectory(); // "/tmp/.have-sdk" (Unix) or equivalent
 * getTempDirectory("cache"); // "/tmp/.have-sdk/cache"
 * ```
 */
export declare const getTempDirectory: (subfolder?: string) => string;
//# sourceMappingURL=universal.d.ts.map