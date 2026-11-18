/**
 * Account model - Base class for all messaging account types (STI)
 *
 * Common fields shared across email, Slack, Twitter accounts, etc.
 */

// Register the package manifest before this module's @smrt() decorator
// runs, whichever chunk the library build places it in (#3098).
import '../__smrt-register__.js';
import {
  crossPackageRef,
  field,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy/decorators';
import {
  createAccountSecretService,
  getCurrentTenant,
  withTenant,
} from '../host.js';
import type { AccountOptions, MessageSenderInterface } from '../types';

@TenantScoped({ mode: 'optional' })
@smrt({
  tableStrategy: 'sti',
  api: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
  cli: { include: ['list', 'get'] },
})
export class Account extends SmrtObject {
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  @field({
    description: 'The display name for this connected messaging account.',
  })
  name = '';
  @field({
    description: 'The service that connects this account to your application.',
  })
  providerType = '';
  @field({
    description:
      'The kind of messaging this account supports, such as email or chat.',
  })
  channelType = '';
  // credentialSecretId stores the Secret's NAME (keyed by name + tenant
  // context in smrt-secrets), NOT its primary-key id — see setCredentials()/
  // getCredentials() which call tenant-bound SecretService operations by name.
  // So it is deliberately NOT a @crossPackageRef id FK.
  @field({ sensitive: true, readonly: true })
  credentialSecretId: string | null = null;
  @field({ description: 'Whether this account is enabled for messaging.' })
  isActive = true;
  /**
   * The person who owns this account. Optional at framework level: an account
   * with no owner keeps tenant-wide access. An app that wants private or
   * shared mailboxes sets it (and hardens it to required); see `access.ts`.
   */
  @crossPackageRef('@happyvertical/smrt-users:User')
  @field({
    description:
      'The person who owns this account and decides who else may use it.',
  })
  ownerUserId: string | null = null;
  @field({
    description:
      'A short name shown beside this account, such as Support or Personal.',
  })
  label: string | null = null;
  @field({
    description:
      'Whether the saved sign-in still works: connected, or needs_reconnect after the server refused it.',
  })
  connectionStatus: string | null = null;
  @field({
    description: 'Why the account needs attention, in plain words.',
  })
  statusMessage: string | null = null;
  @field({ description: 'When this account last checked for new messages.' })
  lastSyncAt: Date | null = null;
  // JSON. Sensitive (#1540): may hold a plaintext credential fallback, so it is
  // excluded from generated API/MCP responses and rejected as a `where` filter
  // key.
  @field({ sensitive: true, readonly: true })
  settings = ''; // JSON
  /** Non-secret provider configuration such as a Zulip site URL. */
  @field({
    description:
      'The public connection settings for this account; credentials are stored separately.',
  })
  configuration = '{}';

  // Timestamps
  @field({ description: 'When this account was added.' })
  createdAt = new Date();
  @field({ description: 'When this account was last changed.' })
  updatedAt = new Date();

  constructor(options: AccountOptions = {}) {
    super(options);

    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.name !== undefined) this.name = options.name;
    if (options.providerType !== undefined)
      this.providerType = options.providerType;
    if (options.channelType !== undefined)
      this.channelType = options.channelType;
    if (options.credentialSecretId !== undefined)
      this.credentialSecretId = options.credentialSecretId || null;
    if (options.isActive !== undefined) this.isActive = options.isActive;
    if (options.ownerUserId !== undefined)
      this.ownerUserId = options.ownerUserId || null;
    if (options.label !== undefined) this.label = options.label || null;
    if (options.connectionStatus !== undefined)
      this.connectionStatus = options.connectionStatus || null;
    if (options.statusMessage !== undefined)
      this.statusMessage = options.statusMessage || null;
    if (options.lastSyncAt !== undefined)
      this.lastSyncAt = options.lastSyncAt || null;
    if (options.settings !== undefined) this.settings = options.settings;
    if (options.configuration !== undefined)
      this.configuration = options.configuration;
    if (options.createdAt) this.createdAt = options.createdAt;
    if (options.updatedAt) this.updatedAt = options.updatedAt;
  }

  /**
   * Get settings as parsed object
   */
  getSettings(): Record<string, unknown> {
    if (!this.settings) return {};
    try {
      return JSON.parse(this.settings);
    } catch {
      return {};
    }
  }

  /**
   * Set settings from object
   */
  setSettings(settings: Record<string, unknown>): void {
    this.settings = JSON.stringify(settings);
  }

  getConfiguration(): Record<string, unknown> {
    try {
      return JSON.parse(this.configuration || '{}');
    } catch {
      return {};
    }
  }

  setConfiguration(configuration: Record<string, unknown>): void {
    this.configuration = JSON.stringify(configuration);
  }

  get hasCredentials(): boolean {
    return Boolean(this.credentialSecretId || this.settings);
  }

  /** Whether this account needs its sign-in entered again. */
  get needsReconnect(): boolean {
    return this.connectionStatus === 'needs_reconnect';
  }

  /**
   * Record that the server refused this account's sign-in, so the host can ask
   * the owner to reconnect instead of failing every sync silently.
   */
  async markNeedsReconnect(reason: string): Promise<void> {
    this.connectionStatus = 'needs_reconnect';
    this.statusMessage = reason.slice(0, 200);
    this.updatedAt = new Date();
    await this.save();
  }

  /** Record a working sign-in (after connect, reconnect, or a good sync). */
  async markConnected(): Promise<void> {
    if (this.connectionStatus === 'connected' && !this.statusMessage) return;
    this.connectionStatus = 'connected';
    this.statusMessage = null;
    this.updatedAt = new Date();
    await this.save();
  }

  /**
   * Activate account
   */
  async activate(): Promise<void> {
    this.isActive = true;
    this.updatedAt = new Date();
    await this.save();
  }

  /**
   * Deactivate account
   */
  async deactivate(): Promise<void> {
    this.isActive = false;
    this.updatedAt = new Date();
    await this.save();
  }

  /**
   * Store credentials securely using smrt-secrets
   */
  async setCredentials(
    credentials: Record<string, unknown>,
    options: {
      description?: string;
      category?: string;
    } = {},
  ): Promise<void> {
    if (!this.id) {
      throw new Error('Account must be persisted before storing credentials.');
    }
    const secretService = await createAccountSecretService(this.db);

    const secretName = `${this.channelType || 'messaging'}-account-${this.id}`;
    const secretValue = JSON.stringify(credentials);
    const tenantId = this.requireCredentialTenantId('store credentials');

    await secretService.storeForTenant(
      tenantId,
      this.credentialSecretId || secretName,
      secretValue,
      {
        description: options.description || `Credentials for ${this.name}`,
        category: options.category || 'messaging',
      },
    );

    this.credentialSecretId ||= secretName;
    this.updatedAt = new Date();
    await this.withCredentialTenantContext(() => this.save());
  }

  /**
   * Create a sender for this account.
   * Subclasses must override to return a concrete sender.
   */
  async createSender(): Promise<MessageSenderInterface> {
    const { getMessagingProvider } = await import('../providers.js');
    const provider = getMessagingProvider(this.providerType);
    if (!provider?.createSender) {
      throw new Error(
        `createSender() not implemented for account type '${this.providerType}'`,
      );
    }
    return provider.createSender(this);
  }

  /**
   * Retrieve stored credentials
   */
  async getCredentials(): Promise<Record<string, unknown> | null> {
    if (!this.credentialSecretId) {
      return this.getSettings();
    }

    const tenantId = this.requireCredentialTenantId('retrieve credentials');
    const secretService = await createAccountSecretService(this.db);

    try {
      const secret = await secretService.retrieveForTenant(
        tenantId,
        this.credentialSecretId,
      );
      return JSON.parse(secret.value);
    } catch {
      return null;
    }
  }

  private getCredentialTenantId(): string | null {
    return this.tenantId || getCurrentTenant()?.tenantId || null;
  }

  private requireCredentialTenantId(action: string): string {
    const tenantId = this.getCredentialTenantId();
    if (!tenantId) {
      throw new Error(`Tenant context required to ${action}.`);
    }
    return tenantId;
  }

  private async withCredentialTenantContext<T>(
    fn: () => Promise<T>,
  ): Promise<T> {
    const tenantId = this.getCredentialTenantId();
    if (!tenantId || getCurrentTenant()?.tenantId === tenantId) return fn();
    return withTenant({ tenantId }, fn);
  }
}
