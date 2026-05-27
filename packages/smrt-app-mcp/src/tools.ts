/**
 * Tool-name policy helpers — used by `McpAppServer` to filter the full set
 * of generated tools down to what the calling principal is allowed to see,
 * and to decide whether an unauthenticated tool call should be permitted.
 *
 * @packageDocumentation
 */

/**
 * Match a tool name against a glob-ish pattern with `*` wildcards.
 *
 * - Empty pattern → never matches.
 * - `*` → matches everything.
 * - `prefix_*` → matches anything starting with `prefix_`.
 * - `*_suffix` → matches anything ending with `_suffix`.
 * - `a_*_b` → matches any name containing `a_`, then any text, then `_b`.
 *
 * No regex characters are special besides `*` — the input is treated as a
 * literal string with star wildcards.
 */
export function matchesToolPattern(toolName: string, pattern: string): boolean {
  if (!pattern) return false;
  if (pattern === '*') return true;

  const parts = pattern.split('*');
  if (parts.length === 1) return toolName === pattern;

  let cursor = 0;
  if (parts[0] && !toolName.startsWith(parts[0])) return false;
  for (const part of parts) {
    if (!part) continue;
    const index = toolName.indexOf(part, cursor);
    if (index < 0) return false;
    cursor = index + part.length;
  }

  const last = parts.at(-1);
  return !last || toolName.endsWith(last);
}

/**
 * Read-only tool detection. Generated SMRT MCP tools follow the naming
 * convention `<class>_<verb>`; we treat `_list` and `_get` as read-only.
 */
export function isReadOnlyToolName(toolName: string): boolean {
  return toolName.endsWith('_list') || toolName.endsWith('_get');
}

/**
 * Check whether a tool name is currently allowed for unauthenticated callers
 * given the configured public-tool patterns. Only read-only tools may ever
 * be public, regardless of pattern.
 */
export function isPublicToolName(
  toolName: string,
  patterns: readonly string[],
): boolean {
  return (
    isReadOnlyToolName(toolName) &&
    patterns.some((pattern) => matchesToolPattern(toolName, pattern))
  );
}

/**
 * Lower-case `<class>_` prefixes the app considers "allowed core tools"
 * given a list of SMRT class names. Used to build the allow-list for
 * `McpAppServer.listTools`.
 */
export function classNamePrefixes(
  classNames: readonly string[],
): ReadonlySet<string> {
  return new Set(classNames.map((className) => `${className.toLowerCase()}_`));
}

/**
 * Whether a given tool name starts with any of the configured class
 * prefixes.
 */
export function isAllowedCoreTool(
  toolName: string,
  prefixes: ReadonlySet<string>,
): boolean {
  for (const prefix of prefixes) {
    if (toolName.startsWith(prefix)) return true;
  }
  return false;
}
