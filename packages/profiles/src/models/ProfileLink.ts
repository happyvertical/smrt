/**
 * ProfileLink model - An ordered web link on a profile
 *
 * A profile's social accounts and websites: one row per link, ordered by
 * `sortOrder`, several links per platform allowed ("Website", "Other").
 * Links belong to their profile's tenant and are removed with the profile.
 */

import {
  field,
  foreignKey,
  SmrtObject,
  type SmrtObjectOptions,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

/** Where a profile link points. `website` and `other` accept any web address. */
export const PROFILE_LINK_PLATFORMS = [
  'facebook',
  'instagram',
  'x',
  'linkedin',
  'youtube',
  'tiktok',
  'website',
  'other',
] as const;

export type ProfileLinkPlatform = (typeof PROFILE_LINK_PLATFORMS)[number];

/** Longest address a link may hold. */
export const PROFILE_LINK_MAX_URL_LENGTH = 2048;

/** Longest label a link may hold. */
export const PROFILE_LINK_MAX_LABEL_LENGTH = 200;

export function isProfileLinkPlatform(
  value: unknown,
): value is ProfileLinkPlatform {
  return (
    typeof value === 'string' &&
    (PROFILE_LINK_PLATFORMS as readonly string[]).includes(value)
  );
}

/**
 * The address as a normalized http(s) URL. Throws for anything else: other
 * schemes (`javascript:`, `data:`, `mailto:`), embedded credentials, blanks,
 * whitespace, or over-long values.
 */
export function normalizeProfileLinkUrl(raw: string): string {
  const text = String(raw ?? '').trim();
  if (!text) throw new Error('A profile link needs a web address');
  if (text.length > PROFILE_LINK_MAX_URL_LENGTH || /\s/.test(text)) {
    throw new Error('A profile link must be a single web address');
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`Not a web address: ${text}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('A profile link must start with http:// or https://');
  }
  if (url.username || url.password) {
    throw new Error('A profile link cannot carry a user name or password');
  }
  if (!url.hostname) throw new Error(`Not a web address: ${text}`);
  return url.toString();
}

export interface ProfileLinkOptions extends SmrtObjectOptions {
  profileId?: string;
  platform?: ProfileLinkPlatform;
  url?: string;
  label?: string | null;
  sortOrder?: number;
  tenantId?: string | null;
}

@TenantScoped({ mode: 'optional' })
@smrt({
  tableName: 'profile_links',
  api: false,
  mcp: false,
  cli: false,
})
export class ProfileLink extends SmrtObject {
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  @foreignKey('Profile', { required: true, onDelete: 'CASCADE' })
  profileId = '';

  /** One of {@link PROFILE_LINK_PLATFORMS}. */
  @field({ required: true, maxLength: 32 })
  platform: ProfileLinkPlatform = 'website';

  /** A normalized http(s) address. */
  @field({ required: true, maxLength: 2048 })
  url = '';

  /** Optional words shown instead of the address ("Campaign site"). */
  @field({ nullable: true, maxLength: 200 })
  label: string | null = null;

  /** Position in the profile's list, from 0. */
  @field()
  sortOrder = 0;

  constructor(options: ProfileLinkOptions = {}) {
    super(options);
    if (options.profileId) this.profileId = options.profileId;
    if (options.platform) this.platform = options.platform;
    if (options.url) this.url = options.url;
    if (options.label !== undefined) this.label = options.label;
    if (options.sortOrder !== undefined) this.sortOrder = options.sortOrder;
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
  }

  /**
   * A link's address and label are not its identity: two people can link the
   * same page, and one person can relabel a link. Without an explicit slug
   * the default (label-derived) slug would make a new link adopt another row
   * through the (tenant, slug, context) natural key, so a link's default slug
   * is its id.
   */
  override async getSlug(): Promise<string | null | undefined> {
    if (!this.slug && this.id) this.slug = String(this.id);
    return super.getSlug();
  }

  /** Validates and normalizes the link before it is written. */
  override async save(...args: Parameters<SmrtObject['save']>): Promise<this> {
    if (!this.profileId) throw new Error('A profile link needs a profile');
    if (!isProfileLinkPlatform(this.platform)) {
      throw new Error(`Unknown profile link platform: ${this.platform}`);
    }
    this.url = normalizeProfileLinkUrl(this.url);
    const label = this.label?.trim() ?? '';
    if (label.length > PROFILE_LINK_MAX_LABEL_LENGTH) {
      throw new Error('A profile link label is too long');
    }
    this.label = label || null;
    if (!Number.isInteger(this.sortOrder) || this.sortOrder < 0) {
      throw new Error('A profile link sortOrder must be a whole number ≥ 0');
    }
    return super.save(...args);
  }
}
