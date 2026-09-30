/**
 * ProfileLinkCollection - A profile's ordered web links
 *
 * Reads return a profile's links in display order; writes replace or reorder
 * the whole list in one transaction so a reader never sees half a list.
 */

import {
  isEmbeddedDatabase,
  SmrtCollection,
  withEmbeddedWriteTransaction,
} from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import {
  isProfileLinkPlatform,
  normalizeProfileLinkUrl,
  ProfileLink,
  type ProfileLinkPlatform,
} from '../models/ProfileLink';

/** One link as a caller supplies it, in display order. */
export interface ProfileLinkInput {
  platform: ProfileLinkPlatform;
  url: string;
  label?: string | null;
}

/** Most links one profile may hold. */
export const PROFILE_LINK_LIMIT = 50;

export class ProfileLinkCollection extends SmrtCollection<ProfileLink> {
  static readonly _itemClass = ProfileLink;

  /** The profile's links in display order (sortOrder, then age). */
  async listForProfile(profileId: string): Promise<ProfileLink[]> {
    if (!profileId) return [];
    const links = await this.list({ where: { profileId } });
    return links.sort(compareLinks);
  }

  /**
   * Makes the profile's links exactly `links`, in that order, in one
   * transaction: a link whose address is already on the profile keeps its row
   * (and id), new addresses are added, and links left out are removed. The
   * same address given twice is kept once, at its first position. New links
   * take the profile's tenant. Throws, changing nothing, when the profile is
   * not visible in the current tenant context or a link is invalid.
   */
  async replaceForProfile(
    profileId: string,
    links: readonly ProfileLinkInput[],
  ): Promise<ProfileLink[]> {
    const wanted = normalizeInputs(links);
    return this.inTransaction(async (bound) => {
      const tenantId = await bound.requireProfileTenant(profileId);
      const existing = await bound.listForProfile(profileId);
      const byUrl = new Map<string, ProfileLink>();
      for (const link of existing) {
        if (!byUrl.has(link.url)) byUrl.set(link.url, link);
      }

      const kept = new Set<ProfileLink>();
      const result: ProfileLink[] = [];
      for (const [index, input] of wanted.entries()) {
        const current = byUrl.get(input.url);
        if (current) {
          kept.add(current);
          const changed =
            current.platform !== input.platform ||
            (current.label ?? null) !== input.label ||
            current.sortOrder !== index ||
            (!current.tenantId && tenantId !== null);
          current.platform = input.platform;
          current.label = input.label;
          current.sortOrder = index;
          if (!current.tenantId && tenantId) current.tenantId = tenantId;
          if (changed) await current.save();
          result.push(current);
          continue;
        }
        const created = await bound.create({
          profileId,
          platform: input.platform,
          url: input.url,
          label: input.label,
          sortOrder: index,
          ...(tenantId ? { tenantId } : {}),
        });
        await created.save();
        result.push(created);
      }

      for (const link of existing) {
        if (!kept.has(link)) await link.delete();
      }
      return result;
    });
  }

  /**
   * Puts the profile's links in the order of `linkIds`, which must name every
   * link on the profile exactly once. One transaction; throws, changing
   * nothing, on a missing, extra or repeated id.
   */
  async reorder(
    profileId: string,
    linkIds: readonly string[],
  ): Promise<ProfileLink[]> {
    return this.inTransaction(async (bound) => {
      await bound.requireProfileTenant(profileId);
      const existing = await bound.listForProfile(profileId);
      const byId = new Map(existing.map((link) => [String(link.id), link]));
      const ids = linkIds.map(String);
      if (
        ids.length !== existing.length ||
        new Set(ids).size !== ids.length ||
        ids.some((id) => !byId.has(id))
      ) {
        throw new Error(
          'Reorder must list every link on the profile exactly once',
        );
      }
      const ordered: ProfileLink[] = [];
      for (const [index, id] of ids.entries()) {
        const link = byId.get(id) as ProfileLink;
        if (link.sortOrder !== index) {
          link.sortOrder = index;
          await link.save();
        }
        ordered.push(link);
      }
      return ordered;
    });
  }

  /** The profile's tenant; throws when the profile is not visible here. */
  private async requireProfileTenant(
    profileId: string,
  ): Promise<string | null> {
    if (!profileId) throw new Error('A profile link needs a profile');
    const { ProfileCollection } = await import('./ProfileCollection');
    const profiles = await ProfileCollection.create({ db: this.db });
    const profile = await profiles.get({ id: profileId });
    if (!profile) throw new Error(`Profile '${profileId}' not found`);
    return profile.tenantId ?? null;
  }

  private async inTransaction<T>(
    work: (bound: ProfileLinkCollection) => Promise<T>,
  ): Promise<T> {
    const db = this.db as DatabaseInterface;
    return withEmbeddedWriteTransaction(
      db,
      isEmbeddedDatabase(db),
      async (transaction) =>
        work(await ProfileLinkCollection.create({ db: transaction })),
    );
  }
}

function compareLinks(a: ProfileLink, b: ProfileLink): number {
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  const aTime = new Date(a.created_at ?? 0).getTime();
  const bTime = new Date(b.created_at ?? 0).getTime();
  if (aTime !== bTime) return aTime - bTime;
  return String(a.id).localeCompare(String(b.id));
}

function normalizeInputs(
  links: readonly ProfileLinkInput[],
): Array<{ platform: ProfileLinkPlatform; url: string; label: string | null }> {
  if (links.length > PROFILE_LINK_LIMIT) {
    throw new Error(
      `A profile can hold at most ${PROFILE_LINK_LIMIT} links (got ${links.length})`,
    );
  }
  const seen = new Set<string>();
  const out: Array<{
    platform: ProfileLinkPlatform;
    url: string;
    label: string | null;
  }> = [];
  for (const link of links) {
    if (!isProfileLinkPlatform(link.platform)) {
      throw new Error(`Unknown profile link platform: ${link.platform}`);
    }
    const url = normalizeProfileLinkUrl(link.url);
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({
      platform: link.platform,
      url,
      label: link.label?.trim() ? link.label.trim() : null,
    });
  }
  return out;
}
