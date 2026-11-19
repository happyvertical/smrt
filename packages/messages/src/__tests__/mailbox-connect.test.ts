/**
 * Provider-neutral mailbox connect (#5128): a write-only app password and a
 * generic OAuth 2.0 / OIDC flow, both storing the credential in smrt-secrets
 * and creating an owned account with its own endpoint and label. HIGH-RISK
 * area (secrets, auth), so refusals, replays, takeovers and leaks are tested
 * alongside the happy paths.
 */

import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetMailAccess } from '../access.js';
import {
  ConnectError,
  completeMailOAuthConnect,
  type MailOAuthProvider,
  startMailOAuthConnect,
} from '../connect.js';
import {
  AccountCollection,
  EmailAccountCollection,
  EmailCollection,
  messagingPrincipalFromPermissions,
  registerMessagingProvider,
} from '../index.js';
import { Email } from '../models/Email';
import { EmailAccount, isMailAuthFailure } from '../models/EmailAccount';
import { MANAGE_MESSAGE_CREDENTIALS_PERMISSION } from '../permissions.js';
import { MessagingSettingsService } from '../services/MessagingSettingsService.js';
import { prepareMessageParents } from './fk-fixtures.js';

const TEST_AMK =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const TENANT = 'tenant-a';
const REDIRECT = 'https://work.example.com/settings/mail/callback';
const PASSWORD = 'app-password-hunter2';

