/**
 * The kitchen token arrives in the address, never in a file the server serves.
 * `smrt kitchen` opens `http://127.0.0.1:<port>/#kitchen=<token>`: a fragment is
 * never sent to a server, so no endpoint (and no other local process sending
 * the right `Host`) can read it from `planner.config.json`. The page reads the
 * fragment once at startup, keeps the token in memory only, and removes the
 * `kitchen` parameter from the address (`replaceState`) so it is not left in
 * the history entry either.
 */

/** The fragment key the token is under. */
export const KITCHEN_FRAGMENT_KEY = 'kitchen';

/** URL-safe characters only (RFC 3986 unreserved): what `base64url` and hex produce. */
const TOKEN = /^[A-Za-z0-9._~-]{1,256}$/;

export interface KitchenFragment {
  /** The token, when the fragment carried a usable one. */
  token?: string;
  /** True when the fragment had a `kitchen` parameter (usable or not) to strip. */
  present: boolean;
  /**
   * The fragment without the `kitchen` parameter, as it belongs in the address:
   * `''` or `#other=1`. Other parameters are kept.
   */
  hash: string;
}

/**
 * Read `location.hash` (with or without the `#`). Never throws. Only the
 * `kitchen` parameter is touched: every other part of the fragment is returned
 * exactly as it was (no re-encoding), so an in-page anchor survives. The token
 * is read raw (it must already be URL-safe), so a percent-encoded or `+`-spaced
 * value is not a token; the parameter is removed all the same.
 */
export function readKitchenFragment(hash: string): KitchenFragment {
  const text = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!text) return { present: false, hash: '' };
  let token: string | undefined;
  let present = false;
  const kept: string[] = [];
  for (const part of text.split('&')) {
    const equals = part.indexOf('=');
    const key = equals < 0 ? part : part.slice(0, equals);
    if (key !== KITCHEN_FRAGMENT_KEY) {
      kept.push(part);
      continue;
    }
    // The first `kitchen` wins; all of them are removed.
    if (!present && equals >= 0) {
      const value = part.slice(equals + 1);
      if (TOKEN.test(value)) token = value;
    }
    present = true;
  }
  const rest = kept.filter((part) => part !== '').join('&');
  return {
    ...(token ? { token } : {}),
    present,
    hash: rest ? `#${rest}` : '',
  };
}
