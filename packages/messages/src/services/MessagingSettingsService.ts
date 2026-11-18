import {
  ObjectRegistry,
  type SmrtClassOptions,
} from '@happyvertical/smrt-core';
import {
  decideMailAccess,
  MAIL_ACCOUNT_RESOURCE_TYPE,
  MAIL_SCOPES,
  type MailPrincipal,
  type MailScope,
  runWithMailSystemAccess,
  withoutListBounds,
} from '../access.js';
import { AccountCollection } from '../collections/AccountCollection.js';
import { AttachmentCollection } from '../collections/AttachmentCollection.js';
import { EmailFolderCollection } from '../collections/EmailFolderCollection.js';
import { MessageCollection } from '../collections/MessageCollection.js';
import { MessagingEndpointCollection } from '../collections/MessagingEndpointCollection.js';
import { PersonaMessageRouteCollection } from '../collections/PersonaMessageRouteCollection.js';
import { withTenant } from '../host.js';
import { Account } from '../models/Account.js';
import { EmailAccount } from '../models/EmailAccount.js';
import { MessagingEndpoint } from '../models/MessagingEndpoint.js';
import { PersonaMessageRoute } from '../models/PersonaMessageRoute.js';
import { TelegramAccount } from '../models/TelegramAccount.js';
import { ZulipAccount } from '../models/ZulipAccount.js';
import {
  assertMessagingPermission,
  MANAGE_MESSAGE_CREDENTIALS_PERMISSION,
  MANAGE_MESSAGE_ROUTES_PERMISSION,
  type MessagingPrincipal,
} from '../permissions.js';
import {
  getMessagingProvider,
  listMessagingProviders,
  type MessagingProviderDefinition,
  type MessagingProviderField,
  type MessagingProviderFunctionKey,
} from '../providers.js';
import type { MessagingChannel } from '../types.js';

export interface MessagingAccountInput {
  id?: string;
  name: string;
  providerId: string;
  configuration: Record<string, unknown>;
  /** Omit on update to leave the stored secret unchanged. */
  credentials?: Record<string, unknown>;
  active?: boolean;
  /**
   * The new account's owner (create only; must be the acting principal).
   * Ownership changes later go through `MailAccessService.setOwner`.
   */
  ownerUserId?: string | null;
  /** A short name shown beside the account, such as Support. */
  label?: string | null;
}

/** A mailbox connected with a write-only secret such as an app password. */
export interface MailboxConnectInput {
  /** Reconnect an existing mailbox: replaces its credential. */
  id?: string;
  name: string;
  label?: string | null;
  providerId: string;
  /** Non-secret connection settings, including this account's own endpoint. */
  configuration: Record<string, unknown>;
  /** Write-only: validated, stored in smrt-secrets, never returned. */
  credentials: Record<string, unknown>;
}

/** What `connectMailbox` hands to the validator before anything is stored. */
export interface MailboxValidationRequest {
  provider: MessagingProviderDefinition;
  configuration: Record<string, unknown>;
  /** The normalized secret payload exactly as it would be stored. */
  credentials: Record<string, unknown>;
}

export interface MessagingEndpointInput {
  id?: string;
  label: string;
  providerId: string;
  profileId?: string | null;
  address: Record<string, unknown>;
  active?: boolean;
}

export interface PersonaMessageRouteInput {
  id?: string;
  personaId: string;
  accountId: string;
  endpointId: string;
  purpose?: string;
  priority?: number;
  enabled?: boolean;
}

export interface MessagingAccountView {
  id: string;
  name: string;
  providerId: string;
  channel: MessagingChannel;
  configuration: Record<string, unknown>;
  hasCredentials: boolean;
  active: boolean;
  ownerUserId: string | null;
  label: string | null;
  connectionStatus: string | null;
  statusMessage: string | null;
}