describe('mailbox connect', () => {
  let db: DatabaseInterface;
  let unregister: () => void;

  beforeEach(async () => {
    process.env.SMRT_SECRET_MASTER_KEY = TEST_AMK;
    db = await getTestDatabase({
      classes: [
        'Account',
        'EmailAccount',
        'Message',
        'Email',
        'EmailFolder',
        'Attachment',
        'ConnectState',
        'Secret',
        'SecretAuditLog',
        'TenantKey',
      ],
    });
    await prepareMessageParents(db);
    enableTenancy();
    unregister = registerMessagingProvider({
      id: 'jmap-test',
      label: 'JMAP (test)',
      channel: 'email',
      available: true,
      configurationFields: [
        { id: 'endpoint', label: 'JMAP endpoint', type: 'url', required: true },
        { id: 'email', label: 'Address', type: 'email', required: true },
      ],
      credentialFields: [
        { id: 'username', label: 'Username', type: 'string', required: true },
        {
          id: 'password',
          label: 'App password',
          type: 'password',
          required: true,
        },
      ],
      endpointFields: [],
    });
  });

  afterEach(async () => {
    resetMailAccess();
    unregister();
    disableTenancy();
    delete process.env.SMRT_SECRET_MASTER_KEY;
    await db.close?.();
  });

  const service = (
    userId: string | undefined,
    overrides: {
      permissions?: string[];
      tenantId?: string;
      validateMailbox?: (request: unknown) => Promise<void>;
    } = {},
  ) =>
    new MessagingSettingsService({
      db,
      tenantId: overrides.tenantId ?? TENANT,
      principal: messagingPrincipalFromPermissions(
        overrides.permissions ?? [MANAGE_MESSAGE_CREDENTIALS_PERMISSION],
        { id: userId, tenantId: overrides.tenantId ?? TENANT },
      ),
      resolvePersonaTenantId: async () => null,
      validateMailbox: overrides.validateMailbox as never,
    });

  const connect = (
    svc: MessagingSettingsService,
    host = 'mail.example.com',
    extra: Record<string, unknown> = {},
  ) =>
    svc.connectMailbox({
      name: `Mail on ${host}`,
      label: 'Personal',
      providerId: 'jmap-test',
      configuration: {
        endpoint: `https://${host}/jmap`,
        email: `me@${host}`,
      },
      credentials: { username: `me@${host}`, password: PASSWORD },
      ...extra,
    });

  describe('app password', () => {
    it('validates, stores the secret write-only, and creates an owned account with its own endpoint and label', async () => {
      const validate = vi.fn(async () => undefined);
      const view = await connect(
        service('user-1', { validateMailbox: validate }),
      );
      expect(validate).toHaveBeenCalledTimes(1);
      expect(view).toMatchObject({
        ownerUserId: 'user-1',
        label: 'Personal',
        connectionStatus: 'connected',
        hasCredentials: true,
        active: true,
        configuration: { endpoint: 'https://mail.example.com/jmap' },
      });
      // The view and the row never carry the secret.
      expect(JSON.stringify(view)).not.toContain(PASSWORD);
      const account = await withTenant({ tenantId: TENANT }, async () =>
        (await EmailAccountCollection.create({ db })).get({ id: view.id }),
      );
      expect(account?.settings).toBe('');
      expect(JSON.stringify(account?.toJSON())).not.toContain(PASSWORD);
      expect(account?.credentialSecretId).toBeTruthy();
      const stored = await withTenant({ tenantId: TENANT }, () =>
        account?.getCredentials(),
      );
      expect(stored).toMatchObject({
        auth: { user: 'me@mail.example.com', pass: PASSWORD },
      });
    });

    it('lets one owner connect several accounts on different servers', async () => {
      const svc = service('user-1', { validateMailbox: async () => undefined });
      const a = await connect(svc, 'one.example.com');
      const b = await connect(svc, 'two.example.com');
      expect(a.id).not.toBe(b.id);
      expect(a.configuration.endpoint).toBe('https://one.example.com/jmap');
      expect(b.configuration.endpoint).toBe('https://two.example.com/jmap');
    });

    it('leaves no account and no secret when the server refuses, and never echoes the password', async () => {
      const svc = service('user-1', {
        validateMailbox: async () => {
          throw new Error(`login failed for password ${PASSWORD}`);
        },
      });
      const error = await connect(svc).catch((e) => e as Error);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/did not accept/);
      expect((error as Error).message).not.toContain(PASSWORD);
      const rows = await withTenant({ tenantId: TENANT }, async () => {
        const accounts = await AccountCollection.create({ db });
        return accounts.list({});
      });
      expect(
        rows.filter((row) => row.providerType === 'jmap-test'),
      ).toHaveLength(0);
    });

    it('refuses without the credentials permission, across tenants, and for invalid fields', async () => {
      const validateMailbox = async () => undefined;
      await expect(
        connect(service('user-1', { permissions: [], validateMailbox })),
      ).rejects.toThrow(/permission/);
      await expect(
        connect(
          new MessagingSettingsService({
            db,
            tenantId: TENANT,
            principal: messagingPrincipalFromPermissions(
              [MANAGE_MESSAGE_CREDENTIALS_PERMISSION],
              { id: 'user-1', tenantId: 'tenant-b' },
            ),
            resolvePersonaTenantId: async () => null,
            validateMailbox,
          }),
        ),
      ).rejects.toThrow(/tenant/);
      await expect(
        service('user-1', { validateMailbox }).connectMailbox({
          name: 'x',
          providerId: 'jmap-test',
          configuration: { endpoint: 'https://x', email: 'a@b.c', sneaky: 1 },
          credentials: { username: 'u', password: 'p' },
        }),
      ).rejects.toThrow(/Unknown configuration field/);
    });

    it('refuses to create an ownerless mailbox, and reconnect of an unknown id', async () => {
      const validateMailbox = async () => undefined;
      await expect(
        connect(service(undefined, { validateMailbox })),
      ).rejects.toThrow(/signed-in user/);
      await expect(
        connect(service('user-1', { validateMailbox }), 'mail.example.com', {
          id: 'does-not-exist',
        }),
      ).rejects.toThrow(/not found/);
      const rows = await withTenant({ tenantId: TENANT }, async () =>
        (await AccountCollection.create({ db })).list({}),
      );
      expect(
        rows.filter((row) => row.providerType === 'jmap-test'),
      ).toHaveLength(0);
    });

    it('uses the principal’s user id, not its credential id, as owner', async () => {
      const svc = new MessagingSettingsService({
        db,
        tenantId: TENANT,
        principal: messagingPrincipalFromPermissions(
          [MANAGE_MESSAGE_CREDENTIALS_PERMISSION],
          { id: 'credential-9', userId: 'user-9', tenantId: TENANT },
        ),
        resolvePersonaTenantId: async () => null,
        validateMailbox: async () => undefined,
      });
      expect((await connect(svc)).ownerUserId).toBe('user-9');
    });

    it('reconnects only the owner’s own account, replacing the secret', async () => {
      const validateMailbox = async () => undefined;
      const owner = service('user-1', { validateMailbox });
      const view = await connect(owner);
      await connect(owner, 'mail.example.com', {
        id: view.id,
        credentials: {
          username: 'me@mail.example.com',
          password: 'rotated-secret-1',
        },
      });
      const account = await withTenant({ tenantId: TENANT }, async () =>
        (await EmailAccountCollection.create({ db })).get({ id: view.id }),
      );
      expect(
        await withTenant({ tenantId: TENANT }, () => account?.getCredentials()),
      ).toMatchObject({ auth: { pass: 'rotated-secret-1' } });
      await expect(
        connect(service('user-2', { validateMailbox }), 'mail.example.com', {
          id: view.id,
        }),
      ).rejects.toThrow(/owner/);
    });

    it('pauses, resumes and removes, deleting the secret and the synced mail; only the owner may', async () => {
      const validateMailbox = async () => undefined;
      const owner = service('user-1', { validateMailbox });
      const view = await connect(owner);
      await withTenant({ tenantId: TENANT }, async () => {
        const email = new Email({
          db,
          tenantId: TENANT,
          accountId: view.id,
          subject: 'synced',
        });
        await email.initialize();
        await email.save();
      });
      expect((await owner.setAccountActive(view.id, false)).active).toBe(false);
      expect((await owner.setAccountActive(view.id, true)).active).toBe(true);
      const other = service('user-2', { validateMailbox });
      await expect(other.setAccountActive(view.id, false)).rejects.toThrow(
        /owner/,
      );
      await expect(other.removeAccount(view.id)).rejects.toThrow(/owner/);

      const secretName = await withTenant({ tenantId: TENANT }, async () =>
        (await AccountCollection.create({ db })).get({ id: view.id }),
      ).then((row) => row?.credentialSecretId as string);
      await owner.removeAccount(view.id);
      await withTenant({ tenantId: TENANT }, async () => {
        expect(
          await (await AccountCollection.create({ db })).get({ id: view.id }),
        ).toBeNull();
        expect(
          await (await EmailCollection.create({ db })).list({}),
        ).toHaveLength(0);
        const { SecretService } = await import('@happyvertical/smrt-secrets');
        const secrets = await SecretService.create({ db });
        expect(await secrets.exists(secretName)).toBe(false);
      });
    });

    it('does not let saveAccount change another person’s owned mailbox or its owner', async () => {
      const validateMailbox = async () => undefined;
      const view = await connect(service('user-1', { validateMailbox }));
      await expect(
        service('user-2').saveAccount({
          id: view.id,
          name: 'hijack',
          providerId: 'jmap-test',
          configuration: view.configuration,
        }),
      ).rejects.toThrow(/owner/);
      await expect(
        service('user-1').saveAccount({
          id: view.id,
          name: view.name,
          providerId: 'jmap-test',
          configuration: view.configuration,
          ownerUserId: 'user-2',
        }),
      ).rejects.toThrow(/setOwner/);
      await expect(
        service('user-1', { validateMailbox }).saveAccount({
          name: 'for someone else',
          providerId: 'jmap-test',
          configuration: view.configuration,
          credentials: { username: 'u', password: 'p' },
          ownerUserId: 'user-2',
        }),
      ).rejects.toThrow(/creator/);
    });
  });

  describe('default validator (SSRF guard)', () => {
    let unregisterReal: () => void;
    const connectSpy = vi.fn(async () => undefined);
    beforeEach(() => {
      connectSpy.mockClear();
      unregisterReal = registerMessagingProvider({
        id: 'jmap-real',
        label: 'JMAP (real client)',
        channel: 'email',
        available: true,
        configurationFields: [
          {
            id: 'endpoint',
            label: 'JMAP endpoint',
            type: 'url',
            required: true,
          },
          { id: 'email', label: 'Address', type: 'email', required: true },
        ],
        credentialFields: [
          { id: 'username', label: 'Username', type: 'string', required: true },
          {
            id: 'password',
            label: 'App password',
            type: 'password',
            required: true,
          },
        ],
        endpointFields: [],
        createEmailClient: (async () => ({
          connect: connectSpy,
          disconnect: async () => undefined,
        })) as never,
      });
    });
    afterEach(() => unregisterReal());

    const withDefault = (extra: Record<string, unknown>) =>
      new MessagingSettingsService({
        db,
        tenantId: TENANT,
        principal: messagingPrincipalFromPermissions(
          [MANAGE_MESSAGE_CREDENTIALS_PERMISSION],
          { id: 'user-1', tenantId: TENANT },
        ),
        resolvePersonaTenantId: async () => null,
        ...extra,
      });
    const attempt = (svc: MessagingSettingsService, endpoint: string) =>
      svc.connectMailbox({
        name: 'x',
        providerId: 'jmap-real',
        configuration: { endpoint, email: 'me@example.com' },
        credentials: { username: 'me', password: PASSWORD },
      });

    it('refuses everything without a host allowlist, and never reaches the network', async () => {
      await expect(
        attempt(withDefault({}), 'https://mail.example.com/jmap'),
      ).rejects.toThrow('The mail server did not accept this connection.');
      expect(connectSpy).not.toHaveBeenCalled();
    });

    it('refuses unlisted hosts, private and loopback addresses even when listed, plain http and odd ports', async () => {
      const svc = withDefault({
        allowedMailHosts: [
          'mail.example.com',
          '127.0.0.1',
          '169.254.169.254',
          '*.corp.example.com',
          'localhost',
        ],
      });
      for (const endpoint of [
        'https://other.example.com/jmap',
        'https://127.0.0.1/jmap',
        'https://169.254.169.254/latest',
        'https://localhost/jmap',
        'http://mail.example.com/jmap',
        'https://mail.example.com:6379/jmap',
        'https://corp.example.com/jmap',
      ]) {
        await expect(attempt(svc, endpoint)).rejects.toThrow(
          'The mail server did not accept this connection.',
        );
      }
      expect(connectSpy).not.toHaveBeenCalled();
    });

    it('connects an allowlisted public host and still returns only a generic error on failure', async () => {
      const svc = withDefault({
        allowedMailHosts: ['mail.example.com', '*.corp.example.com'],
      });
      const view = await attempt(svc, 'https://mail.example.com/jmap');
      expect(view.connectionStatus).toBe('connected');
      await attempt(svc, 'https://a.corp.example.com:443/jmap');
      expect(connectSpy).toHaveBeenCalledTimes(2);
      connectSpy.mockRejectedValueOnce(
        new Error(`ECONNREFUSED 10.0.0.5 ${PASSWORD}`),
      );
      const error = await attempt(svc, 'https://mail.example.com/jmap').catch(
        (e) => e as Error,
      );
      expect((error as Error).message).toBe(
        'The mail server did not accept this connection.',
      );
    });
  });

  describe('builtin jmap provider (#5180)', () => {
    let unregisterJmap: () => void;
    let restoreJmap: () => void;
    const created: Record<string, unknown>[] = [];
    const connectSpy = vi.fn(async () => undefined);
    beforeEach(async () => {
      created.length = 0;
      connectSpy.mockClear();
      const { getMessagingProvider } = await import('../providers.js');
      const definition = getMessagingProvider('jmap');
      expect(definition?.channel).toBe('email');
      restoreJmap = () => {
        registerMessagingProvider(definition as NonNullable<typeof definition>);
      };
      // The fake JMAP client stands in for @happyvertical/email.
      unregisterJmap = registerMessagingProvider({
        ...(definition as NonNullable<typeof definition>),
        createEmailClient: (async (options: Record<string, unknown>) => {
          created.push(options);
          return {
            connect: connectSpy,
            disconnect: async () => undefined,
          };
        }) as never,
      });
    });
    afterEach(() => {
      unregisterJmap();
      restoreJmap();
    });

    const svc = (extra: Record<string, unknown> = {}) =>
      new MessagingSettingsService({
        db,
        tenantId: TENANT,
        principal: messagingPrincipalFromPermissions(
          [MANAGE_MESSAGE_CREDENTIALS_PERMISSION],
          { id: 'user-1', tenantId: TENANT },
        ),
        resolvePersonaTenantId: async () => null,
        allowedMailHosts: ['mail.example.com'],
        allowedMailPorts: [443],
        ...extra,
      });
    const attempt = (
      service: MessagingSettingsService,
      configuration: Record<string, unknown>,
      credentials: Record<string, unknown> = {
        username: 'me',
        password: PASSWORD,
      },
    ) =>
      service.connectMailbox({
        name: 'JMAP',
        providerId: 'jmap',
        configuration: { email: 'me@example.com', ...configuration },
        credentials,
      });
    const refused = 'The mail server did not accept this connection.';

    it('connects end to end on an allowlisted https url with the provider client', async () => {
      const view = await attempt(svc(), { url: 'https://mail.example.com' });
      expect(view).toMatchObject({
        providerId: 'jmap',
        ownerUserId: 'user-1',
        connectionStatus: 'connected',
      });
      expect(created[0]).toMatchObject({
        type: 'jmap',
        url: 'https://mail.example.com',
        auth: { user: 'me', pass: PASSWORD },
      });
      expect(created[0]).not.toHaveProperty('email');
      expect(connectSpy).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(view)).not.toContain(PASSWORD);
      // The saved account builds its client from the stored sign-in.
      const account = await withTenant({ tenantId: TENANT }, async () =>
        (await EmailAccountCollection.create({ db })).get({ id: view.id }),
      );
      await withTenant({ tenantId: TENANT }, async () => {
        await (account as EmailAccount).createClient();
      });
      expect(created[1]).toMatchObject({
        type: 'jmap',
        url: 'https://mail.example.com',
        auth: { user: 'me', pass: PASSWORD },
      });
    });

    it('signs in with an access token as a bearer, not an empty user and password', async () => {
      const view = await attempt(
        svc(),
        { url: 'https://mail.example.com' },
        { token: 'tok-123' },
      );
      expect(created[0]).toMatchObject({
        auth: { type: 'bearer', token: 'tok-123' },
      });
      const account = await withTenant({ tenantId: TENANT }, async () =>
        (await EmailAccountCollection.create({ db })).get({ id: view.id }),
      );
      await withTenant({ tenantId: TENANT }, async () => {
        await (account as EmailAccount).createClient();
      });
      expect(created[1]).toMatchObject({
        auth: { type: 'bearer', token: 'tok-123' },
      });
    });

    it('refuses an unlisted host, plain http, userinfo, an unlisted port, private names and a missing url, without connecting', async () => {
      const service = svc({
        allowedMailHosts: ['mail.example.com', '127.0.0.1', 'localhost'],
      });
      for (const url of [
        'https://other.example.com',
        'http://mail.example.com',
        'https://user:pw@mail.example.com',
        'https://user@mail.example.com',
        'https://mail.example.com:8443',
        'https://127.0.0.1',
        'https://localhost',
        'https://mail.example.com.evil.test',
        'not a url',
      ]) {
        await expect(attempt(service, { url })).rejects.toThrow(refused);
      }
      expect(connectSpy).not.toHaveBeenCalled();
      // Required field missing is refused before any network use.
      await expect(attempt(service, {})).rejects.toThrow(/required/);
      await expect(attempt(service, { url: '' })).rejects.toThrow(/required/);
      expect(connectSpy).not.toHaveBeenCalled();
    });

    it('cannot hide an unlisted url behind a listed host or endpoint field', async () => {
      const service = svc();
      await expect(
        attempt(service, {
          url: 'https://evil.example.net',
          host: 'mail.example.com',
        }),
      ).rejects.toThrow(/Unknown configuration field/);
      await expect(
        attempt(service, {
          url: 'https://evil.example.net',
          endpoint: 'https://mail.example.com',
        }),
      ).rejects.toThrow(/Unknown configuration field/);
      expect(connectSpy).not.toHaveBeenCalled();
    });

    it('refuses everything with no allowlist, and never leaks server detail', async () => {
      await expect(
        attempt(svc({ allowedMailHosts: undefined }), {
          url: 'https://mail.example.com',
        }),
      ).rejects.toThrow(refused);
      connectSpy.mockRejectedValueOnce(new Error(`bad login ${PASSWORD}`));
      const error = await attempt(svc(), {
        url: 'https://mail.example.com',
      }).catch((e) => e as Error);
      expect((error as Error).message).toBe(refused);
    });

    it('stays a receive-only transport: not offered for outbound routing', async () => {
      const { listMessagingProviders } = await import('../providers.js');
      expect(
        listMessagingProviders().some((provider) => provider.id === 'jmap'),
      ).toBe(false);
      expect(
        listMessagingProviders({ includeUnavailable: true }).some(
          (provider) => provider.id === 'jmap',
        ),
      ).toBe(true);
    });
  });

  describe('reconnection', () => {
    it('recognizes server refusals of the saved sign-in', () => {
      expect(
        isMailAuthFailure(Object.assign(new Error('x'), { code: 'EAUTH' })),
      ).toBe(true);
      expect(
        isMailAuthFailure(
          new Error('AUTHENTICATIONFAILED invalid credentials'),
        ),
      ).toBe(true);
      expect(isMailAuthFailure(new Error('Login failed'))).toBe(true);
      expect(
        isMailAuthFailure(new Error('connect ECONNREFUSED 127.0.0.1:993')),
      ).toBe(false);
    });

    it('marks an account as needing reconnection and back to connected', async () => {
      const view = await connect(
        service('user-1', { validateMailbox: async () => undefined }),
      );
      await withTenant({ tenantId: TENANT }, async () => {
        const account = (await (
          await EmailAccountCollection.create({ db })
        ).get({ id: view.id })) as EmailAccount;
        await account.markNeedsReconnect('The server refused the sign-in.');
        expect(account.needsReconnect).toBe(true);
        const reloaded = (await (
          await EmailAccountCollection.create({ db })
        ).get({ id: view.id })) as EmailAccount;
        expect(reloaded.statusMessage).toBe('The server refused the sign-in.');
        await reloaded.markConnected();
        expect(reloaded.connectionStatus).toBe('connected');
        expect(reloaded.statusMessage).toBeNull();
      });
    });
  });

  describe('generic OAuth 2.0 / OIDC', () => {
    const provider: MailOAuthProvider = {
      id: 'stalwart',
      label: 'Stalwart',
      issuer: 'https://id.example.com',
      scopes: ['openid', 'email', 'offline_access'],
      messagingProviderId: 'jmap-test',
      configuration: { endpoint: 'https://mail.example.com/jmap' },
    };
    const client = { clientId: 'cid', clientSecret: 'client-secret-xyz' };
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status });

    function oidcFetch(
      options: {
        issuer?: string;
        email?: string | null;
        tokenStatus?: number;
      } = {},
    ) {
      return vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/.well-known/openid-configuration')) {
          return json({
            issuer: options.issuer ?? 'https://id.example.com',
            authorization_endpoint: 'https://id.example.com/authorize',
            token_endpoint: 'https://id.example.com/token',
            userinfo_endpoint: 'https://id.example.com/userinfo',
          });
        }
        if (url.endsWith('/token')) {
          return json(
            options.tokenStatus && options.tokenStatus !== 200
              ? { error: 'invalid_grant' }
              : {
                  access_token: 'access-1',
                  refresh_token: 'refresh-1',
                  token_type: 'Bearer',
                  expires_in: 3600,
                  scope: 'openid email offline_access',
                },
            options.tokenStatus ?? 200,
          );
        }
        return json({
          sub: 'sub-1',
          ...(options.email === null
            ? {}
            : { email: options.email ?? 'me@mail.example.com' }),
        });
      }) as unknown as typeof fetch;
    }

    const base = (userId = 'user-1', fetchImpl = oidcFetch()) => ({
      options: { db },
      tenantId: TENANT,
      userId,
      provider,
      client,
      redirectUri: REDIRECT,
      fetch: fetchImpl,
    });

    const startAndFinish = async (
      userId = 'user-1',
      fetchImpl = oidcFetch(),
      finishAs = userId,
    ) => {
      const { authorizeUrl } = await startMailOAuthConnect({
        ...base(userId, fetchImpl),
        returnTo: '/settings/mail',
      });
      const state = new URL(authorizeUrl).searchParams.get('state') as string;
      return {
        authorizeUrl,
        state,
        finish: (overrides: Record<string, unknown> = {}) =>
          completeMailOAuthConnect({
            ...base(finishAs, fetchImpl),
            query: { code: 'code-1', state },
            ...overrides,
          }),
      };
    };

    it('discovers the issuer, sends a PKCE authorize URL, and never leaks the client secret', async () => {
      const { authorizeUrl } = await startAndFinish();
      const url = new URL(authorizeUrl);
      expect(url.origin + url.pathname).toBe(
        'https://id.example.com/authorize',
      );
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      expect(url.searchParams.get('scope')).toBe('openid email offline_access');
      expect(authorizeUrl).not.toContain('client-secret-xyz');
    });

    it('creates an account owned by the connecting user with secrets in smrt-secrets', async () => {
      const { finish } = await startAndFinish();
      const done = await finish();
      expect(done).toMatchObject({ created: true, returnTo: '/settings/mail' });
      expect(done.account).toMatchObject({
        ownerUserId: 'user-1',
        email: 'me@mail.example.com',
        connectionStatus: 'connected',
        providerType: 'jmap-test',
      });
      expect(done.account.settings).toBe('');
      expect(done.account.getConfiguration()).toMatchObject({
        endpoint: 'https://mail.example.com/jmap',
      });
      const stored = await withTenant({ tenantId: TENANT }, () =>
        done.account.getCredentials(),
      );
      expect(stored).toMatchObject({
        authType: 'oauth2',
        accessToken: 'access-1',
        refreshToken: 'refresh-1',
        tokenUrl: 'https://id.example.com/token',
      });
      expect(JSON.stringify(done.account.toJSON())).not.toContain('access-1');
    });

    it('reconnects the owner’s account, refreshing the secret in place', async () => {
      await (await startAndFinish()).finish();
      const again = await (await startAndFinish()).finish();
      expect(again.created).toBe(false);
      const rows = await withTenant({ tenantId: TENANT }, async () =>
        (await EmailAccountCollection.create({ db })).list({}),
      );
      expect(
        rows.filter((row) => row.email === 'me@mail.example.com'),
      ).toHaveLength(1);
    });

    it('never takes over a mailbox owned by someone else, or by no one', async () => {
      await (await startAndFinish('user-1')).finish();
      await expect(
        (await startAndFinish('user-2')).finish(),
      ).rejects.toMatchObject({
        code: 'forbidden',
      });
      await withTenant({ tenantId: TENANT }, async () => {
        const unowned = new EmailAccount({
          db,
          tenantId: TENANT,
          name: 'legacy',
          email: 'legacy@mail.example.com',
          providerType: 'jmap-test' as never,
        });
        await unowned.initialize();
        await unowned.save();
      });
      await expect(
        (
          await startAndFinish(
            'user-3',
            oidcFetch({ email: 'legacy@mail.example.com' }),
          )
        ).finish(),
      ).rejects.toMatchObject({ code: 'forbidden' });
    });

    it('rejects a replayed state, another user, another tenant and a refused grant', async () => {
      const first = await startAndFinish();
      await first.finish();
      await expect(first.finish()).rejects.toMatchObject({
        code: 'invalid_state',
      });

      const other = await startAndFinish('user-1', oidcFetch(), 'user-2');
      await expect(other.finish()).rejects.toMatchObject({
        code: 'invalid_state',
      });

      const crossTenant = await startAndFinish();
      await expect(
        crossTenant.finish({ tenantId: 'tenant-b' }),
      ).rejects.toMatchObject({ code: 'invalid_state' });

      const denied = await startAndFinish();
      await expect(
        denied.finish({
          query: { state: denied.state, error: 'access_denied' },
        }),
      ).rejects.toMatchObject({ code: 'access_denied' });
      await expect(denied.finish()).rejects.toMatchObject({
        code: 'invalid_state',
      });
    });

    it('fails safely on a bad issuer, a rejected code, and a profile with no mailbox', async () => {
      await expect(
        startMailOAuthConnect(
          base('user-1', oidcFetch({ issuer: 'https://evil.example.com' })),
        ),
      ).rejects.toMatchObject({ code: 'discovery_failed' });
      const rejected = await startAndFinish(
        'user-1',
        oidcFetch({ tokenStatus: 400 }),
      );
      await expect(rejected.finish()).rejects.toMatchObject({
        code: 'token_exchange_failed',
      });
      const noMailbox = await startAndFinish(
        'user-1',
        oidcFetch({ email: null }),
      );
      await expect(noMailbox.finish()).rejects.toMatchObject({
        code: 'profile_lookup_failed',
      });
      const rows = await withTenant({ tenantId: TENANT }, async () =>
        (await EmailAccountCollection.create({ db })).list({}),
      );
      expect(rows).toHaveLength(0);
    });

    it('requires a signed-in user, a tenant, a client and a same-origin return path', async () => {
      await expect(
        startMailOAuthConnect({ ...base(''), userId: '' }),
      ).rejects.toMatchObject({ code: 'forbidden' });
      await expect(
        startMailOAuthConnect({ ...base(), tenantId: '' }),
      ).rejects.toMatchObject({ code: 'missing_tenant' });
      await expect(
        startMailOAuthConnect({
          ...base(),
          client: { clientId: '', clientSecret: '' },
        }),
      ).rejects.toMatchObject({ code: 'missing_client_credentials' });
      await expect(
        startMailOAuthConnect({
          ...base(),
          returnTo: 'https://evil.example.com',
        }),
      ).rejects.toBeInstanceOf(ConnectError);
    });
  });
});
