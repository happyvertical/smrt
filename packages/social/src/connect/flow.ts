/**
 * Provider-agnostic social account connect flow.
 *
 * `startSocialConnect` builds the authorize URL and persists a single-use,
 * tenant-bound `OAuthState`. `completeSocialConnect` verifies the callback,
 * exchanges the code, reads the profile, stores the tokens in smrt-secrets
 * (via `SocialAccount.setCredentials`) and creates or updates the account in
 * `dry_run`. The host mounts two routes, supplies the tenant, and redirects.
 * No role checks live here; authorize before calling.
 */

import { getCurrentTenant, withTenant } from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { OAuthStateCollection } from '../collections/oauth-state-collection.js';
import { SocialAccountCollection } from '../collections/social-account-collection.js';
import { OAuthState } from '../oauth-state.js';
import { getDefaultSocialAccountName } from '../server.js';
import type { SocialAccount } from '../social-account.js';
import { getSocialConnectProvider } from './registry.js';
import {
  type SocialClientCredentials,
  SocialConnectError,
  type SocialConnectProvider,
} from './types.js';

export interface SocialConnectContext {
  db: DatabaseInterface;
  /** Defaults to the current tenant context. */
  tenantId?: string;
  /**
   * The signed-in user making the request. When start supplies it, complete
   * must supply the same user or the callback is rejected before the state is
   * consumed. Hosts should always pass it.
   */
  userId?: string;
  /** Platform id from the route, e.g. `x`. */
  platform: string;
  /** The callback URL registered with the platform. */
  redirectUri: string;
  /** Explicit credentials; otherwise read from the provider's env names. */
  client?: SocialClientCredentials;
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
}

export interface StartSocialConnectOptions extends SocialConnectContext {
  scopes?: string[];
  /** State lifetime in ms. Default 10 minutes. */
  ttlMs?: number;
}

export interface CompleteSocialConnectOptions extends SocialConnectContext {
  /** The callback's query parameters. */
  query: { code?: string | null; state?: string | null; error?: string | null };
  /** Display name for a newly created account. */
  accountName?: string;
}

export interface CompletedSocialConnect {
  account: SocialAccount;
  created: boolean;
}

function resolveProvider(platform: string): SocialConnectProvider {
  const provider = getSocialConnectProvider(platform);
  if (!provider) {
    throw new SocialConnectError(
      'unsupported_platform',
      `Connecting ${platform} is not supported.`,
    );
  }
  return provider;
}

function resolveClient(
  provider: SocialConnectProvider,
  options: SocialConnectContext,
): SocialClientCredentials {
  if (options.client?.clientId && options.client.clientSecret) {
    return options.client;
  }
  const env = options.env ?? process.env;
  for (const names of [
    provider.clientEnv,
    ...(provider.clientEnvFallbacks ?? []),
  ]) {
    const clientId = env[names.clientId];
    const clientSecret = env[names.clientSecret];
    if (clientId && clientSecret) return { clientId, clientSecret };
  }
  throw new SocialConnectError(
    'missing_client_credentials',
    `${provider.label} is not configured: set ${provider.clientEnv.clientId} and ${provider.clientEnv.clientSecret}.`,
  );
}

function resolveTenantId(options: SocialConnectContext): string {
  const tenantId = options.tenantId ?? getCurrentTenant()?.tenantId;
  if (!tenantId) {
    throw new SocialConnectError(
      'missing_tenant',
      'A tenant is required to connect a social account.',
    );
  }
  return tenantId;
}

function inTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  return getCurrentTenant()?.tenantId === tenantId
    ? fn()
    : withTenant({ tenantId }, fn);
}

/** Whether the provider's client credentials are available (for UI gating). */
export function isSocialConnectConfigured(
  platform: string,
  options: Pick<SocialConnectContext, 'client' | 'env'> = {},
): boolean {
  const provider = getSocialConnectProvider(platform);
  if (!provider) return false;
  try {
    resolveClient(provider, { ...options } as SocialConnectContext);
    return true;
  } catch {
    return false;
  }
}

