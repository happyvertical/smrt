/**
 * Universal utilities that work in both browser and Node.js environments
 */

import { createId as cuid2CreateId, isCuid } from '@paralleldrive/cuid2';
import { add, format, isValid, parse, parseISO } from 'date-fns';
import pluralize from 'pluralize';
import { ParsingError, TimeoutError } from './types';

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
export const makeId = (type: 'cuid2' | 'uuid' = 'cuid2'): string => {
  if (type === 'cuid2') {
    return cuid2CreateId();
  }

  // UUID fallback
  if (crypto?.randomUUID) {
    return crypto.randomUUID();
  }

  // Manual UUID fallback for older environments
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
};

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
export const createId = cuid2CreateId;

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
export const makeSlug = (str: string): string => {
  const from =
    'àáâäæãåāăąçćčđďèéêëēėęěğǵḧîïíīįìıİłḿñńǹňôöòóœøōõőṕŕřßśšşșťțûüùúūǘůűųẃẍÿýžźż+·/_,:;';
  const to =
    'aaaaaaaaaacccddeeeeeeeegghiiiiiiiilmnnnnoooooooooprrsssssttuuuuuuuuuwxyyzzz--------------';
  const textToCompare = new RegExp(
    from.split('').join('|').replace(/\+/g, '\\+'),
    'g',
  );

  return str
    .toString()
    .toLowerCase()
    .replace('&', '-38-')
    .replace(/\s+/g, '-')
    .replace(textToCompare, (c) => to.charAt(from.indexOf(c)))
    .replace(/[&.]/g, '-')
    .replace(/[^\w-º+]+/g, '')
    .replace(/--+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
};

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
export const urlFilename = (url: string): string => {
  const parsedUrl = new URL(url);
  const pathSegments = parsedUrl.pathname.split('/');
  const filename = pathSegments[pathSegments.length - 1];
  return filename || 'index.html';
};

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
export const urlPath = (url: string): string => {
  const parsedUrl = new URL(url);
  const pathSegments = [
    parsedUrl.hostname,
    ...parsedUrl.pathname.split('/').filter(Boolean),
  ];
  return pathSegments.join('/');
};

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
export const sleep = (duration: number): Promise<void> => {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, duration);
  });
};

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
export function waitFor(
  it: () => Promise<any>,
  { timeout = 0, delay = 1000 }: { timeout?: number; delay?: number } = {},
): Promise<any> {
  return new Promise((resolve, reject) => {
    const beginTime = Date.now();

    (async function waitATick() {
      try {
        const result = await it();
        if (typeof result !== 'undefined') {
          return resolve(result);
        }

        if (timeout > 0) {
          if (Date.now() > beginTime + timeout) {
            return reject(
              new TimeoutError('Function call timed out', {
                timeout,
                delay,
                elapsedTime: Date.now() - beginTime,
              }),
            );
          }
        }

        setTimeout(waitATick, delay);
      } catch (error) {
        reject(error);
      }
    })();
  });
}

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
export const isArray = (obj: unknown): obj is unknown[] => {
  return Array.isArray(obj);
};

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
export const isPlainObject = (obj: unknown): obj is Record<string, unknown> => {
  return typeof obj === 'object' && obj !== null && !Array.isArray(obj);
};

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
export const isUrl = (url: string): boolean => {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
};

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
export const camelCase = (str: string): string => {
  return str
    .toLowerCase()
    .replace(/[-_]+/g, ' ')
    .replace(/[^\w\s]/g, '')
    .replace(/\s(.)/g, (_, char) => char.toUpperCase())
    .replace(/\s/g, '')
    .replace(/^(.)/, (_, char) => char.toLowerCase());
};

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
export const snakeCase = (str: string): string => {
  return str
    .replace(/([A-Z])/g, '_$1')
    .toLowerCase()
    .replace(/^_/, '')
    .replace(/[-\s]+/g, '_');
};

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
export const keysToCamel = (obj: unknown): unknown => {
  if (isPlainObject(obj)) {
    const n: Record<string, unknown> = {};
    Object.keys(obj).forEach((k) => {
      n[camelCase(k)] = keysToCamel(obj[k]);
    });
    return n;
  }
  if (isArray(obj)) {
    return obj.map((i) => keysToCamel(i));
  }
  return obj;
};

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
export const keysToSnake = (obj: unknown): unknown => {
  if (isPlainObject(obj)) {
    const n: Record<string, unknown> = {};
    Object.keys(obj).forEach((k) => {
      n[snakeCase(k)] = keysToSnake(obj[k]);
    });
    return n;
  }
  if (isArray(obj)) {
    return obj.map((i) => keysToSnake(i));
  }
  return obj;
};

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
export const domainToCamel = (domain: string): string => camelCase(domain);

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
export const logTicker = (
  tick: string | null,
  options: { chars?: string[] } = {},
): string => {
  const { chars = ['.', '..', '...'] } = options;
  if (tick) {
    const index = chars.indexOf(tick);
    return index + 1 >= chars.length ? chars[0] : chars[index + 1];
  }
  return chars[0];
};

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
export const parseAmazonDateString = (dateStr: string): Date => {
  const regex =
    /^([0-9]{4})([0-9]{2})([0-9]{2})T([0-9]{2})([0-9]{2})([0-9]{2})([A-Z0-9]+)/;
  const match = dateStr.match(regex);
  if (!match) {
    throw new ParsingError('Could not parse Amazon date string', {
      dateString: dateStr,
      expectedFormat: 'YYYYMMDDTHHMMSSZ',
    });
  }

  const [matched, year, month, day, hour, minutes, seconds, timezone] = match;
  if (matched !== dateStr) {
    throw new ParsingError('Invalid Amazon date string format', {
      dateString: dateStr,
      matched,
      expectedFormat: 'YYYYMMDDTHHMMSSZ',
    });
  }

  const date = new Date(
    `${year}-${month}-${day}T${hour}:${minutes}:${seconds}${timezone}`,
  );
  return date;
};

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
export const dateInString = (str: string): Date | null => {
  const cleanStr = str.toLowerCase();

  // Try underscore-separated dates first (YYYY_MM_DD)
  // Used by DocuShare document management systems
  const underscoreMatch = str.match(/(\d{4})_(\d{1,2})_(\d{1,2})/);
  if (underscoreMatch) {
    const [, year, month, day] = underscoreMatch;
    const date = new Date(
      Number.parseInt(year, 10),
      Number.parseInt(month, 10) - 1,
      Number.parseInt(day, 10),
    );
    if (!Number.isNaN(date.getTime())) return date;
  }

  // Try US dot format (MM.DD.YYYY)
  // Used by DocuShare file naming conventions
  const dotMatch = str.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (dotMatch) {
    const [, month, day, year] = dotMatch;
    const date = new Date(
      Number.parseInt(year, 10),
      Number.parseInt(month, 10) - 1,
      Number.parseInt(day, 10),
    );
    if (!Number.isNaN(date.getTime())) return date;
  }

  // Try standard date formats (ISO, US, etc.)
  // Pattern: YYYY-MM-DD or YYYY/MM/DD
  const isoMatch = cleanStr.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (isoMatch) {
    const [, year, month, day] = isoMatch;
    const date = new Date(
      Number.parseInt(year, 10),
      Number.parseInt(month, 10) - 1,
      Number.parseInt(day, 10),
    );
    if (!Number.isNaN(date.getTime())) return date;
  }

  // Pattern: MM/DD/YYYY or MM-DD-YYYY
  const usMatch = cleanStr.match(/(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
  if (usMatch) {
    const [, month, day, year] = usMatch;
    const date = new Date(
      Number.parseInt(year, 10),
      Number.parseInt(month, 10) - 1,
      Number.parseInt(day, 10),
    );
    if (!Number.isNaN(date.getTime())) return date;
  }

  // Try to extract date from natural language (month name + day + year)
  const yearMatch = cleanStr.match(/20\d{2}/);
  if (!yearMatch) return null;
  const year = Number.parseInt(yearMatch[0], 10);

  const monthPatterns: Record<string, number> = {
    january: 1,
    jan: 1,
    february: 2,
    feb: 2,
    march: 3,
    mar: 3,
    april: 4,
    apr: 4,
    may: 5,
    june: 6,
    jun: 6,
    july: 7,
    jul: 7,
    august: 8,
    aug: 8,
    september: 9,
    sep: 9,
    sept: 9,
    october: 10,
    oct: 10,
    november: 11,
    nov: 11,
    december: 12,
    dec: 12,
  };

  let foundMonth: number | null = null;
  let monthStart = -1;
  let monthName = '';

  // Find the first month name in the string
  for (const [name, monthNum] of Object.entries(monthPatterns)) {
    const monthIndex = cleanStr.indexOf(name);
    if (monthIndex !== -1) {
      foundMonth = monthNum;
      monthStart = monthIndex;
      monthName = name;
      break;
    }
  }

  if (!foundMonth) return null;

  // Look for day number near the month name or year (before or after)
  // Search window: [month-15 chars] MONTH [month+15 chars] ... [year-15 chars] YEAR [year+15 chars]
  const yearIndex = cleanStr.indexOf(yearMatch[0]);

  const beforeMonth = cleanStr.substring(
    Math.max(0, monthStart - 15),
    monthStart,
  );
  const afterMonth = cleanStr.substring(
    monthStart + monthName.length,
    Math.min(cleanStr.length, monthStart + monthName.length + 15),
  );
  const beforeYear = cleanStr.substring(
    Math.max(0, yearIndex - 15),
    yearIndex,
  );
  const afterYear = cleanStr.substring(
    yearIndex + 4,
    Math.min(cleanStr.length, yearIndex + 19),
  );

  // Try to find day number (1-31) - avoiding matching digits from the year itself
  // Look for day numbers that are isolated (not part of a longer number like "2023")
  const dayMatch =
    beforeMonth.match(/(?<!\d)(\d{1,2})\s*$/) || // Day before month (not preceded by another digit)
    afterMonth.match(/^\s*(\d{1,2})(?!\d)/) || // Day right after month (not followed by another digit)
    beforeYear.match(/(?<!\d)(\d{1,2})\s*$/) || // Day before year (not preceded by another digit)
    afterYear.match(/^\s*(\d{1,2})(?!\d)/) || // Day right after year (not followed by another digit)
    afterMonth.match(/[^\d](\d{1,2})(?!\d)/); // Day with non-digit before and after in month area

  const day = dayMatch ? Number.parseInt(dayMatch[1], 10) : 1; // Default to 1st if no day found

  // Validate day is in reasonable range
  if (day < 1 || day > 31) return null;

  const date = new Date(year, foundMonth - 1, day);
  return !Number.isNaN(date.getTime()) ? date : null;
};

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
export const prettyDate = (dateString: string): string => {
  const date = new Date(dateString);
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(date);
};

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
export const pluralizeWord = pluralize;
export const singularize = pluralize.singular;
export const isPlural = pluralize.isPlural;
export const isSingular = pluralize.isSingular;

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
export const formatDate = (
  date: Date | string,
  formatStr = 'yyyy-MM-dd',
): string => {
  const dateObj = typeof date === 'string' ? new Date(date) : date;
  return format(dateObj, formatStr);
};

export const parseDate = (dateStr: string, formatStr?: string): Date => {
  if (formatStr) {
    return parse(dateStr, formatStr, new Date());
  }
  return parseISO(dateStr);
};

export const isValidDate = isValid;
export const addInterval = add;

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
export const getTempDirectory = (subfolder?: string): string => {
  // Use Node.js os.tmpdir() or fallback
  const tmpBase = process?.env
    ? process.env.TMPDIR || process.env.TMP || process.env.TEMP || '/tmp'
    : '/tmp';

  const basePath = `${tmpBase}/.have-sdk`;
  return subfolder ? `${basePath}/${subfolder}` : basePath;
};
