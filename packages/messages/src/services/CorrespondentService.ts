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
 * - Access follows the mail. Each row keeps a per-account breakdown, and every
 *   view (`list`/`suggest`/`get`) is computed from the accounts the viewer can
 *   read right now: counts, dates, name and `accountIds` never include an
 *   account that was revoked, and a row with no readable account is hidden.
 * - `refresh()` only touches what it scanned. An empty readable set (no
 *   policy, tenant mismatch, no `read` scope) changes nothing; otherwise only
 *   the scanned accounts' entries are replaced, so a narrower principal can
 *   never erase data from accounts outside its view.
 * - Delegated principals (a host scope or account ceiling, or a principal id
 *   that is not the user id, as agent credentials are) get nothing and cannot
 *   write unless the host passes `allowDelegated: true`, the explicit owner
 *   consent to act on the owner's private rows.
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
  /**
   * Let a delegated principal (agent credential with ceilings) use the
   * owner's private correspondents. Off by default; hosts turn it on only
   * with the owner's consent.
   */
  allowDelegated?: boolean;
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

interface AccountEntry {
  sent: number;
  received: number;
  first: number | null;
  last: number | null;
  name: string;
  nameAt: number;
}

type Breakdown = Record<string, AccountEntry>;

function parseBreakdown(row: Correspondent): Breakdown {
  try {
    const parsed = JSON.parse(row.accountBreakdown || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Breakdown)
      : {};
  } catch {
    return {};
  }
}

/** The row as the viewer may see it: readable accounts only, else null. */
function viewOf(
  row: Correspondent,
  readable: ReadonlySet<string>,
): CorrespondentView | null {
  const all = parseBreakdown(row);
  const ids = Object.keys(all).filter((id) => readable.has(id));
  // A linked row that was reset (no account contributes) stays reachable so
  // its owner can still unlink it.
  const reset = Object.keys(all).length === 0 && Boolean(row.profileId);
  if (!ids.length && !reset) return null;
  let sent = 0;
  let received = 0;
  let first: number | null = null;
  let last: number | null = null;
  let name = '';
  let nameAt = -1;
  for (const id of ids) {
    const e = all[id];
    sent += e.sent;
    received += e.received;
    if (e.first !== null)
      first = first === null ? e.first : Math.min(first, e.first);
    if (e.last !== null) last = last === null ? e.last : Math.max(last, e.last);
    if (e.name && e.nameAt >= nameAt) {
      name = e.name;
      nameAt = e.nameAt;
    }
  }
  return {
    id: row.id as string,
    address: row.address,
    displayName: name,
    messageCount: sent + received,
    sentCount: sent,
    receivedCount: received,
    firstContactAt: first === null ? null : new Date(first),
    lastContactAt: last === null ? null : new Date(last),
    accountIds: ids.sort(),
    profileId: row.profileId,
  };
}

export class CorrespondentService {
  constructor(private readonly options: CorrespondentServiceOptions) {}

  private get ownerUserId(): string | null {
    const { principal } = this.options;
    return principal.userId ?? principal.id ?? null;
  }

  /** Agent-style principal acting under ceilings or a credential id. */
  private get delegated(): boolean {
    const { principal } = this.options;
    return Boolean(
      principal.scopes ||
        principal.accountIds ||
        (principal.id && principal.userId && principal.id !== principal.userId),
    );
  }

