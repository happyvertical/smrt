/**
 * Mailbox connect through a generic OAuth 2.0 / OIDC provider, on the shared
 * credential connect kernel in `@happyvertical/smrt-secrets/connect`.
 *
 * A mail server's own OAuth (for example a self-hosted Stalwart) issues the
 * token: the host describes it as a {@link MailOAuthProvider} (issuer or
 * explicit endpoints, scopes, and the non-secret account configuration such as
 * the JMAP or IMAP endpoint) and mounts two routes that call
 * {@link startMailOAuthConnect} and {@link completeMailOAuthConnect}. The
 * single-use state is bound to the tenant and to the signed-in user, who
 * becomes the account owner. Tokens go to smrt-secrets, never to columns.
 *
 * No role checks live here: authorize the user before calling.
 *
 * @packageDocumentation
 */

import {
  ObjectRegistry,
  type SmrtClassOptions,
} from '@happyvertical/smrt-core';
import {
  beginConnect,
  buildOAuth2AuthorizeUrl,
  ConnectError,
  ConnectStateCollection,
  consumeConnect,
  discoverOidcEndpoints,
  exchangeOAuth2Code,
  fetchOidcUserInfo,
  type OAuth2Endpoints,
  type OAuthClientCredentials,
} from '@happyvertical/smrt-secrets/connect';
import { EmailAccountCollection } from './collections/EmailAccountCollection.js';
import { withTenant } from './host.js';
import { EmailAccount } from './models/EmailAccount.js';
import type { ProviderType } from './types.js';

export { ConnectError };

/** How one mail server's OAuth is reached. Built by the host. */
export interface MailOAuthProvider {
  /** Stable key for this server, for example `stalwart`. */
  id: string;
  /** Shown in user-facing messages. */
  label: string;
  /** OIDC issuer for discovery; or give `endpoints`. */
  issuer?: string;
  endpoints?: OAuth2Endpoints;
  scopes: string[];
  clientAuth?: 'basic' | 'post';
  authorizeParams?: Record<string, string>;
  /** The registered messaging provider the account uses (`imap`, `smtp`, ...). */
  messagingProviderId: string;
  /** Non-secret account settings: this account's own endpoint. */
  configuration: Record<string, unknown>;
}

interface MailConnectContext {
  options: SmrtClassOptions;
  tenantId: string;
  /** The signed-in user. Required: they become the owner. */
  userId: string;
  provider: MailOAuthProvider;
  client: OAuthClientCredentials;
  /** The callback URL registered with the mail server's OAuth. */
  redirectUri: string;
  fetch?: typeof fetch;
}

export interface StartMailOAuthConnectOptions extends MailConnectContext {
  /** Same-origin path to return to after the callback. */
  returnTo?: string;
  scopes?: string[];
  /** State lifetime in ms. Default 10 minutes. */
  ttlMs?: number;
}

export interface CompleteMailOAuthConnectOptions extends MailConnectContext {
  query: { code?: string | null; state?: string | null; error?: string | null };
  /** Display name for a newly created account. Defaults to the address. */
  name?: string;
  label?: string | null;
}

export interface CompletedMailOAuthConnect {
  account: EmailAccount;
  created: boolean;
  /** The same-origin path stored at start, for the host to redirect to. */
  returnTo: string | null;
}

const kindOf = (provider: MailOAuthProvider) => `mail:${provider.id}`;

function requireContext(options: MailConnectContext): void {
  if (!options.tenantId) {
    throw new ConnectError(
      'missing_tenant',
      'A tenant is required to connect a mailbox.',
    );
  }
  if (!options.userId) {
    throw new ConnectError('forbidden', 'Sign in before connecting a mailbox.');
  }
  if (!options.client.clientId || !options.client.clientSecret) {
    throw new ConnectError(
      'missing_client_credentials',
      `${options.provider.label} is not configured with an OAuth client.`,
    );
  }
}

async function resolveEndpoints(
  options: MailConnectContext,
): Promise<OAuth2Endpoints> {
  const { provider } = options;
  if (provider.endpoints) return provider.endpoints;
  if (!provider.issuer) {
    throw new ConnectError(
      'discovery_failed',
      `${provider.label} has no issuer or endpoints configured.`,
    );
  }
  return discoverOidcEndpoints(
    provider.issuer,
    provider.label,
    options.fetch ?? fetch,
  );
}