/** An account the acting principal owns or holds a grant on. */
export interface MessagingAccountListing extends MessagingAccountView {
  /** `owner` administers the account; `shared` holds only grants. */
  relation: 'owner' | 'shared';
  /** Effective scopes: the owner holds all four, a grantee what grants allow. */
  scopes: MailScope[];
}

export interface ListAccountsOptions {
  /** Page size, 1 to 200. Default 50. */
  limit?: number;
  /** The `nextCursor` of the previous page. */
  cursor?: string | null;
}

export interface ListAccountsResult {
  accounts: MessagingAccountListing[];
  /** Pass as `cursor` for the next page; null when there are no more. */
  nextCursor: string | null;
}

const LIST_ACCOUNTS_DEFAULT_LIMIT = 50;
const LIST_ACCOUNTS_MAX_LIMIT = 200;
const CANDIDATE_PAGE = 500;

export interface MessagingEndpointView {
  id: string;
  label: string;
  channel: MessagingChannel;
  profileId: string | null;
  maskedAddress: string;
  active: boolean;
  verified: boolean;
}

/** Permission-gated server API for a schema-driven messaging settings page. */
export class MessagingSettingsService {
  constructor(
    private readonly options: {
      db: SmrtClassOptions['db'];
      tenantId: string;
      principal: MessagingPrincipal;
      /** Cross-package ownership check supplied by the host/personas layer. */
      resolvePersonaTenantId: (personaId: string) => Promise<string | null>;
      /**
       * Opens a session with the candidate credential before `connectMailbox`
       * stores anything. Defaults to the provider's email client; reject to
       * refuse the connection.
       */
      validateMailbox?: (request: MailboxValidationRequest) => Promise<void>;
      /**
       * Hostnames the built-in validator may connect to: exact names or
       * `*.suffix`. Without this list (and without a custom `validateMailbox`)
       * connecting a mailbox is refused, so a permission holder cannot make
       * the server probe arbitrary hosts. Private, loopback and link-local
       * addresses are refused even when listed.
       */
      allowedMailHosts?: readonly string[];
      /** Ports the built-in validator may use. Default: standard mail ports. */
      allowedMailPorts?: readonly number[];
    },
  ) {}

  getProviderDefinitions(options: { includeUnavailable?: boolean } = {}) {
    return listMessagingProviders(options).map(
      ({
        createSender: _createSender,
        createEmailClient: _createEmailClient,
        createMessageClient: _createMessageClient,
        ...provider
      }) => provider,
    );
  }

  async list(personaId: string): Promise<{
    providers: Array<
      Omit<MessagingProviderDefinition, MessagingProviderFunctionKey>
    >;
    accounts: MessagingAccountView[];
    endpoints: MessagingEndpointView[];
    routes: PersonaMessageRoute[];
  }> {
    this.assert(MANAGE_MESSAGE_ROUTES_PERMISSION);
    return withTenant({ tenantId: this.options.tenantId }, async () => {
      const accounts = await AccountCollection.create({ db: this.options.db });
      const endpoints = await MessagingEndpointCollection.create({
        db: this.options.db,
      });
      const routes = await PersonaMessageRouteCollection.create({
        db: this.options.db,
      });
      const [accountRows, endpointRows, routeRows] = await Promise.all([
        accounts.list({}),
        endpoints.list({}),
        routes.list({ where: { personaId } }),
      ]);
      return {
        providers: this.getProviderDefinitions({ includeUnavailable: true }),
        accounts: accountRows.map((account) => this.accountView(account)),
        endpoints: endpointRows.map((endpoint) => this.endpointView(endpoint)),
        routes: routeRows,
      };
    });
  }

  /**
   * Stores account settings only: it never opens a connection, so it is not an
   * SSRF vector by itself (connecting goes through `connectMailbox`, which is
   * allowlisted). The SMTP host/port it stores predate this change and are
   * used later by the sender; hosts that need an outbound allowlist apply it
   * there.
   */
  async saveAccount(
    input: MessagingAccountInput,
  ): Promise<MessagingAccountView> {
    return this.persistAccount(input, false);
  }

