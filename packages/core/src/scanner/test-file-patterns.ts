/**
 * Shared test file detection utilities
 *
 * These patterns are used to identify test files for visibility auto-detection.
 * Consolidated here to avoid duplication between ast-scanner.ts and manifest-generator.ts.
 */

/**
 * Patterns that identify test files (used for auto-detecting test visibility)
 */
export const TEST_FILE_PATTERNS = [
  /__tests__\//,
  /\.test\.(ts|tsx|js|jsx)$/,
  /\.spec\.(ts|tsx|js|jsx)$/,
  /\/test\//i,
  /fixtures?\//i,
  /\/mocks?\//i,
];

/**
 * Check if a file path indicates a test file
 *
 * @param filePath - The file path to check
 * @returns true if the file appears to be a test file
 */
export function isTestFile(filePath: string): boolean {
  return TEST_FILE_PATTERNS.some((pattern) => pattern.test(filePath));
}