/** Begin a connect: returns the URL to redirect the user to. */
export async function startMailOAuthConnect(
  options: StartMailOAuthConnectOptions,
): Promise<{ authorizeUrl: string }> {
  requireContext(options);
  const endpoints = await resolveEndpoints(options);
  const scopes = options.scopes ?? options.provider.scopes;
  return withTenant({ tenantId: options.tenantId }, async () => {
    const store = (
      await ConnectStateCollection.create(options.options)
    ).asStore();
    const { state, codeChallenge } = await beginConnect({
      store,
      kind: kindOf(options.provider),
      tenantId: options.tenantId,
      userId: options.userId,
      redirectUri: options.redirectUri,
      scopes,
      usesPkce: true,
      returnTo: options.returnTo,
      ttlMs: options.ttlMs,
    });
    return {
      authorizeUrl: buildOAuth2AuthorizeUrl(
        {
          label: options.provider.label,
          clientAuth: options.provider.clientAuth,
          authorizeParams: options.provider.authorizeParams,
          ...endpoints,
        },
        {
          client: options.client,
          redirectUri: options.redirectUri,
          state,
          scopes,
          codeChallenge,
        },
      ),
    };
  });
}

/**
 * Finish a connect from the mail server's callback. Creates the account owned
 * by the signed-in user, or reconnects one that user already owns; an account
 * owned by someone else (or by no one) is never taken over this way.
 */
export async function completeMailOAuthConnect(
  options: CompleteMailOAuthConnectOptions,
): Promise<CompletedMailOAuthConnect> {
  requireContext(options);
  const { provider } = options;
  const fetchImpl = options.fetch ?? fetch;
  return withTenant({ tenantId: options.tenantId }, async () => {
    const store = (
      await ConnectStateCollection.create(options.options)
    ).asStore();
    const { record, code } = await consumeConnect({
      store,
      kind: kindOf(provider),
      tenantId: options.tenantId,
      userId: options.userId,
      redirectUri: options.redirectUri,
      query: options.query,
      label: provider.label,
    });
    const endpoints = await resolveEndpoints(options);
    const config = {
      label: provider.label,
      clientAuth: provider.clientAuth,
      ...endpoints,
    };
    const tokens = await exchangeOAuth2Code(config, {
      client: options.client,
      redirectUri: record.redirectUri,
      code,
      codeVerifier: record.codeVerifier,
      fetch: fetchImpl,
    });
    const profile = await fetchOidcUserInfo(
      config,
      tokens.accessToken,
      fetchImpl,
    );
    const address = profile.email ?? profile.preferredUsername;
    if (!address) {
      throw new ConnectError(
        'profile_lookup_failed',
        `${provider.label} did not say which mailbox this is.`,
      );
    }

    const accounts = await EmailAccountCollection.create(options.options);
    const matches = (await accounts.list({
      where: {
        tenantId: options.tenantId,
        providerType: provider.messagingProviderId,
        email: address,
      },
    })) as EmailAccount[];
    // Reconnect the signed-in user's own account; any other match (someone
    // else's, or an ownerless legacy account) is never taken over this way.
    const existing = matches.find(
      (match) => match.ownerUserId === options.userId,
    );
    if (!existing && matches.length) {
      throw new ConnectError(
        'forbidden',
        'This mailbox is already connected by someone else.',
      );
    }

    const account =
      existing ??
      new (ObjectRegistry.resolveEffectiveConstructor(EmailAccount))({
        ...options.options,
        tenantId: options.tenantId,
        name: options.name?.trim() || address,
        email: address,
        providerType: provider.messagingProviderId as ProviderType,
        ownerUserId: options.userId,
      });
    if (!existing) await account.initialize();
    if (options.label !== undefined) {
      account.label = options.label?.trim() || null;
    }
    account.setConfiguration({ ...provider.configuration, email: address });
    account.isActive = true;
    account.connectionStatus = 'connected';
    account.statusMessage = null;
    account.updatedAt = new Date();
    await account.save();
    // The client secret travels with the token so a sync can refresh it.
    await account.setCredentials(
      {
        authType: 'oauth2',
        accessToken: tokens.accessToken,
        ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
        ...(tokens.tokenType ? { tokenType: tokens.tokenType } : {}),
        ...(tokens.expiresAt
          ? { expiresAt: tokens.expiresAt.toISOString() }
          : {}),
        scopes: tokens.scopes.length ? tokens.scopes : record.scopes,
        tokenUrl: endpoints.tokenUrl,
        clientId: options.client.clientId,
        clientSecret: options.client.clientSecret,
        username: address,
      },
      { description: `${provider.label} sign-in for ${address}` },
    );
    return {
      account,
      created: !existing,
      returnTo: record.returnTo ?? null,
    };
  });
}