  /**
   * `receiveOnly` admits providers that are not outbound transports (IMAP,
   * POP3): a mailbox can be connected for reading without being a sender.
   */
  private async persistAccount(
    input: MessagingAccountInput,
    receiveOnly: boolean,
  ): Promise<MessagingAccountView> {
    this.assert(MANAGE_MESSAGE_CREDENTIALS_PERMISSION);
    const provider = this.requireProvider(input.providerId);
    if (!provider.available && !(receiveOnly && provider.channel === 'email'))
      throw new Error(`Provider '${provider.id}' is not available.`);
    this.validateFields(
      input.configuration,
      provider.configurationFields,
      'configuration',
    );
    if (input.credentials) {
      this.validateFields(
        input.credentials,
        provider.credentialFields,
        'credentials',
      );
    }

    return withTenant({ tenantId: this.options.tenantId }, async () => {
      const collection = await AccountCollection.create({
        db: this.options.db,
      });
      let account = input.id ? await collection.get({ id: input.id }) : null;
      const isNew = !account;
      if (account && account.tenantId !== this.options.tenantId) {
        throw new Error('Messaging account belongs to another tenant.');
      }
      if (account && account.providerType !== provider.id) {
        throw new Error(
          'A messaging account provider cannot be changed in place.',
        );
      }
      if (account) this.assertMayManage(account);
      if (account && input.ownerUserId !== undefined) {
        if ((input.ownerUserId ?? null) !== (account.ownerUserId ?? null)) {
          throw new Error(
            'Change a mail account owner with MailAccessService.setOwner.',
          );
        }
      }
      if (
        !account &&
        input.ownerUserId &&
        input.ownerUserId !== this.actingUserId
      ) {
        throw new Error('A new mail account can only be owned by its creator.');
      }
      if (
        isNew &&
        !input.credentials &&
        provider.credentialFields.some((field) => field.required)
      ) {
        throw new Error(
          `Credentials are required for new ${provider.label} accounts.`,
        );
      }

      if (!account) {
        account = this.newAccount(provider, input);
        await account.initialize();
      }

      account.name = input.name.trim();
      if (isNew && input.ownerUserId) account.ownerUserId = input.ownerUserId;
      if (input.label !== undefined)
        account.label = input.label?.trim() || null;
      account.isActive = input.active ?? account.isActive;
      account.channelType = provider.channel;
      const configuration = this.normalizeConfiguration(
        provider,
        input.configuration,
      );
      account.setConfiguration(configuration);
      if (account instanceof EmailAccount) {
        account.email = String(configuration.email ?? '');
      }
      account.updatedAt = new Date();
      await account.save();

      if (input.credentials) {
        await account.setCredentials(
          this.normalizeCredentials(provider, input.credentials),
        );
      }

      return this.accountView(account);
    });
  }

