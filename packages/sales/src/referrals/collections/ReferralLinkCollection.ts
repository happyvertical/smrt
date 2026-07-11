/**
 * ReferralLinkCollection — collection manager for {@link ReferralLink}:
 * crypto-random code minting with collision retry, code lookup, and click
 * recording (link counter + immutable ReferralTouch evidence).
 *
 * @packageDocumentation
 */

import { randomBytes } from 'node:crypto';
import { SmrtCollection } from '@happyvertical/smrt-core';
import { assertHttpTargetUrl, ReferralLink } from '../models/ReferralLink.js';
import type { ReferralTouch } from '../models/ReferralTouch.js';
import { ReferralTouchCollection } from './ReferralTouchCollection.js';

/** Length of generated share codes. */
export const REFERRAL_CODE_LENGTH = 10;

/** Alphabet generated codes draw from (lowercase alphanumeric). */
export const REFERRAL_CODE_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** Attempts before {@link ReferralLinkCollection.createWithUniqueCode} gives up. */
export const MAX_CODE_GENERATION_ATTEMPTS = 5;

/**
 * Generate a crypto-random share code: {@link REFERRAL_CODE_LENGTH}
 * characters drawn uniformly from {@link REFERRAL_CODE_ALPHABET} via
 * rejection-sampled `crypto.randomBytes` (no modulo bias).
 */
export function generateReferralCode(): string {
  const alphabetSize = REFERRAL_CODE_ALPHABET.length;
  // Largest multiple of the alphabet size below 256 — bytes at or above it
  // are rejected so every character is uniformly likely.
  const rejectionBound = 256 - (256 % alphabetSize);
  let code = '';
  while (code.length < REFERRAL_CODE_LENGTH) {
    const bytes = randomBytes(REFERRAL_CODE_LENGTH * 2);
    for (const byte of bytes) {
      if (byte >= rejectionBound) continue;
      code += REFERRAL_CODE_ALPHABET[byte % alphabetSize];
      if (code.length === REFERRAL_CODE_LENGTH) break;
    }
  }
  return code;
}

/** Input for {@link ReferralLinkCollection.createWithUniqueCode}. */
export interface CreateReferralLinkInput {
  referrerId: string;
  programId: string;
  targetUrl?: string;
  label?: string;
  tenantId?: string | null;
  /**
   * Test seam / customization point: overrides the random code generator.
   * Must return {@link REFERRAL_CODE_LENGTH} lowercase-alphanumeric
   * characters; collisions with existing codes are retried up to
   * {@link MAX_CODE_GENERATION_ATTEMPTS} times.
   */
  generateCode?: () => string;
}

/** Why {@link ReferralLinkCollection.recordClick} refused to record. */
export type RecordClickRefusal = 'unknown_code' | 'link_disabled';

/**
 * Result of {@link ReferralLinkCollection.recordClick}. On success `link`
 * and `touch` are both set and `refused` is absent. On refusal `touch` is
 * `null`, `refused` names the reason, and `link` carries the (disabled) link
 * for `'link_disabled'` / `null` for `'unknown_code'`.
 */
export interface RecordClickResult {
  link: ReferralLink | null;
  touch: ReferralTouch | null;
  refused?: RecordClickRefusal;
}

/** Input for {@link ReferralLinkCollection.recordClick}. */
export interface RecordClickInput {
  code: string;
  /** Extra evidence merged into the touch's evidence JSON (UA, IP hash, …). */
  evidence?: Record<string, unknown>;
  /** When the click occurred; defaults to now. */
  occurredAt?: Date;
}

export class ReferralLinkCollection extends SmrtCollection<ReferralLink> {
  static readonly _itemClass = ReferralLink;

  /** All links for a referrer, newest first. */
  async findByReferrer(referrerId: string): Promise<ReferralLink[]> {
    return await this.list({
      where: { referrerId },
      orderBy: 'created_at DESC',
    });
  }

  /**
   * Look up a link by its globally unique code (codes are minted lowercase;
   * the lookup normalizes case so shared codes survive re-typing).
   */
  async findByCode(code: string): Promise<ReferralLink | null> {
    const normalized = code.trim().toLowerCase();
    if (!normalized) return null;
    const results = await this.list({
      where: { code: normalized },
      limit: 1,
    });
    return results[0] ?? null;
  }

  /**
   * Create a link with a freshly minted, uniqueness-checked code.
   *
   * Codes come from `crypto.randomBytes` mapped to
   * {@link REFERRAL_CODE_LENGTH} lowercase-alphanumeric characters. The
   * check-then-insert loop retries on collision up to
   * {@link MAX_CODE_GENERATION_ATTEMPTS} times, then throws — at 36^10
   * possible codes repeated collisions mean the generator is broken (or a
   * test seam returns a constant), not bad luck.
   */
  async createWithUniqueCode(
    input: CreateReferralLinkInput,
  ): Promise<ReferralLink> {
    if (!input.referrerId || !input.programId) {
      throw new Error(
        'ReferralLinkCollection.createWithUniqueCode requires referrerId and programId',
      );
    }
    if (input.targetUrl) {
      // Fail before burning a code attempt on an invalid destination.
      assertHttpTargetUrl(input.targetUrl);
    }
    const generate = input.generateCode ?? generateReferralCode;

    for (let attempt = 0; attempt < MAX_CODE_GENERATION_ATTEMPTS; attempt++) {
      const code = generate();
      const existing = await this.findByCode(code);
      if (existing) continue;
      return await this.create({
        tenantId: input.tenantId,
        referrerId: input.referrerId,
        programId: input.programId,
        code,
        targetUrl: input.targetUrl ?? '',
        label: input.label ?? '',
        status: 'active',
      });
    }
    throw new Error(
      `ReferralLinkCollection.createWithUniqueCode: could not mint a unique code after ${MAX_CODE_GENERATION_ATTEMPTS} attempts — the code generator is returning colliding codes`,
    );
  }

  /**
   * Record a click on a share code: find the ACTIVE link, increment its
   * {@link ReferralLink.clickCount}, and write an immutable ReferralTouch
   * (kind `'click'`, evidence carrying the code/link/url plus any caller
   * evidence). Returns `{ link, touch }` on success.
   *
   * Refusals return a typed result instead of throwing (clicks arrive from
   * the edge — an unknown or disabled code is an expected outcome, not an
   * exception): `refused: 'unknown_code'` (no such code; `link: null`) or
   * `refused: 'link_disabled'` (link exists but is disabled; the link is
   * returned, nothing is written).
   */
  async recordClick(input: RecordClickInput): Promise<RecordClickResult> {
    const link = await this.findByCode(input.code);
    if (!link) {
      return { link: null, touch: null, refused: 'unknown_code' };
    }
    if (!link.isActive()) {
      return { link, touch: null, refused: 'link_disabled' };
    }

    const occurredAt = input.occurredAt ?? new Date();
    const touches = await ReferralTouchCollection.create({ db: this.db });
    const touch = await touches.create({
      tenantId: link.tenantId,
      linkId: link.id ?? '',
      code: link.code,
      referrerId: link.referrerId,
      programId: link.programId,
      kind: 'click',
      occurredAt,
      evidence: JSON.stringify({
        ...(input.evidence ?? {}),
        code: link.code,
        linkId: link.id ?? '',
        targetUrl: link.targetUrl,
      }),
    });

    link.clickCount += 1;
    await link.save();

    return { link, touch };
  }
}

export default ReferralLinkCollection;
