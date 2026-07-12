/**
 * Account model - Base class for all messaging account types (STI)
 *
 * Common fields shared across email, Slack, Twitter accounts, etc.
 */

import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';
import {
  getCurrentTenant,
  TenantScoped,
  tenantId,
  withTenant,
} from '@happyvertical/smrt-tenancy';
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

  name = '';
  providerType = '';
  channelType = '';
  // credentialSecretId stores the Secret's NAME (keyed by name + tenant
  // context in smrt-secrets), NOT its primary-key id — see setCredentials()/
  // getCredentials() which call tenant-bound SecretService operations by name.
  // So it is deliberately NOT a @crossPackageRef id FK.
  @field({ sensitive: true, readonly: true })
  credentialSecretId: string | null = null;
  isActive = true;
  lastSyncAt: Date | null = null;
  // JSON. Sensitive (#1540): may hold a plaintext credential fallback, so it is
  // excluded from generated API/MCP responses and rejected as a `where` filter
  // key.
  @field({ sensitive: true, readonly: true })
  settings = ''; // JSON
  /** Non-secret provider configuration such as a Zulip site URL. */
  configuration = '{}';

  // Timestamps
  createdAt = new Date();
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
    const { SecretService } = await import('@happyvertical/smrt-secrets');
    const secretService = await SecretService.create({ db: this.db });

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
    const { SecretService } = await import('@happyvertical/smrt-secrets');
    const secretService = await SecretService.create({ db: this.db });

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