  /**
   * Connect a mailbox with a write-only secret (an app password). The
   * credential is validated by opening a session first; a refusal leaves no
   * account and no secret behind. The connecting user becomes the owner.
   */
  async connectMailbox(
    input: MailboxConnectInput,
  ): Promise<MessagingAccountView> {
    this.assert(MANAGE_MESSAGE_CREDENTIALS_PERMISSION);
    // A connected mailbox always has an owner: without a user to own it the
    // account would silently be readable tenant-wide.
    if (!this.actingUserId) {
      throw new Error('Connecting a mailbox needs a signed-in user.');
    }
    if (input.id) {
      // Reconnect, never create-by-id: fails before any server is contacted.
      await withTenant({ tenantId: this.options.tenantId }, async () => {
        this.assertMayManage(await this.loadAccount(input.id as string));
      });
    }
    const provider = this.requireProvider(input.providerId);
    if (provider.channel !== 'email') {
      throw new Error(`Provider '${provider.id}' cannot connect a mailbox.`);
    }
    this.validateFields(
      input.configuration,
      provider.configurationFields,
      'configuration',
    );
    this.validateFields(
      input.credentials,
      provider.credentialFields,
      'credentials',
    );
    const configuration = this.normalizeConfiguration(
      provider,
      input.configuration,
    );
    const credentials = this.normalizeCredentials(provider, input.credentials);
    await this.validateConnection({ provider, configuration, credentials });
    const view = await this.persistAccount(
      {
        id: input.id,
        name: input.name,
        label: input.label,
        providerId: input.providerId,
        configuration: input.configuration,
        credentials: input.credentials,
        active: true,
        ownerUserId: input.id ? undefined : (this.actingUserId ?? null),
      },
      true,
    );
    return withTenant({ tenantId: this.options.tenantId }, async () => {
      const account = await this.loadAccount(view.id);
      await account.markConnected();
      return this.accountView(account);
    });
  }

  /** Pause or resume a mailbox without touching its credential. */
  async setAccountActive(
    accountId: string,
    active: boolean,
  ): Promise<MessagingAccountView> {
    this.assert(MANAGE_MESSAGE_CREDENTIALS_PERMISSION);
    return withTenant({ tenantId: this.options.tenantId }, async () => {
      const account = await this.loadAccount(accountId);
      this.assertMayManage(account);
      account.isActive = active;
      account.updatedAt = new Date();
      await account.save();
      return this.accountView(account);
    });
  }

  /**
   * Remove a mailbox: its stored credential, its synced emails, folders and
   * attachments, and the account itself.
   */
  async removeAccount(accountId: string): Promise<void> {
    this.assert(MANAGE_MESSAGE_CREDENTIALS_PERMISSION);
    await withTenant({ tenantId: this.options.tenantId }, async () => {
      const account = await this.loadAccount(accountId);
      this.assertMayManage(account);
      await runWithMailSystemAccess(async () => {
        const db = this.options.db;
        const messages = await MessageCollection.create({ db });
        const attachments = await AttachmentCollection.create({ db });
        const folders = await EmailFolderCollection.create({ db });
        for (const message of await messages.list({ where: { accountId } })) {
          if (message.id) {
            for (const attachment of await attachments.list({
              where: { messageId: message.id },
            })) {
              await attachment.delete();
            }
          }
          await message.delete();
        }
        for (const folder of await folders.list({ where: { accountId } })) {
          await folder.delete();
        }
      });
      await account.removeCredentials();
      await account.delete();
    });
  }

  async saveEndpoint(
    input: MessagingEndpointInput,
  ): Promise<MessagingEndpointView> {
    this.assert(MANAGE_MESSAGE_ROUTES_PERMISSION);
    const provider = this.requireProvider(input.providerId);
    if (!provider.available)
      throw new Error(`Provider '${provider.id}' is not available.`);
    this.validateFields(input.address, provider.endpointFields, 'endpoint');

    return withTenant({ tenantId: this.options.tenantId }, async () => {
      const collection = await MessagingEndpointCollection.create({
        db: this.options.db,
      });
      let endpoint = input.id ? await collection.get({ id: input.id }) : null;
      if (endpoint && endpoint.tenantId !== this.options.tenantId) {
        throw new Error('Messaging endpoint belongs to another tenant.');
      }
      if (!endpoint) {
        endpoint = new (ObjectRegistry.resolveEffectiveConstructor(
          MessagingEndpoint,
        ))({
          db: this.options.db,
          tenantId: this.options.tenantId,
        });
        await endpoint.initialize();
      }
      endpoint.label = input.label.trim();
      if (input.profileId !== undefined) {
        endpoint.profileId = input.profileId;
      }
      endpoint.channel = provider.channel;
      endpoint.isActive = input.active ?? endpoint.isActive;
      endpoint.setAddress(input.address);
      endpoint.updatedAt = new Date();
      await endpoint.save();
      return this.endpointView(endpoint);
    });
  }

