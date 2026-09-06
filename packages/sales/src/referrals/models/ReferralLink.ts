/**
 * ReferralLink — shareable link/code per Referrer + Program.
 * @packageDocumentation
 */

import { field, foreignKey, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type { ReferralLinkOptions, ReferralLinkStatus } from '../types.js';

/**
 * Assert that a target URL is an absolute http/https URL. Exported for the
 * collection's create path; the model also enforces it at save time so no
 * write path can persist a malformed target.
 */
export function assertHttpTargetUrl(targetUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    throw new Error(
      `ReferralLink targetUrl must be an absolute http(s) URL — got '${targetUrl}'`,
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `ReferralLink targetUrl must use http or https — got '${parsed.protocol}'`,
    );
  }
}

/**
 * A ReferralLink is the shareable artifact a Referrer distributes: a
 * globally unique `code` (natural key `['code']` — codes resolve without
 * knowing the tenant/program) plus an optional destination `targetUrl`.
 *
 * Codes are minted by `ReferralLinkCollection.createWithUniqueCode()` —
 * crypto-random, 10 lowercase-alphanumeric characters, collision-checked
 * with a capped retry loop. Click traffic lands through
 * `ReferralLinkCollection.recordClick()`, which atomically increments
 * {@link clickCount} and writes one immutable, replay-keyed `ReferralTouch`
 * evidence row after enforcing the final UTF-8 evidence bound; disabled links
 * refuse clicks.
 */
@TenantScoped({ mode: 'optional' })
@smrt({
  // Codes are globally unique — the shareable artifact must resolve from
  // the code alone.
  conflictColumns: ['code'],
  api: { include: ['list', 'get', 'create', 'update'] },
  mcp: { include: ['list', 'get', 'create'] },
  cli: { skipApiCheck: true },
})
export class ReferralLink extends SmrtObject {
  /** Tenant ID for multi-tenant isolation (nullable → global links). */
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /** The Referrer this link credits. Required. */
  @foreignKey('Referrer', { required: true })
  referrerId: string = '';

  /** The ReferralProgram this link belongs to. Required. */
  @foreignKey('ReferralProgram', { required: true })
  programId: string = '';

  /**
   * Globally unique share code (10 lowercase-alphanumeric characters when
   * minted by `createWithUniqueCode`). Natural key.
   */
  @field({ required: true })
  code: string = '';

  /**
   * Optional destination URL the shared link forwards to. Must be an
   * absolute http/https URL when non-empty (validated at save time).
   */
  targetUrl: string = '';

  /** Human-readable label for the referrer's own bookkeeping. */
  label: string = '';

  /** `active` (default) accepts clicks; `disabled` refuses them. */
  status: ReferralLinkStatus = 'active';

  /** Number of recorded clicks (incremented by `recordClick`). */
  clickCount: number = 0;

  /**
   * Free-form JSON object stored as a string. Use
   * {@link getMetadata}/{@link setMetadata} instead of parsing manually.
   */
  metadata: string = '{}';

  constructor(options: ReferralLinkOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.referrerId !== undefined) this.referrerId = options.referrerId;
    if (options.programId !== undefined) this.programId = options.programId;
    if (options.code !== undefined) this.code = options.code;
    if (options.targetUrl !== undefined) this.targetUrl = options.targetUrl;
    if (options.label !== undefined) this.label = options.label;
    if (options.status !== undefined) this.status = options.status;
    if (options.clickCount !== undefined) this.clickCount = options.clickCount;
    if (options.metadata !== undefined) this.metadata = options.metadata;
  }

  /** Whether the link currently accepts clicks. */
  isActive(): boolean {
    return this.status === 'active';
  }

  /** Parse the metadata JSON string; returns `{}` on malformed content. */
  getMetadata(): Record<string, unknown> {
    try {
      const parsed: unknown = JSON.parse(this.metadata);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return {};
    } catch {
      return {};
    }
  }

  /** Serialize and store the metadata object. */
  setMetadata(metadata: Record<string, unknown>): void {
    this.metadata = JSON.stringify(metadata);
  }

  /**
   * Save with two guards:
   *
   * - a non-empty {@link targetUrl} must be an absolute http/https URL
   *   regardless of which write path set it;
   * - the {@link code} must not belong to a DIFFERENT persisted link. Codes
   *   are the upsert natural key and they are public — without this check a
   *   generated-surface `create` carrying an existing code would silently
   *   UPSERT over that link (rewriting its referrer/program/target: a
   *   referral-code hijack). Mint codes through
   *   `ReferralLinkCollection.createWithUniqueCode()`.
   */
  override async save(): Promise<this> {
    if (this.targetUrl) {
      assertHttpTargetUrl(this.targetUrl);
    }
    if (this.code) {
      try {
        const row = await this.db.get(this.tableName, { code: this.code });
        if (row && row.id !== this.id) {
          throw new Error(
            `ReferralLink (code '${this.code}'): this code already belongs ` +
              'to another link — referral codes are unique and cannot be ' +
              'taken over. Mint links through ' +
              'ReferralLinkCollection.createWithUniqueCode().',
          );
        }
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes('cannot be taken over')
        ) {
          throw error;
        }
        // DB not ready / table absent — nothing persisted to protect yet.
      }
    }
    return (await super.save()) as this;
  }
}

export default ReferralLink;
