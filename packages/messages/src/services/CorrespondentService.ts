/**
 * Private correspondents (Epic I, I6, #5132).
 *
 * `CorrespondentService` derives and serves one person's correspondents from
 * the mail that person can read:
 *
 * - Private by construction. Every read and write filters on the acting
 *   user's id and the explicit tenant; there is no tenant-wide listing and no
 *   way to name another owner. A principal with no user id gets nothing.
 * - Derived, never invented. `refresh()` scans the readable accounts' mail
 *   (the same decision as search: `listAccounts` with `read`) and stores
 *   address, latest display name, counts, first and last contact and the
 *   accounts the address was seen in. It never creates or links a
 *   smrt-profiles `Profile`.
 * - Access follows the mail. `list()`/`suggest()` only return correspondents
 *   seen in an account the owner can still read, so revoking a grant hides
 *   what that account contributed even before the next `refresh()`.
 * - Linking is the owner's choice: `linkProfile()` stores a `Profile` id after
 *   checking the profile exists in the tenant; `unlinkProfile()` clears it.
 *
 * @packageDocumentation
 */

import type { SmrtClassOptions } from '@happyvertical/smrt-core';
import { runWithMailSystemAccess } from '../access.js';
import { CorrespondentCollection } from '../collections/CorrespondentCollection.js';
import { EmailCollection } from '../collections/EmailCollection.js';
import { readNotificationProfile, withTenant } from '../host.js';
import type { Correspondent } from '../models/Correspondent.js';
import type { Email } from '../models/Email.js';
import type { EmailAccount } from '../models/EmailAccount.js';
import type { MessagingPrincipal } from '../permissions.js';
import {
  type MailSearchServiceOptions,
  readableMailAccounts,
} from './MailSearchService.js';

export interface CorrespondentServiceOptions {
  db: SmrtClassOptions['db'];
  tenantId: string;
  principal: MessagingPrincipal;
}

export interface CorrespondentView {
  id: string;
  address: string;
  displayName: string;
  messageCount: number;
  sentCount: number;
  receivedCount: number;
  firstContactAt: Date | null;
  lastContactAt: Date | null;
  accountIds: string[];
  profileId: string | null;
}

export interface CorrespondentRefreshResult {
  /** Correspondents written (created or updated). */
  upserted: number;
  /** Rows removed because no readable mail mentions them any more. */
  removed: number;
  /** Mail rows examined. */
  scanned: number;
}

export interface ListCorrespondentsOptions {
  /** Substring of address or display name (case-insensitive). */
  query?: string;
  /** Page size, 1 to 200. Default 50. */
  limit?: number;
  /** Previous page's `nextCursor`. */
  cursor?: string | null;
}

const SCAN_BATCH = 500;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const SUGGEST_MAX = 20;
const EMAIL_PATTERN = /^[^\s@<>]+@[^\s@<>]+$/;

interface Party {
  address: string;
  name: string;
}