  async saveRoute(
    input: PersonaMessageRouteInput,
  ): Promise<PersonaMessageRoute> {
    this.assert(MANAGE_MESSAGE_ROUTES_PERMISSION);
    const personaTenantId = await this.options.resolvePersonaTenantId(
      input.personaId,
    );
    if (personaTenantId !== this.options.tenantId) {
      throw new Error('Messaging persona was not found in this tenant.');
    }
    return withTenant({ tenantId: this.options.tenantId }, async () => {
      const accounts = await AccountCollection.create({ db: this.options.db });
      const endpoints = await MessagingEndpointCollection.create({
        db: this.options.db,
      });
      const routes = await PersonaMessageRouteCollection.create({
        db: this.options.db,
      });
      const [account, endpoint] = await Promise.all([
        accounts.get({ id: input.accountId }),
        endpoints.get({ id: input.endpointId }),
      ]);
      if (!account || account.tenantId !== this.options.tenantId) {
        throw new Error('Messaging account was not found in this tenant.');
      }
      if (!endpoint || endpoint.tenantId !== this.options.tenantId) {
        throw new Error('Messaging endpoint was not found in this tenant.');
      }
      const accountProvider = getMessagingProvider(account.providerType);
      if (
        !accountProvider?.available ||
        accountProvider.channel !== account.channelType
      ) {
        throw new Error(
          'Messaging account provider is not available for outbound delivery.',
        );
      }
      if (account.channelType !== endpoint.channel) {
        throw new Error(
          'Messaging account and endpoint channels do not match.',
        );
      }

      let route = input.id ? await routes.get({ id: input.id }) : null;
      if (route && route.tenantId !== this.options.tenantId) {
        throw new Error('Messaging route belongs to another tenant.');
      }
      if (!route) {
        route = new (ObjectRegistry.resolveEffectiveConstructor(
          PersonaMessageRoute,
        ))({
          db: this.options.db,
          tenantId: this.options.tenantId,
        });
        await route.initialize();
      }
      route.personaId = input.personaId;
      route.accountId = input.accountId;
      route.endpointId = input.endpointId;
      route.purpose = input.purpose?.trim() || 'default';
      route.priority = input.priority ?? 0;
      route.enabled = input.enabled ?? route.enabled;
      route.updatedAt = new Date();
      await route.save();
      return route;
    });
  }

