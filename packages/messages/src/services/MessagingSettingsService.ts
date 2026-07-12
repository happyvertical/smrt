import type { SmrtClassOptions } from '@happyvertical/smrt-core';
import { withTenant } from '@happyvertical/smrt-tenancy';
import { AccountCollection } from '../collections/AccountCollection.js';
import { MessagingEndpointCollection } from '../collections/MessagingEndpointCollection.js';
import { PersonaMessageRouteCollection } from '../collections/PersonaMessageRouteCollection.js';
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
    },
  ) {}

  getProviderDefinitions(options: { includeUnavailable?: boolean } = {}) {
    return listMessagingProviders(options).map(
      ({ createSender: _, ...provider }) => provider,
    );
  }

  async list(personaId: string): Promise<{
    providers: Array<Omit<MessagingProviderDefinition, 'createSender'>>;
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
    this.assert(MANAGE_MESSAGE_CREDENTIALS_PERMISSION);
    const provider = this.requireProvider(input.providerId);
    if (!provider.available)
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
        endpoint = new MessagingEndpoint({
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
        route = new PersonaMessageRoute({
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
    if (provider.id === 'zulip') return new ZulipAccount(options);
    if (provider.id === 'telegram') return new TelegramAccount(options);
    if (provider.channel === 'email') {
      return new EmailAccount({
        ...options,
        providerType: provider.id as 'smtp' | 'imap' | 'pop3' | 'gmail',
      });
    }
    return new Account(options);
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
