import {
  ObjectRegistry,
  type SmrtClassOptions,
} from '@happyvertical/smrt-core';
import { runWithMailSystemAccess } from '../access.js';
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
    const secrets = collectSecretStrings(request.credentials);
    try {
      if (this.options.validateMailbox) {
        await this.options.validateMailbox(request);
        return;
      }
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
    } catch (error) {
      let reason = error instanceof Error ? error.message : String(error);
      for (const secret of secrets) reason = reason.split(secret).join('***');
      throw new Error(
        `The mail server did not accept this connection: ${reason.slice(0, 200)}`,
      );
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

/** Every string inside a credential payload, longest first, for redaction. */
function collectSecretStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') {
    if (value.length >= 4) out.push(value);
  } else if (value && typeof value === 'object') {
    for (const child of Object.values(value)) collectSecretStrings(child, out);
  }
  return out.sort((a, b) => b.length - a.length);
}
