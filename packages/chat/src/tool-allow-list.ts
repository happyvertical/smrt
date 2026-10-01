/**
 * Tool allow-list matching, shared by the server loop (which narrows the
 * browser tools a page declares) and browser hosts (which narrow what they
 * declare in the first place). No server dependencies: safe in the browser.
 */

/** Whether `name` matches an allow-list entry (exact, or `prefix*`). */
export function matchesToolAllowList(
  name: string,
  allowList: readonly string[],
): boolean {
  return allowList.some((pattern) =>
    pattern.endsWith('*')
      ? pattern.length > 1 && name.startsWith(pattern.slice(0, -1))
      : pattern === name,
  );
}
