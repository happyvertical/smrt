import type { SmrtObjectOptions } from '@happyvertical/smrt-core';
import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import {
  type ContentContributionChannel,
  type ContentContributionIntakeRules,
  type ContentContributionPromotionMapping,
  type ContentContributionTypeDefinition,
  hasStaticContentContributionType,
} from './content-contribution-config';
import { getQueryRows, isMissingTableError } from './database-utils';

export interface ContentContributionTypeOptions extends SmrtObjectOptions {
  key?: string;
  label?: string;
  enabled?: boolean;
  allowedChannels?: ContentContributionChannel[] | string;
  allowText?: boolean;
  allowFiles?: boolean;
  allowEmptyText?: boolean;
  intakeRules?: ContentContributionIntakeRules | string;
  promotion?: ContentContributionPromotionMapping | string;
  metadata?: Record<string, any> | string;
  tenantId?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}

function parseJSON<T>(raw: unknown, fallback: T): T {
  if (!raw) {
    return fallback;
  }

  if (typeof raw === 'object') {
    return structuredClone(raw as T);
  }

  if (typeof raw !== 'string') {
    return fallback;
  }

  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as T) : fallback;
  } catch {
    return fallback;
  }
}

@TenantScoped({ mode: 'optional' })
@smrt({
  tableName: 'content_contribution_types',
  conflictColumns: ['key'],
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get', 'create', 'update', 'delete'] },
  cli: true,
})
export class ContentContributionType extends SmrtObject {
  @field({ required: true })
  key = '';

  label = '';
  enabled = true;
  allowedChannels = '';
  allowText = true;
  allowFiles = false;
  allowEmptyText = false;
  intakeRules = '';
  promotion = '';
  metadata = '';

  @tenantId({ nullable: true })
  tenantId: string | null = null;

  createdAt = new Date();
  updatedAt = new Date();

  constructor(options: ContentContributionTypeOptions = {}) {
    super(options);
    if (options.key !== undefined) this.key = options.key;
    if (options.label !== undefined) this.label = options.label;
    if (options.enabled !== undefined) this.enabled = options.enabled;
    if (options.allowText !== undefined) this.allowText = options.allowText;
    if (options.allowFiles !== undefined) this.allowFiles = options.allowFiles;
    if (options.allowEmptyText !== undefined)
      this.allowEmptyText = options.allowEmptyText;
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.createdAt) this.createdAt = options.createdAt;
    if (options.updatedAt) this.updatedAt = options.updatedAt;

    if (options.allowedChannels !== undefined) {
      this.allowedChannels =
        typeof options.allowedChannels === 'string'
          ? options.allowedChannels
          : JSON.stringify(options.allowedChannels);
    }

    if (options.intakeRules !== undefined) {
      this.intakeRules =
        typeof options.intakeRules === 'string'
          ? options.intakeRules
          : JSON.stringify(options.intakeRules);
    }

    if (options.promotion !== undefined) {
      this.promotion =
        typeof options.promotion === 'string'
          ? options.promotion
          : JSON.stringify(options.promotion);
    }

    if (options.metadata !== undefined) {
      this.metadata =
        typeof options.metadata === 'string'
          ? options.metadata
          : JSON.stringify(options.metadata);
    }
  }

  getAllowedChannels(): ContentContributionChannel[] {
    const channels = parseJSON<ContentContributionChannel[]>(
      this.allowedChannels,
      [],
    );
    return channels.length > 0 ? channels : ['web'];
  }

  setAllowedChannels(channels: ContentContributionChannel[]): void {
    this.allowedChannels = JSON.stringify(channels);
  }

  getIntakeRules(): ContentContributionIntakeRules {
    return parseJSON<ContentContributionIntakeRules>(this.intakeRules, {});
  }

  setIntakeRules(rules: ContentContributionIntakeRules): void {
    this.intakeRules = JSON.stringify(rules || {});
  }

  getPromotion(): ContentContributionPromotionMapping {
    return parseJSON<ContentContributionPromotionMapping>(this.promotion, {});
  }

  setPromotion(promotion: ContentContributionPromotionMapping): void {
    this.promotion = JSON.stringify(promotion || {});
  }

  getMetadata(): Record<string, any> {
    return parseJSON<Record<string, any>>(this.metadata, {});
  }

  setMetadata(metadata: Record<string, any>): void {
    this.metadata = JSON.stringify(metadata || {});
  }

  toDefinition(): ContentContributionTypeDefinition {
    return {
      key: this.key,
      label: this.label || this.key,
      enabled: this.enabled !== false,
      allowedChannels: this.getAllowedChannels(),
      allowText: this.allowText !== false,
      allowFiles: this.allowFiles === true,
      allowEmptyText: this.allowEmptyText === true,
      intakeRules: this.getIntakeRules(),
      promotion: this.getPromotion(),
      metadata: this.getMetadata(),
    };
  }

  protected override transformJSON(json: Record<string, any>) {
    return {
      ...json,
      allowedChannels: this.getAllowedChannels(),
      intakeRules: this.getIntakeRules(),
      promotion: this.getPromotion(),
      metadata: this.getMetadata(),
    };
  }

  protected override async validateBeforeSave(): Promise<void> {
    await super.validateBeforeSave();

    if (!this.key) {
      throw new Error('Contribution type key is required.');
    }

    const promotion = this.getPromotion();
    if (!promotion.targetContentType) {
      throw new Error(
        `Contribution type "${this.key}" must define promotion.targetContentType.`,
      );
    }
  }

  override async delete(): Promise<void> {
    if (!this.db) {
      return super.delete();
    }

    const hasFallback = hasStaticContentContributionType(this.key);

    if (!hasFallback) {
      try {
        const existing = await this.db.query(
          'SELECT id FROM content_contributions WHERE contribution_type_key = ? LIMIT 1',
          this.key,
        );
        const rows = getQueryRows(existing);

        if (rows.length > 0) {
          throw new Error(
            `Cannot delete contribution type "${this.key}" because contributions already reference it.`,
          );
        }
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes('already reference it')
        ) {
          throw error;
        }
        if (!isMissingTableError(error, 'content_contributions')) {
          throw error;
        }
      }
    }

    return super.delete();
  }
}
