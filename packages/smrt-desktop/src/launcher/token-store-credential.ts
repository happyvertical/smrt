/**
 * Credential for the launcher from the app-runtime local MCP token store
 * (#4726): issue an owner-scoped token for the bridge to use.
 *
 * The launcher calls `release()` as soon as the bridge has started, while the
 * bridge keeps using the token for the whole session, so `release()` must not
 * revoke it. It only closes the store; the token lives until `expiresInSeconds`
 * and can be revoked earlier from the store's `list()`/`revoke()` (or
 * `smrt app token`).
 *
 * The store is injected, so this package imports nothing from
 * `@happyvertical/smrt-app-runtime`. The caller opens it (usually
 * `openLocalMcpTokenStore({ appId, dataDirectory, ... })`) and decides the
 * scopes; this helper adds no channel, no storage and no policy of its own.
 */

import { type LauncherCredential, LauncherProviderError } from './provider.js';

/** The slice of app-runtime's `OpenedLocalMcpTokenStore` this helper uses. */
export interface LauncherTokenStore {
  issue(input: {
    readonly scopes: readonly string[];
    readonly expiresInSeconds?: number;
    readonly label?: string;
  }): Promise<{ readonly id: string; readonly token: string }>;
  close(): Promise<void>;
}

export interface TokenStoreCredentialOptions {
  /** Open the store (called once per credential). */
  readonly openStore: () => Promise<LauncherTokenStore>;
  /** Permission slugs the token may use; each must be held by the owner. */
  readonly scopes: readonly string[];
  /**
   * Token lifetime in seconds (store minimum 60). It must cover the bridge
   * session: nothing refreshes or revokes it at launcher exit. Default 8 hours.
   */
  readonly expiresInSeconds?: number;
  /** Operator note shown by `list()` (at most 80 characters). */
  readonly label?: string;
}

const DEFAULT_EXPIRES_IN_SECONDS = 8 * 60 * 60;

/**
 * Issue a token and return it as a {@link LauncherCredential}. `release()`
 * closes the store (it does NOT revoke the token) and is safe to call twice. A
 * store that cannot be opened or issues nothing is `credential_unavailable`.
 */
export async function acquireTokenStoreCredential(
  options: TokenStoreCredentialOptions,
): Promise<LauncherCredential> {
  let store: LauncherTokenStore;
  try {
    store = await options.openStore();
  } catch {
    throw new LauncherProviderError('credential_unavailable');
  }
  let issued: { readonly id: string; readonly token: string };
  try {
    issued = await store.issue({
      scopes: options.scopes,
      expiresInSeconds: options.expiresInSeconds ?? DEFAULT_EXPIRES_IN_SECONDS,
      ...(options.label === undefined ? {} : { label: options.label }),
    });
  } catch {
    await store.close().catch(() => undefined);
    throw new LauncherProviderError('credential_unavailable');
  }
  let released = false;
  return {
    token: issued.token,
    async release() {
      if (released) return;
      released = true;
      await store.close().catch(() => undefined);
    },
  };
}