  /** The owner whose rows this principal may use, or null. */
  private get actingOwner(): string | null {
    if (this.delegated && !this.options.allowDelegated) return null;
    return this.ownerUserId;
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
   * Re-derive this owner's correspondents from readable mail. Idempotent.
   * Only the scanned (readable) accounts' entries are replaced; entries of
   * accounts outside the scan are kept as they are. Nothing changes when no
   * account is readable. Addresses of the scanned accounts are not
   * correspondents. A delegated principal is refused.
   */
  async refresh(): Promise<CorrespondentRefreshResult> {
    const result: CorrespondentRefreshResult = {
      upserted: 0,
      removed: 0,
      scanned: 0,
    };
    if (this.delegated && !this.options.allowDelegated) {
      throw new Error('Correspondents are private to their owner.');
    }
    const owner = this.actingOwner;
    const { tenantId, db } = this.options;
    if (!owner) return result;
    const accounts = await readableMailAccounts(this.searchOptions());
    const ids = accounts.map((a) => a.id);
    // No readable account (no policy, tenant mismatch, no read scope): there
    // is no evidence about any row, so none is changed.
    if (!ids.length) return result;
    const scanned = new Set(ids);

    const own = new Set<string>(await this.ownAddresses(ids));
    const aggs = new Map<string, Breakdown>();
    const touch = (
      party: Party,
      kind: 'sent' | 'received',
      at: number,
      accountId: string,
    ) => {
      if (own.has(party.address)) return;
      let perAccount = aggs.get(party.address);
      if (!perAccount) {
        perAccount = {};
        aggs.set(party.address, perAccount);
      }
      let e = perAccount[accountId];
      if (!e) {
        e = {
          sent: 0,
          received: 0,
          first: null,
          last: null,
          name: '',
          nameAt: -1,
        };
        perAccount[accountId] = e;
      }
      if (kind === 'sent') e.sent += 1;
      else e.received += 1;
      if (at) {
        e.first = e.first === null ? at : Math.min(e.first, at);
        e.last = e.last === null ? at : Math.max(e.last, at);
      }
      if (party.name && at >= e.nameAt) {
        e.name = party.name;
        e.nameAt = at;
      }
    };

    await withTenant({ tenantId }, () =>
      runWithMailSystemAccess(async () => {
        const emails = await EmailCollection.create({ db });
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

    await withTenant({ tenantId }, async () => {
      const rows = await this.rows();
      const existing = (await rows.list({
        where: { tenantId, ownerUserId: owner },
        limit: 100000,
      })) as Correspondent[];
      const byAddress = new Map(existing.map((r) => [r.address, r]));
      const addresses = new Set([...aggs.keys(), ...byAddress.keys()]);
      for (const address of addresses) {
        let row = byAddress.get(address);
        // Keep entries of accounts outside the scan; replace scanned ones.
        const merged: Breakdown = {};
        if (row) {
          for (const [id, e] of Object.entries(parseBreakdown(row))) {
            if (!scanned.has(id)) merged[id] = e;
          }
        }
        Object.assign(merged, aggs.get(address) ?? {});
        if (!Object.keys(merged).length && row && !row.profileId) {
          await row.delete();
          result.removed += 1;
          continue;
        }
        if (!row) {
          row = await rows.create({ tenantId, ownerUserId: owner, address });
        }
        let sent = 0;
        let received = 0;
        let first: number | null = null;
        let last: number | null = null;
        let name = '';
        let nameAt = -1;
        for (const e of Object.values(merged)) {
          sent += e.sent;
          received += e.received;
          if (e.first !== null)
            first = first === null ? e.first : Math.min(first, e.first);
          if (e.last !== null)
            last = last === null ? e.last : Math.max(last, e.last);
          if (e.name && e.nameAt >= nameAt) {
            name = e.name;
            nameAt = e.nameAt;
          }
        }
        row.accountBreakdown = JSON.stringify(merged);
        row.accountIds = JSON.stringify(Object.keys(merged).sort());
        row.sentCount = sent;
        row.receivedCount = received;
        row.messageCount = sent + received;
        row.firstContactAt = first === null ? null : new Date(first);
        row.lastContactAt = last === null ? null : new Date(last);
        row.displayName = name || row.displayName;
        await row.save();
        result.upserted += 1;
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

  /** The owner's correspondents, as seen through the readable accounts. */
  private async visible(): Promise<CorrespondentView[]> {
    const owner = this.actingOwner;
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
      const views: CorrespondentView[] = [];
      for (const r of rows) {
        const v = viewOf(r, readable);
        if (v?.accountIds.length) views.push(v);
      }
      return views.sort(
        (a, b) =>
          (b.lastContactAt?.getTime() ?? 0) -
            (a.lastContactAt?.getTime() ?? 0) ||
          a.address.localeCompare(b.address),
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
    return {
      correspondents: all.slice(start, start + limit),
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
    const scored: Array<{ view: CorrespondentView; rank: number }> = [];
    for (const view of await this.visible()) {
      const name = view.displayName.toLowerCase();
      let rank = -1;
      if (view.address.startsWith(p)) rank = 0;
      else if (name.startsWith(p)) rank = 1;
      else if (name.split(/\s+/).some((w) => w.startsWith(p))) rank = 2;
      else if (view.address.includes(p)) rank = 3;
      if (rank >= 0) scored.push({ view, rank });
    }
    scored.sort(
      (a, b) =>
        a.rank - b.rank ||
        b.view.messageCount - a.view.messageCount ||
        a.view.address.localeCompare(b.view.address),
    );
    return scored.slice(0, cap).map((s) => s.view);
  }

  private async owned(
    id: string,
  ): Promise<{ row: Correspondent; view: CorrespondentView } | null> {
    const owner = this.actingOwner;
    if (!owner) return null;
    const readable = await this.readableIds();
    if (!readable.size) return null;
    return withTenant({ tenantId: this.options.tenantId }, async () => {
      const found = (
        (await (
          await this.rows()
        ).list({
          where: { tenantId: this.options.tenantId, ownerUserId: owner, id },
          limit: 1,
        })) as Correspondent[]
      )[0];
      if (!found) return null;
      const view = viewOf(found, readable);
      return view ? { row: found, view } : null;
    });
  }

  async get(id: string): Promise<CorrespondentView | null> {
    return (await this.owned(id))?.view ?? null;
  }

  private assertMayWrite(): void {
    if (this.delegated && !this.options.allowDelegated) {
      throw new Error('Correspondents are private to their owner.');
    }
  }

  /** Link a correspondent to a `Profile` of this tenant (owner's choice). */
  async linkProfile(id: string, profileId: string): Promise<CorrespondentView> {
    this.assertMayWrite();
    const hit = await this.owned(id);
    if (!hit) throw new Error('Correspondent not found.');
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
    hit.row.profileId = profileId;
    await withTenant({ tenantId: this.options.tenantId }, () => hit.row.save());
    return { ...hit.view, profileId };
  }

  async unlinkProfile(id: string): Promise<CorrespondentView> {
    this.assertMayWrite();
    const hit = await this.owned(id);
    if (!hit) throw new Error('Correspondent not found.');
    hit.row.profileId = null;
    await withTenant({ tenantId: this.options.tenantId }, () => hit.row.save());
    return { ...hit.view, profileId: null };
  }
}