/** Begin a connect: returns the URL to redirect the user to. */
export async function startSocialConnect(
  options: StartSocialConnectOptions,
): Promise<{ authorizeUrl: string }> {
  const provider = resolveProvider(options.platform);
  const client = resolveClient(provider, options);
  const tenantId = resolveTenantId(options);
  const scopes = options.scopes ?? provider.defaultScopes;

  const state = OAuthState.generateState();
  const codeVerifier = provider.usesPkce
    ? OAuthState.generateCodeVerifier()
    : null;
  const codeChallenge = codeVerifier
    ? await OAuthState.generateCodeChallenge(codeVerifier)
    : undefined;

  await inTenant(tenantId, async () => {
    const states = await OAuthStateCollection.create({ db: options.db });
    await states.create({
      platform: provider.platform,
      state,
      codeVerifier,
      redirectUri: options.redirectUri,
      scopes,
      tenantId,
      initiatedByUserId: options.userId ?? null,
      expiresAt: new Date(Date.now() + (options.ttlMs ?? 10 * 60 * 1000)),
    });
  });

  return {
    authorizeUrl: provider.buildAuthorizeUrl({
      client,
      redirectUri: options.redirectUri,
      state,
      scopes,
      codeChallenge,
    }),
  };
}

/** Finish a connect from the platform's callback. */
export async function completeSocialConnect(
  options: CompleteSocialConnectOptions,
): Promise<CompletedSocialConnect> {
  const provider = resolveProvider(options.platform);
  const client = resolveClient(provider, options);
  const tenantId = resolveTenantId(options);
  const fetchImpl = options.fetch ?? fetch;
  const { code, state: stateToken, error } = options.query;

  return inTenant(tenantId, async () => {
    const states = await OAuthStateCollection.create({ db: options.db });

    // Always burn the state first when we can find it, including for a
    // refused grant, so a callback URL cannot be replayed.
    const stored = stateToken ? await states.findByState(stateToken) : null;
    if (
      !stored ||
      stored.platform !== provider.platform ||
      stored.tenantId !== tenantId ||
      stored.redirectUri !== options.redirectUri ||
      (stored.initiatedByUserId !== null &&
        stored.initiatedByUserId !== (options.userId ?? null))
    ) {
      throw new SocialConnectError(
        'invalid_state',
        'This connect link is not valid. Start the connection again.',
      );
    }
    const consumed = await states.consume(stored);
    if (!consumed) {
      throw new SocialConnectError(
        'invalid_state',
        'This connect link was already used. Start the connection again.',
      );
    }
    if (stored.isExpired) {
      throw new SocialConnectError(
        'state_expired',
        'This connect link expired. Start the connection again.',
      );
    }
    if (error) {
      throw new SocialConnectError(
        error === 'access_denied' ? 'access_denied' : 'provider_error',
        error === 'access_denied'
          ? `${provider.label} access was not granted.`
          : `${provider.label} returned an error (${error.slice(0, 64)}).`,
      );
    }
    if (!code) {
      throw new SocialConnectError(
        'provider_error',
        `${provider.label} did not return an authorization code.`,
      );
    }

    const tokens = await provider.exchangeCode({
      client,
      redirectUri: stored.redirectUri,
      code,
      codeVerifier: stored.codeVerifier,
      fetch: fetchImpl,
    });
    const profile = await provider.fetchProfile(tokens.accessToken, fetchImpl);

    const accounts = await SocialAccountCollection.create({ db: options.db });
    const [existing] = await accounts.list({
      where: {
        platform: provider.platform,
        platformUserId: profile.id,
        tenantId,
      },
      limit: 1,
    });

    const account =
      existing ??
      (await accounts.create({
        name:
          options.accountName ??
          getDefaultSocialAccountName(
            provider.platform,
            `@${profile.username}`,
          ),
        platform: provider.platform,
        tenantId,
      }));
    const created = !existing;

    account.platformUserId = profile.id;
    account.platformUsername = profile.username;
    account.platformUrl = profile.url ?? null;
    account.tokenExpiresAt = tokens.expiresAt ?? null;
    account.scopes = tokens.scopes.length ? tokens.scopes : stored.scopes;
    account.missingPermissions = [];
    account.status = 'connected';
    account.errorMessage = null;
    account.isActive = true;
    // publishMode stays as-is: new accounts start in the platform default
    // (dry_run for X); a reconnect never widens an existing account.

    // setCredentials stores the payload in smrt-secrets and saves the account.
    await account.setCredentials(
      provider.toCredentials(tokens, profile, client),
      { description: `${provider.label} credentials for @${profile.username}` },
    );
    return { account, created };
  });
}

/** Hrefs for `SocialAccountSettings`: `<basePath>/<platform>` per provider. */
export function socialConnectHrefs(
  basePath: string,
  platforms?: string[],
): Record<string, string> {
  const base = basePath.replace(/\/$/, '');
  const hrefs: Record<string, string> = {};
  for (const platform of platforms ?? ['x']) {
    if (getSocialConnectProvider(platform))
      hrefs[platform] = `${base}/${platform}`;
  }
  return hrefs;
}