  /**
   * Accounts the acting principal owns or holds an active grant on, in this
   * service's tenant, with the effective scopes per account. It never lists
   * unowned (tenant-wide) accounts or accounts of other users. Every decision
   * goes through `decideMailAccess`, so ownership, grants, the tenant
   * `messages.<scope>` ceiling and tenant isolation are the same as for mail
   * reads; no separate authorization path exists here. Fail closed: no
   * principal user, a principal of another tenant, or an unconfigured mail
   * access policy (`configureMailAccess`, which owned accounts need to be
   * decided at all) yields an empty list. Paged by account id.
   */
  async listAccounts(
    options: ListAccountsOptions = {},
  ): Promise<ListAccountsResult> {
    const empty: ListAccountsResult = { accounts: [], nextCursor: null };
    const userId = this.actingUserId;
    const { tenantId, principal } = this.options;
    if (!userId || !tenantId) return empty;
    if (principal.tenantId && principal.tenantId !== tenantId) return empty;
    const requested = Number.isFinite(options.limit)
      ? Math.trunc(options.limit as number)
      : LIST_ACCOUNTS_DEFAULT_LIMIT;
    const limit = Math.min(Math.max(requested, 1), LIST_ACCOUNTS_MAX_LIMIT);
    const subject: MailPrincipal = {
      id: principal.id ?? userId,
      userId,
      tenantId,
    };
    return withTenant({ tenantId }, async () => {
      const candidates = await this.accountCandidateIds(userId);
      const accounts = await AccountCollection.create(
        withoutListBounds({ db: this.options.db }),
      );
      const sorted = [...candidates].sort();
      const start = options.cursor
        ? sorted.findIndex((id) => id > (options.cursor as string))
        : 0;
      const out: MessagingAccountListing[] = [];
      let lastId: string | null = null;
      let more = false;
      for (const id of start < 0 ? [] : sorted.slice(start)) {
        if (out.length >= limit) {
          more = true;
          break;
        }
        const account = await accounts.get({ id });
        if (!account || account.tenantId !== tenantId) continue;
        lastId = id;
        const scopes: MailScope[] = [];
        let owner = false;
        for (const scope of MAIL_SCOPES) {
          const decision = await decideMailAccess(
            {
              id: account.id,
              tenantId: account.tenantId,
              ownerUserId: account.ownerUserId,
            },
            scope,
            subject,
          );
          if (decision.reason === 'owner' && decision.allowed) owner = true;
          if (
            decision.allowed &&
            (decision.reason === 'owner' || decision.reason === 'grant')
          ) {
            scopes.push(scope);
          }
        }
        if (!scopes.length) continue;
        out.push({
          ...this.accountView(account),
          relation: owner ? 'owner' : 'shared',
          scopes,
        });
      }
      return { accounts: out, nextCursor: more ? lastId : null };
    });
  }

  /** Ids of accounts the user owns or holds a grant row on (tenant scoped). */
  private async accountCandidateIds(userId: string): Promise<Set<string>> {
    const { tenantId, db } = this.options;
    const ids = new Set<string>();
    const accounts = await AccountCollection.create(withoutListBounds({ db }));
    const { ResourceGrantCollection } = await import(
      '@happyvertical/smrt-users'
    );
    const grants = await ResourceGrantCollection.create(
      withoutListBounds({ db }),
    );
    for (let offset = 0; ; offset += CANDIDATE_PAGE) {
      const rows = await accounts.list({
        where: { tenantId, ownerUserId: userId },
        limit: CANDIDATE_PAGE,
        offset,
        orderBy: 'id ASC',
      });
      for (const row of rows) if (row.id) ids.add(row.id);
      if (rows.length < CANDIDATE_PAGE) break;
    }
    for (let offset = 0; ; offset += CANDIDATE_PAGE) {
      const rows = await grants.list({
        where: { tenantId, userId, resourceType: MAIL_ACCOUNT_RESOURCE_TYPE },
        limit: CANDIDATE_PAGE,
        offset,
        orderBy: 'id ASC',
      });
      for (const row of rows) {
        if (row.isActive() && row.effect === 'grant') ids.add(row.resourceId);
      }
      if (rows.length < CANDIDATE_PAGE) break;
    }
    return ids;
  }

  /** The user who owns accounts this principal creates; null when unknown. */
  private get actingUserId(): string | null {
    return this.options.principal.userId ?? this.options.principal.id ?? null;
  }

  private async loadAccount(accountId: string): Promise<Account> {
    const accounts = await AccountCollection.create({ db: this.options.db });
    const account = await accounts.get({ id: accountId });
    if (!account || account.tenantId !== this.options.tenantId) {
      throw new Error('Messaging account was not found in this tenant.');
    }
    return account;
  }

  /** An owned mailbox is managed by its owner only; unowned ones by admins. */
  private assertMayManage(account: Account): void {
    if (account.ownerUserId && account.ownerUserId !== this.actingUserId) {
      throw new Error('Only the mail account owner can change this account.');
    }
  }

