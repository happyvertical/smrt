/**
 * Account model - Base class for all messaging account types (STI)
 *
 * Common fields shared across email, Slack, Twitter accounts, etc.
 */

import { SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type { AccountOptions, MessageSenderInterface } from '../types';

@TenantScoped({ mode: 'optional' })
@smrt({
  tableStrategy: 'sti',
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get'] },
  cli: true,
})
export class Account extends SmrtObject {
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  name = '';
  providerType = '';
  credentialSecretId: string | null = null;
  isActive = true;
  lastSyncAt: Date | null = null;
  settings = ''; // JSON

  // Timestamps
  createdAt = new Date();
  updatedAt = new Date();

  constructor(options: AccountOptions = {}) {
    super(options);

    if (options.tenantId !== undefined) this.tenantId = options.tenantId as any;
    if (options.name !== undefined) this.name = options.name;
    if (options.providerType !== undefined)
      this.providerType = options.providerType;
    if (options.credentialSecretId !== undefined)
      this.credentialSecretId = options.credentialSecretId || null;
    if (options.isActive !== undefined) this.isActive = options.isActive;
    if (options.lastSyncAt !== undefined)
      this.lastSyncAt = options.lastSyncAt || null;
    if (options.settings !== undefined) this.settings = options.settings;
    if (options.createdAt) this.createdAt = options.createdAt;
    if (options.updatedAt) this.updatedAt = options.updatedAt;
  }

  /**
   * Get settings as parsed object
   */
  getSettings(): Record<string, any> {
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
  setSettings(settings: Record<string, any>): void {
    this.settings = JSON.stringify(settings);
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
    credentials: Record<string, any>,
    options: {
      description?: string;
      category?: string;
    } = {},
  ): Promise<void> {
    const { SecretService } = await import('@happyvertical/smrt-secrets');
    const secretService = await SecretService.create({ db: this.db });

    const secretName = `account-${this.id}`;
    const secretValue = JSON.stringify(credentials);

    if (this.credentialSecretId) {
      await secretService.store(this.credentialSecretId, secretValue, {
        description: options.description || `Credentials for ${this.name}`,
        category: options.category || 'messaging',
      });
    } else {
      await secretService.store(secretName, secretValue, {
        description: options.description || `Credentials for ${this.name}`,
        category: options.category || 'messaging',
      });

      this.credentialSecretId = secretName;
      this.updatedAt = new Date();
      await this.save();
    }
  }

  /**
   * Create a sender for this account.
   * Subclasses must override to return a concrete sender.
   */
  async createSender(): Promise<MessageSenderInterface> {
    throw new Error(
      `createSender() not implemented for account type '${this.providerType}'`,
    );
  }

  /**
   * Retrieve stored credentials
   */
  async getCredentials(): Promise<Record<string, any> | null> {
    if (!this.credentialSecretId) {
      return this.getSettings();
    }

    const { SecretService } = await import('@happyvertical/smrt-secrets');
    const secretService = await SecretService.create({ db: this.db });

    try {
      const secret = await secretService.retrieve(this.credentialSecretId);
      return JSON.parse(secret.value);
    } catch {
      return null;
    }
  }
}
