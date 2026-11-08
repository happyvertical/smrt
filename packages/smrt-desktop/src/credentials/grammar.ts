/**
 * Lexical grammars for the credential handoff. Pure and total over `unknown`,
 * no Node built-ins: the browser-safe `./webview` entry imports this file.
 */

const mcpToken = /^smrt_mcp_[A-Za-z0-9_-]{43}$/;
const scopeSlug = /^[\x21\x23-\x5b\x5d-\x7e]+$/;
const instanceNonce = /^[0-9a-f]{32}$/;
const secretItemName = /^[a-z0-9][a-z0-9.-]{0,127}$/;

/** Shortest remaining lifetime a freshly minted credential may have. */
export const MIN_CREDENTIAL_LIFETIME_MS = 60_000;
/** Most scopes a slot may carry (the server limit). */
export const MAX_SCOPES = 64;
/** Longest scope slug (the server limit). */
export const MAX_SCOPE_LENGTH = 128;
/** Prefix of every item the credential custody writes to the secret store. */
export const CREDENTIAL_ITEM_PREFIX = 'mcp-credential.';

/** A local MCP bearer: `smrt_mcp_` plus 43 base64url characters. */
export function isMcpToken(value: unknown): value is string {
  return typeof value === 'string' && mcpToken.test(value);
}

/**
 * One permission slug as the server accepts it: printable ASCII without
 * space, `"` and `\`, at most 128 characters.
 */
export function isScopeSlug(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= MAX_SCOPE_LENGTH &&
    scopeSlug.test(value)
  );
}

/** A non-empty list of distinct scope slugs, at most 64. */
export function isScopeList(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= MAX_SCOPES &&
    value.every(isScopeSlug) &&
    new Set(value).size === value.length
  );
}

/** The 32-lowercase-hex per-process instance nonce. */
export function isInstanceNonce(value: unknown): value is string {
  return typeof value === 'string' && instanceNonce.test(value);
}

/** Secret-store item names (the shape the vault-key store uses). */
export function isSecretItemName(value: unknown): value is string {
  return typeof value === 'string' && secretItemName.test(value);
}