  private async validateConnection(
    request: MailboxValidationRequest,
  ): Promise<void> {
    try {
      if (this.options.validateMailbox) {
        await this.options.validateMailbox(request);
        return;
      }
      this.assertAllowedTarget(request.configuration);
      const create = request.provider.createEmailClient;
      if (!create) {
        throw new Error('this provider cannot check a mailbox sign-in');
      }
      const settings: Record<string, unknown> = {
        ...request.configuration,
        ...request.credentials,
      };
      delete settings.email;
      const client = await create({
        type: request.provider.id,
        ...settings,
      } as Parameters<typeof create>[0]);
      try {
        await client.connect();
      } finally {
        await client.disconnect().catch(() => undefined);
      }
    } catch {
      // Never echo server or network detail: it would let a permission
      // holder map internal hosts, and it can carry the secret.
      throw new Error('The mail server did not accept this connection.');
    }
  }

  /**
   * Host and port allowlist for the built-in validator (SSRF guard).
   *
   * Names are checked, not resolved: an allowlisted name that resolves (or is
   * rebound) to a private address is the host's allowlist responsibility, so
   * list only names you control, or pass a `validateMailbox` that resolves and
   * pins the address it connects to.
   */
  private assertAllowedTarget(configuration: Record<string, unknown>): void {
    // Every target-bearing field present is checked, so a permitted `host`
    // cannot shelter a different `url` or `endpoint` (the JMAP provider's
    // session URL is `url`).
    const targets: Array<{ host: string; port: number | undefined }> = [];
    if (typeof configuration.host === 'string' && configuration.host) {
      targets.push({
        host: configuration.host,
        port:
          typeof configuration.port === 'number'
            ? configuration.port
            : undefined,
      });
    }
    for (const key of ['endpoint', 'url'] as const) {
      const value = configuration[key];
      if (value === undefined || value === null || value === '') continue;
      if (typeof value !== 'string') throw new Error('refused');
      const url = new URL(value);
      // https only, and never credentials in the URL.
      if (url.protocol !== 'https:' || url.username || url.password) {
        throw new Error('refused');
      }
      targets.push({
        host: url.hostname,
        port: url.port ? Number(url.port) : 443,
      });
    }
    if (!targets.length) throw new Error('refused');
    const allowed = this.options.allowedMailHosts ?? [];
    const ports = this.options.allowedMailPorts ?? [
      143, 443, 465, 587, 993, 995,
    ];
    for (const target of targets) {
      const host = target.host.toLowerCase().replace(/^\[|\]$/g, '');
      const listed = allowed.some((entry) => {
        const pattern = entry.toLowerCase();
        return pattern.startsWith('*.')
          ? host.endsWith(pattern.slice(1)) && host.length > pattern.length - 1
          : host === pattern;
      });
      if (!host || !listed || isPrivateMailHost(host)) {
        throw new Error('refused');
      }
      if (target.port !== undefined && !ports.includes(target.port)) {
        throw new Error('refused');
      }
    }
  }

  private assert(permission: string): void {
    assertMessagingPermission(
      this.options.principal,
      this.options.tenantId,
      permission,
    );
  }

  private requireProvider(providerId: string): MessagingProviderDefinition {
    const provider = getMessagingProvider(providerId);
    if (!provider)
      throw new Error(`Unknown messaging provider '${providerId}'.`);
    return provider;
  }

  private validateFields(
    values: Record<string, unknown>,
    fields: MessagingProviderField[],
    kind: string,
  ): void {
    const allowed = new Set(fields.map((field) => field.id));
    for (const key of Object.keys(values)) {
      if (!allowed.has(key)) {
        throw new Error(`Unknown ${kind} field '${key}'.`);
      }
    }
    for (const field of fields) {
      const value = values[field.id];
      const missing = value === undefined || value === '';
      if (field.required && (missing || value === null)) {
        throw new Error(`${field.label} is required in ${kind}.`);
      }
      if (missing) continue;

      if (
        field.type === 'number' &&
        (typeof value !== 'number' || !Number.isFinite(value))
      ) {
        throw new Error(`${field.label} must be a finite number in ${kind}.`);
      }
      if (field.type === 'boolean' && typeof value !== 'boolean') {
        throw new Error(`${field.label} must be a boolean in ${kind}.`);
      }
      if (
        field.type !== 'number' &&
        field.type !== 'boolean' &&
        typeof value !== 'string'
      ) {
        throw new Error(`${field.label} must be a string in ${kind}.`);
      }
      if (
        field.type === 'select' &&
        field.options?.length &&
        !field.options.some((option) => option.value === value)
      ) {
        throw new Error(`${field.label} has an invalid option in ${kind}.`);
      }
    }
  }

