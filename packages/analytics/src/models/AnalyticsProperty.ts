/**
 * AnalyticsProperty model - Represents an analytics property/site
 * @packageDocumentation
 */

import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { resolvePrompt } from '@happyvertical/smrt-prompts';
import {
  promptMessageOptions,
  smrtAnalyticsAnalyzePerformancePrompt,
} from '../prompts.js';
import { AnalyticsPropertyStatus, AnalyticsProvider } from '../types/index.js';

/**
 * AnalyticsProperty represents an analytics property (GA4 property,
 * Plausible site, or Matomo site).
 *
 * @example
 * ```typescript
 * const property = await properties.create({
 *   name: 'My Website',
 *   displayName: 'My Website Analytics',
 *   provider: AnalyticsProvider.GA4,
 *   externalId: 'properties/123456789',
 *   measurementId: 'G-XXXXXXXXXX'
 * });
 * ```
 */
@smrt({
  tableStrategy: 'sti',
  api: { include: ['list', 'get', 'create', 'update'] },
  mcp: { include: ['list', 'get', 'sync', 'runReport'] },
  cli: true,
})
export class AnalyticsProperty extends SmrtObject {
  /**
   * Internal name/identifier
   */
  name: string = '';

  /**
   * Human-readable display name
   */
  displayName: string = '';

  /**
   * Analytics provider (ga4, plausible, matomo)
   */
  provider: AnalyticsProvider = AnalyticsProvider.GA4;

  /**
   * External ID from the provider (e.g., "properties/123456789" for GA4,
   * idSite for Matomo)
   */
  externalId: string = '';

  /**
   * Measurement ID for GA4 (G-XXXXXXXXXX)
   */
  measurementId: string = '';

  /**
   * Provider API secret/token (GA4 API secret, Matomo token_auth)
   *
   * Sensitive (#1540): excluded from generated API/MCP responses and rejected
   * as a `where` filter key so it can't be probed.
   */
  @field({ sensitive: true })
  apiSecret: string = '';

  /**
   * Site domain for Plausible/Matomo
   */
  siteDomain: string = '';

  /**
   * Property timezone
   */
  timeZone: string = 'America/Los_Angeles';

  /**
   * Currency code (e.g., 'USD', 'EUR')
   */
  currencyCode: string = 'USD';

  /**
   * Industry category
   */
  industryCategory: string = '';

  /**
   * Service level (STANDARD, PREMIUM)
   */
  serviceLevel: string = 'STANDARD';

  /**
   * Property status
   */
  status: AnalyticsPropertyStatus = AnalyticsPropertyStatus.ACTIVE;

  /**
   * Last sync timestamp with provider
   */
  lastSyncAt: Date | null = null;

  /**
   * Metadata from provider (JSON)
   *
   * Sensitive (#1540): may carry provider credentials/tokens, so it is excluded
   * from generated API/MCP responses and rejected as a `where` filter key.
   */
  @field({ sensitive: true })
  providerMetadata: string = '{}';

  constructor(options: any = {}) {
    super(options);
    if (options.name !== undefined) this.name = options.name;
    if (options.displayName !== undefined)
      this.displayName = options.displayName;
    if (options.provider !== undefined) this.provider = options.provider;
    if (options.externalId !== undefined) this.externalId = options.externalId;
    if (options.measurementId !== undefined)
      this.measurementId = options.measurementId;
    if (options.apiSecret !== undefined) this.apiSecret = options.apiSecret;
    if (options.siteDomain !== undefined) this.siteDomain = options.siteDomain;
    if (options.timeZone !== undefined) this.timeZone = options.timeZone;
    if (options.currencyCode !== undefined)
      this.currencyCode = options.currencyCode;
    if (options.industryCategory !== undefined)
      this.industryCategory = options.industryCategory;
    if (options.serviceLevel !== undefined)
      this.serviceLevel = options.serviceLevel;
    if (options.status !== undefined) this.status = options.status;
    if (options.lastSyncAt !== undefined) this.lastSyncAt = options.lastSyncAt;
    if (options.providerMetadata !== undefined)
      this.providerMetadata = options.providerMetadata;
  }

  /**
   * Check if this is a GA4 property
   */
  isGA4(): boolean {
    return this.provider === AnalyticsProvider.GA4;
  }

  /**
   * Check if this is a Plausible site
   */
  isPlausible(): boolean {
    return this.provider === AnalyticsProvider.PLAUSIBLE;
  }

  /**
   * Check if this is a Matomo site
   */
  isMatomo(): boolean {
    return this.provider === AnalyticsProvider.MATOMO;
  }

  /**
   * Get parsed provider metadata
   */
  getProviderMetadata(): Record<string, unknown> {
    try {
      return JSON.parse(this.providerMetadata);
    } catch {
      return {};
    }
  }

  /**
   * Set provider metadata
   */
  setProviderMetadata(metadata: Record<string, unknown>): void {
    this.providerMetadata = JSON.stringify(metadata);
  }

  /**
   * Mark as synced with provider
   */
  markSynced(): void {
    this.lastSyncAt = new Date();
  }

  /**
   * AI-powered: Analyze property performance.
   *
   * Uses the `smrtAnalytics.property.analyzePerformance` prompt registered
   * via `@happyvertical/smrt-prompts`, allowing tenant- or instance-level
   * overrides of the template, model, and parameters at runtime.
   *
   * Only non-PII fields (display name, provider label, requested period)
   * are sent to the AI provider. Internal identifiers (`id`, `externalId`,
   * `measurementId`, `apiSecret`, `providerMetadata`) are intentionally
   * excluded — see `../prompts.ts` for the full exclusion rationale.
   */
  async analyzePerformance(options: { period?: string } = {}): Promise<{
    action: string;
    period: string;
    analysis: string;
  }> {
    const period = options.period || '30 days';

    // Resolve `db` from either the canonical `db` option or its `persistence`
    // alias so stored prompt overrides are honored on first call before
    // `getAiClient()` triggers full initialization. SmrtObject already types
    // both options on `SmrtClassOptions` so no `any` cast is needed — that
    // keeps a misspelt option name surfacing as a TypeScript error rather
    // than silently falling through.
    const db = this.options.db ?? this.options.persistence;

    // `AnalyticsProperty` does not declare a `tenantId` field (the model is
    // intentionally not `@TenantScoped`), but consumers commonly invoke it
    // inside a `withTenant(...)` block. We deliberately OMIT `tenantId` from
    // the resolvePrompt options so that the resolver falls back to the
    // AsyncLocalStorage tenancy context via `getTenantId()`. Passing
    // `tenantId: null` explicitly would short-circuit that fallback and
    // silently ignore tenant-specific prompt overrides.
    const resolvedPrompt = await resolvePrompt(
      smrtAnalyticsAnalyzePerformancePrompt.key,
      {
        db,
        variables: {
          period,
          propertyDisplayName: this.displayName || '',
          propertyProvider: this.provider || '',
        },
      },
    );

    const ai = await this.getAiClient();
    const analysis = await ai.message(
      resolvedPrompt.text,
      promptMessageOptions(resolvedPrompt.ai),
    );

    return {
      action: 'analyzePerformance',
      period,
      analysis: analysis.trim(),
    };
  }

  /**
   * AI-powered: Check if property is performing well
   */
  async isPerformingWell(): Promise<boolean> {
    return await this.is(`
      Based on the property configuration and metadata:
      - Property: ${this.displayName}
      - Provider: ${this.provider}
      - Status: ${this.status}
      - Last sync: ${this.lastSyncAt}

      Is this property properly configured and likely performing well?
    `);
  }
}

export default AnalyticsProperty;
