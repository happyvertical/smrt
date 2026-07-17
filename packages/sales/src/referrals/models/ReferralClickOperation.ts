/** Private idempotency fence for atomic referral-click recording. */

import {
  field,
  SmrtObject,
  type SmrtObjectOptions,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

interface ReferralClickOperationOptions extends SmrtObjectOptions {
  tenantId?: string | null;
  keyHash?: string;
  linkId?: string;
  touchId?: string;
  intentHash?: string;
  callerEvidenceHash?: string;
  requestedOccurredAt?: string;
}

/**
 * One globally unique caller replay key mapped to its immutable click touch.
 *
 * The deterministic primary UUID is derived from the caller key. The full
 * SHA-256 hash is retained to fail closed even if two keys ever collide in the
 * truncated UUID namespace. This is package-owned orchestration state: it has
 * no generated API, MCP, or CLI surface.
 */
@TenantScoped({ mode: 'optional' })
@smrt({ api: false, mcp: false, cli: false })
export class ReferralClickOperation extends SmrtObject {
  /** Same tenant owner as the ReferralLink and ReferralTouch. */
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /** Full SHA-256 of the exact caller replay key. */
  @field({ required: true, readonly: true })
  keyHash!: string;

  /** Link whose counter this operation increments. */
  @field({ sqlType: 'UUID', required: true, readonly: true, indexed: true })
  linkId!: string;

  /** Immutable touch created by this operation in the same transaction. */
  // Deliberately not an FK: the fence is inserted before the touch. Atomic
  // commit plus replay verification preserves the relationship.
  @field({ sqlType: 'UUID', required: true, readonly: true, indexed: true })
  touchId!: string;

  /** Hash of the normalized link, attribution, timestamp, and evidence intent. */
  @field({ required: true, readonly: true })
  intentHash!: string;

  /** Hash of caller evidence before Sales-owned envelope fields are applied. */
  @field({ required: true, readonly: true })
  callerEvidenceHash!: string;

  /** ISO instant supplied by the caller, or empty when recordClick chose now. */
  @field({ required: true, readonly: true })
  requestedOccurredAt!: string;

  constructor(options: ReferralClickOperationOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.keyHash !== undefined) this.keyHash = options.keyHash;
    if (options.linkId !== undefined) this.linkId = options.linkId;
    if (options.touchId !== undefined) this.touchId = options.touchId;
    if (options.intentHash !== undefined) this.intentHash = options.intentHash;
    if (options.callerEvidenceHash !== undefined)
      this.callerEvidenceHash = options.callerEvidenceHash;
    if (options.requestedOccurredAt !== undefined)
      this.requestedOccurredAt = options.requestedOccurredAt;
  }

  /** Keep the TEXT replay marker a string when adapters parse `*_at`. */
  override async initialize(): Promise<this> {
    await super.initialize();
    const value = this.requestedOccurredAt as unknown;
    if (value instanceof Date) this.requestedOccurredAt = value.toISOString();
    return this;
  }
}

export default ReferralClickOperation;