  private newAccount(
    provider: MessagingProviderDefinition,
    input: MessagingAccountInput,
  ): Account {
    const options = {
      db: this.options.db,
      tenantId: this.options.tenantId,
      name: input.name.trim(),
      providerType: provider.id,
      channelType: provider.channel,
    };
    if (provider.id === 'zulip')
      return new (ObjectRegistry.resolveEffectiveConstructor(ZulipAccount))(
        options,
      );
    if (provider.id === 'telegram')
      return new (ObjectRegistry.resolveEffectiveConstructor(TelegramAccount))(
        options,
      );
    if (provider.channel === 'email') {
      return new (ObjectRegistry.resolveEffectiveConstructor(EmailAccount))({
        ...options,
        providerType: provider.id as 'smtp' | 'imap' | 'pop3' | 'gmail',
      });
    }
    return new (ObjectRegistry.resolveEffectiveConstructor(Account))(options);
  }

  private normalizeCredentials(
    provider: MessagingProviderDefinition,
    credentials: Record<string, unknown>,
  ): Record<string, unknown> {
    if (provider.channel !== 'email') return credentials;
    if (provider.id === 'gmail') {
      return { auth: credentials };
    }
    if (provider.id === 'jmap') {
      // JMAP signs in with a bearer token or a user and password, as one
      // `auth` value; a token must not be shadowed by an empty user/pass.
      const { username, password, token, ...rest } = credentials;
      if (typeof token === 'string' && token) {
        return { ...rest, auth: { type: 'bearer', token } };
      }
      return { ...rest, auth: { user: username, pass: password } };
    }
    const { username, password, ...rest } = credentials;
    return {
      ...rest,
      auth: { user: username, pass: password },
    };
  }

  private normalizeConfiguration(
    provider: MessagingProviderDefinition,
    configuration: Record<string, unknown>,
  ): Record<string, unknown> {
    if (provider.channel !== 'email' || configuration.secure === undefined) {
      return configuration;
    }
    return {
      ...configuration,
      secure: configuration.secure === true || configuration.secure === 'true',
    };
  }

  private accountView(account: Account): MessagingAccountView {
    return {
      id: account.id ?? '',
      name: account.name,
      providerId: account.providerType,
      channel: account.channelType,
      configuration: account.getConfiguration(),
      hasCredentials: account.hasCredentials,
      active: account.isActive,
      ownerUserId: account.ownerUserId,
      label: account.label,
      connectionStatus: account.connectionStatus,
      statusMessage: account.statusMessage,
    };
  }

  private endpointView(endpoint: MessagingEndpoint): MessagingEndpointView {
    return {
      id: endpoint.id ?? '',
      label: endpoint.label,
      channel: endpoint.channel,
      profileId: endpoint.profileId,
      maskedAddress: endpoint.getMaskedAddress(),
      active: endpoint.isActive,
      verified: endpoint.verifiedAt !== null,
    };
  }
}

/** Loopback, private, link-local and unspecified addresses and names. */
function isPrivateMailHost(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  const v4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  if (host.includes(':')) {
    return (
      host === '::' ||
      host === '::1' ||
      /^f[cd]/.test(host) ||
      /^fe[89ab]/.test(host) ||
      host.startsWith('::ffff:')
    );
  }
  return false;
}