function parseParties(json: string | null | undefined): Party[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    const out: Party[] = [];
    for (const p of parsed) {
      const address = normalizeCorrespondentAddress(
        typeof p === 'string' ? p : p?.address,
      );
      if (address) {
        out.push({
          address,
          name: typeof p === 'object' && p?.name ? String(p.name).trim() : '',
        });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Lower-cased, trimmed address, or null when it is not an email address. */
export function normalizeCorrespondentAddress(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const address = value.trim().toLowerCase();
  return EMAIL_PATTERN.test(address) ? address : null;
}

function toView(row: Correspondent): CorrespondentView {
  return {
    id: row.id as string,
    address: row.address,
    displayName: row.displayName,
    messageCount: row.messageCount,
    sentCount: row.sentCount,
    receivedCount: row.receivedCount,
    firstContactAt: row.firstContactAt,
    lastContactAt: row.lastContactAt,
    accountIds: row.seenInAccountIds,
    profileId: row.profileId,
  };
}

interface Agg {
  name: string;
  nameAt: number;
  sent: number;
  received: number;
  first: number;
  last: number;
  accounts: Set<string>;
}

export class CorrespondentService {
  constructor(private readonly options: CorrespondentServiceOptions) {}

  private get ownerUserId(): string | null {
    const { principal } = this.options;
    return principal.userId ?? principal.id ?? null;
  }

  private searchOptions(): MailSearchServiceOptions {
    return this.options;
  }

  private async rows(): Promise<CorrespondentCollection> {
    return CorrespondentCollection.create({ db: this.options.db });
  }

  private async readableIds(): Promise<Set<string>> {
    return new Set(
      (await readableMailAccounts(this.searchOptions())).map((a) => a.id),
    );
  }

  /**
   * Re-derive this owner's correspondents from readable mail. Counts are
   * absolute (a full recompute), so the call is idempotent. Addresses of the
   * owner's own accounts are not correspondents.
   */
  async refresh(): Promise<CorrespondentRefreshResult> {
    const result: CorrespondentRefreshResult = {
      upserted: 0,
      removed: 0,
      scanned: 0,
    };
    const owner = this.ownerUserId;
    const { tenantId, db } = this.options;
    if (!owner) return result;
    const accounts = await readableMailAccounts(this.searchOptions());
    const ids = accounts.map((a) => a.id);

    const own = new Set<string>();
    const aggs = new Map<string, Agg>();
    const touch = (
      party: Party,
      kind: 'sent' | 'received',
      at: number,
      accountId: string,
    ) => {
      if (own.has(party.address)) return;
      let agg = aggs.get(party.address);
      if (!agg) {
        agg = {
          name: '',
          nameAt: -1,
          sent: 0,
          received: 0,
          first: at || Number.MAX_SAFE_INTEGER,
          last: at,
          accounts: new Set(),
        };
        aggs.set(party.address, agg);
      }
      if (kind === 'sent') agg.sent += 1;
      else agg.received += 1;
      if (at) {
        agg.first = Math.min(agg.first, at);
        agg.last = Math.max(agg.last, at);
      }
      if (party.name && at >= agg.nameAt) {
        agg.name = party.name;
        agg.nameAt = at;
      }
      agg.accounts.add(accountId);
    };

    if (ids.length) {
      await withTenant({ tenantId }, () =>
        runWithMailSystemAccess(async () => {
          const emails = await EmailCollection.create({ db });
          const own2 = await this.ownAddresses(ids);
          for (const a of own2) own.add(a);
          for (let offset = 0; ; offset += SCAN_BATCH) {
            const batch = (await emails.list({
              where: { tenantId, 'accountId in': ids },
              orderBy: ['id ASC'],
              limit: SCAN_BATCH,
              offset,
            })) as Email[];
            for (const email of batch) {
              result.scanned += 1;
              const at = email.date?.getTime() ?? 0;
              const sender = normalizeCorrespondentAddress(email.fromAddress);
              if (sender) {
                touch(
                  { address: sender, name: email.fromName?.trim() ?? '' },
                  'sent',
                  at,
                  email.accountId,
                );
              }
              for (const p of [
                ...parseParties(email.toAddresses),
                ...parseParties(email.ccAddresses),
              ]) {
                touch(p, 'received', at, email.accountId);
              }
            }
            if (batch.length < SCAN_BATCH) break;
          }
        }),
      );
    }

    await withTenant({ tenantId }, async () => {
      const rows = await this.rows();
      const existing = (await rows.list({
        where: { tenantId, ownerUserId: owner },
        limit: 100000,
      })) as Correspondent[];
      const byAddress = new Map(existing.map((r) => [r.address, r]));
      for (const [address, agg] of aggs) {
        const row =
          byAddress.get(address) ??
          (await rows.create({ tenantId, ownerUserId: owner, address }));
        row.displayName = agg.name || row.displayName;
        row.sentCount = agg.sent;
        row.receivedCount = agg.received;
        row.messageCount = agg.sent + agg.received;
        row.firstContactAt =
          agg.first === Number.MAX_SAFE_INTEGER ? null : new Date(agg.first);
        row.lastContactAt = agg.last ? new Date(agg.last) : null;
        row.accountIds = JSON.stringify([...agg.accounts].sort());
        await row.save();
        result.upserted += 1;
      }
      for (const row of existing) {
        if (aggs.has(row.address)) continue;
        if (row.profileId) {
          // The owner's link is theirs to keep; only the derived data resets.
          row.messageCount = 0;
          row.sentCount = 0;
          row.receivedCount = 0;
          row.accountIds = '[]';
          await row.save();
        } else {
          await row.delete();
          result.removed += 1;
        }
      }
    });
    return result;
  }

  private async ownAddresses(accountIds: string[]): Promise<string[]> {
    const { EmailAccountCollection } = await import(
      '../collections/EmailAccountCollection.js'
    );
    const accounts = await EmailAccountCollection.create({
      db: this.options.db,
    });
    const out: string[] = [];
    for (const id of accountIds) {
      const account = (await accounts.get({
        id,
        tenantId: this.options.tenantId,
      })) as EmailAccount | null;
      const addr = normalizeCorrespondentAddress(account?.email);
      if (addr) out.push(addr);
    }
    return out;
  }

  /** The owner's correspondents seen in a still-readable account. */
  private async visible(): Promise<Correspondent[]> {
    const owner = this.ownerUserId;
    if (!owner) return [];
    const readable = await this.readableIds();
    if (!readable.size) return [];
    return withTenant({ tenantId: this.options.tenantId }, async () => {
      const rows = (await (
        await this.rows()
      ).list({
        where: { tenantId: this.options.tenantId, ownerUserId: owner },
        orderBy: ['lastContactAt DESC', 'id ASC'],
        limit: 100000,
      })) as Correspondent[];
      return rows.filter((r) =>
        r.seenInAccountIds.some((id) => readable.has(id)),
      );
    });
  }

  async list(options: ListCorrespondentsOptions = {}): Promise<{
    correspondents: CorrespondentView[];
    nextCursor: string | null;
  }> {
    const requested = Number.isFinite(options.limit)
      ? Math.trunc(options.limit as number)
      : DEFAULT_LIMIT;
    const limit = Math.min(Math.max(requested, 1), MAX_LIMIT);
    const start = options.cursor ? Number(options.cursor) : 0;
    if (!Number.isInteger(start) || start < 0) {
      throw new Error('Invalid correspondent cursor.');
    }
    const q = options.query?.trim().toLowerCase();
    const all = (await this.visible()).filter(
      (r) =>
        !q || r.address.includes(q) || r.displayName.toLowerCase().includes(q),
    );
    const page = all.slice(start, start + limit);
    return {
      correspondents: page.map(toView),
      nextCursor: start + limit < all.length ? String(start + limit) : null,
    };
  }

  /**
   * Recipient autocomplete: correspondents whose address or name starts with
   * (or, for names, has a word starting with) `prefix`, best first.
   */
  async suggest(prefix: string, limit = 8): Promise<CorrespondentView[]> {
    const p = prefix.trim().toLowerCase();
    if (!p) return [];
    const cap = Math.min(Math.max(Math.trunc(limit) || 1, 1), SUGGEST_MAX);
    const scored: Array<{ row: Correspondent; rank: number }> = [];
    for (const row of await this.visible()) {
      const name = row.displayName.toLowerCase();
      let rank = -1;
      if (row.address.startsWith(p)) rank = 0;
      else if (name.startsWith(p)) rank = 1;
      else if (name.split(/\s+/).some((w) => w.startsWith(p))) rank = 2;
      else if (row.address.includes(p)) rank = 3;
      if (rank >= 0) scored.push({ row, rank });
    }
    scored.sort(
      (a, b) =>
        a.rank - b.rank ||
        b.row.messageCount - a.row.messageCount ||
        a.row.address.localeCompare(b.row.address),
    );
    return scored.slice(0, cap).map((s) => toView(s.row));
  }

  private async owned(id: string): Promise<Correspondent | null> {
    const owner = this.ownerUserId;
    if (!owner) return null;
    const readable = await this.readableIds();
    return withTenant({ tenantId: this.options.tenantId }, async () => {
      const row = (await (
        await this.rows()
      ).list({
        where: { tenantId: this.options.tenantId, ownerUserId: owner, id },
        limit: 1,
      })) as Correspondent[];
      const found = row[0];
      if (!found) return null;
      return found.seenInAccountIds.some((a) => readable.has(a)) ? found : null;
    });
  }

  async get(id: string): Promise<CorrespondentView | null> {
    const row = await this.owned(id);
    return row ? toView(row) : null;
  }

  /** Link a correspondent to a `Profile` of this tenant (owner's choice). */
  async linkProfile(id: string, profileId: string): Promise<CorrespondentView> {
    const row = await this.owned(id);
    if (!row) throw new Error('Correspondent not found.');
    const profile = await readNotificationProfile(
      this.options.db as never,
      this.options.tenantId,
      profileId,
    );
    if (
      !profile ||
      (profile.tenantId && profile.tenantId !== this.options.tenantId)
    ) {
      throw new Error('Profile not found.');
    }
    row.profileId = profileId;
    await withTenant({ tenantId: this.options.tenantId }, () => row.save());
    return toView(row);
  }

  async unlinkProfile(id: string): Promise<CorrespondentView> {
    const row = await this.owned(id);
    if (!row) throw new Error('Correspondent not found.');
    row.profileId = null;
    await withTenant({ tenantId: this.options.tenantId }, () => row.save());
    return toView(row);
  }
}
