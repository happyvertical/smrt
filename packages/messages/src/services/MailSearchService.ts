/**
 * Per-account mail search (Epic I, I6, #5132).
 *
 * `MailSearchService` searches the mail a principal may read and nothing else:
 *
 * - The searchable accounts are exactly `MessagingSettingsService.listAccounts`
 *   with the `read` scope, so the decision is `decideMailAccess` (owner, grant,
 *   tenant ceiling, the host's scope and account ceilings) and fails closed
 *   without a principal, on a tenant mismatch or without `configureMailAccess`.
 *   An `accountIds` filter can only narrow that set; unreadable ids are dropped.
 * - Every local read is constrained to those account ids in the query itself
 *   and then runs as trusted code (`runWithMailSystemAccess`), because the
 *   decision was already made here with the explicit principal.
 * - Local search is a keyword scan over a bounded, newest-first candidate
 *   window (case-insensitive on every database), with optional semantic
 *   ranking through core `semanticSearchIds()` when `Email` embeddings are
 *   available. Provider search asks each account's own server through the
 *   SDK's `search()` and falls back to the local index, per account, when the
 *   provider cannot or does not answer.
 *
 * @packageDocumentation
 */

import type { SearchCriteria } from '@happyvertical/email';
import type { SmrtClassOptions } from '@happyvertical/smrt-core';
import { runWithMailSystemAccess } from '../access.js';
import { EmailAccountCollection } from '../collections/EmailAccountCollection.js';
import { EmailCollection } from '../collections/EmailCollection.js';
import { withTenant } from '../host.js';
import type { Email } from '../models/Email.js';
import type { EmailAccount } from '../models/EmailAccount.js';
import type { MessagingPrincipal } from '../permissions.js';
import {
  type MessagingAccountListing,
  MessagingSettingsService,
} from './MessagingSettingsService.js';

export interface MailSearchServiceOptions {
  db: SmrtClassOptions['db'];
  tenantId: string;
  /** The acting principal, as for `MessagingSettingsService`. */
  principal: MessagingPrincipal;
}

/** Filters shared by local and provider search. */
export interface MailSearchQuery {
  /** Free text matched against subject, body, sender name and address. */
  text?: string;
  /** Narrow to these accounts; ids the principal cannot read are ignored. */
  accountIds?: readonly string[];
  /** Sender address or name contains. */
  from?: string;
  /** A recipient (to or cc) address or name contains. */
  to?: string;
  subject?: string;
  /** Mailbox label or folder name or path (exact, case-insensitive). */
  label?: string;
  hasAttachment?: boolean;
  isRead?: boolean;
  isFlagged?: boolean;
  /** Sent on or after. */
  since?: Date;
  /** Sent before. */
  before?: Date;
  /** Page size, 1 to 100. Default 25. */
  limit?: number;
  /** The previous page's `nextCursor`. */
  cursor?: string | null;
  /**
   * `keyword` (default) never calls an embedding model. `semantic` ranks by
   * meaning and falls back to keyword when embeddings are unavailable;
   * `semanticUsed` on the result says which happened.
   */
  mode?: 'keyword' | 'semantic';
}

export interface MailSearchHit {
  accountId: string;
  /** Local `Email` row id; null for a provider hit not yet synced. */
  emailId: string | null;
  providerMessageId: string;
  threadId: string;
  subject: string;
  fromAddress: string;
  fromName: string;
  date: Date | null;
  snippet: string;
  isRead: boolean;
  isFlagged: boolean;
  hasAttachments: boolean;
  labels: string[];
  /** Where the hit came from. */
  source: 'local' | 'provider';
  /** Similarity in 0..1 when ranked semantically. */
  similarity?: number;
}

export interface MailSearchPage {
  hits: MailSearchHit[];
  nextCursor: string | null;
  /** Accounts that were searched (readable and, if given, requested). */
  accountIds: string[];
  /** True when the scan window ended before every candidate was examined. */
  truncated: boolean;
  semanticUsed: boolean;
}

export interface MailProviderSearchResult {
  hits: MailSearchHit[];
  /** Accounts answered by the provider. */
  providerAccountIds: string[];
  /** Accounts answered from the local index instead, with the reason. */
  fallbackAccounts: Array<{ accountId: string; reason: string }>;
  accountIds: string[];
  truncated: boolean;
}

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const SCAN_BATCH = 200;
/** Upper bound on rows examined by one local search call. */
const SCAN_LIMIT = 5000;
const SNIPPET_LENGTH = 200;

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error('Mail search limit must be a positive integer.');
  }
  return Math.min(limit, MAX_LIMIT);
}

function parseCursor(cursor: string | null | undefined): number {
  if (!cursor) return 0;
  const n = Number(cursor);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error('Invalid mail search cursor.');
  }
  return n;
}

const lower = (v: string | null | undefined) => (v ?? '').toLowerCase();

/** Addresses of a JSON `[{address, name}]` column as lower-cased haystacks. */
export function recipientHaystack(json: string | null | undefined): string {
  if (!json) return '';
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return lower(json);
    return parsed
      .map((p) =>
        typeof p === 'string' ? p : `${p?.address ?? ''} ${p?.name ?? ''}`,
      )
      .join(' ')
      .toLowerCase();
  } catch {
    return lower(json);
  }
}

function labelsOf(email: Email): string[] {
  const out = new Set<string>();
  for (const raw of [email.labels]) {
    try {
      const parsed = JSON.parse(raw || '[]');
      if (Array.isArray(parsed))
        for (const l of parsed) if (typeof l === 'string') out.add(l);
    } catch {
      // unreadable labels are treated as none
    }
  }
  if (email.folderPath) out.add(email.folderPath);
  return [...out];
}

function toHit(email: Email, similarity?: number): MailSearchHit {
  const body = (email.textBody || email.body || '').replace(/\s+/g, ' ');
  return {
    accountId: email.accountId,
    emailId: email.id ?? null,
    providerMessageId: email.providerMessageId,
    threadId: email.threadId,
    subject: email.subject,
    fromAddress: email.fromAddress,
    fromName: email.fromName,
    date: email.date ?? null,
    snippet: body.slice(0, SNIPPET_LENGTH),
    isRead: email.isRead,
    isFlagged: email.isFlagged,
    hasAttachments: email.hasAttachments,
    labels: labelsOf(email),
    source: 'local',
    ...(similarity === undefined ? {} : { similarity }),
  };
}

function matches(email: Email, q: MailSearchQuery): boolean {
  if (q.from) {
    const f = q.from.toLowerCase();
    if (!`${lower(email.fromAddress)} ${lower(email.fromName)}`.includes(f))
      return false;
  }
  if (q.to) {
    const t = q.to.toLowerCase();
    if (
      !`${recipientHaystack(email.toAddresses)} ${recipientHaystack(email.ccAddresses)}`.includes(
        t,
      )
    )
      return false;
  }
  if (q.subject && !lower(email.subject).includes(q.subject.toLowerCase()))
    return false;
  if (q.label) {
    const wanted = q.label.toLowerCase();
    if (!labelsOf(email).some((l) => l.toLowerCase() === wanted)) return false;
  }
  if (q.text) {
    const t = q.text.toLowerCase();
    const hay = `${lower(email.subject)} ${lower(email.textBody)} ${lower(
      email.body,
    )} ${lower(email.fromAddress)} ${lower(email.fromName)}`;
    // Every word must appear somewhere (order-free).
    for (const word of t.split(/\s+/).filter(Boolean)) {
      if (!hay.includes(word)) return false;
    }
  }
  return true;
}

/** SQL-expressible part of the query, always bound to the readable accounts. */
function structuredWhere(
  q: MailSearchQuery,
  tenantId: string,
  accountIds: string[],
): Record<string, unknown> {
  const where: Record<string, unknown> = {
    tenantId,
    'accountId in': accountIds,
  };
  if (q.hasAttachment !== undefined) where.hasAttachments = q.hasAttachment;
  if (q.isRead !== undefined) where.isRead = q.isRead;
  if (q.isFlagged !== undefined) where.isFlagged = q.isFlagged;
  if (q.since) where['date >='] = q.since;
  if (q.before) where['date <'] = q.before;
  return where;
}

export class MailSearchService {
  constructor(private readonly options: MailSearchServiceOptions) {}

  /** Accounts the principal may search: owner or `read` grant, nothing else. */
  async searchableAccounts(): Promise<MessagingAccountListing[]> {
    return readableMailAccounts(this.options);
  }

  private async scope(
    requested: readonly string[] | undefined,
  ): Promise<{ ids: string[]; accounts: MessagingAccountListing[] }> {
    const accounts = await this.searchableAccounts();
    const wanted = requested ? new Set(requested) : null;
    const chosen = accounts.filter((a) => !wanted || wanted.has(a.id));
    return { ids: chosen.map((a) => a.id), accounts: chosen };
  }

  /** Search the local index across every readable account. */
  async search(query: MailSearchQuery = {}): Promise<MailSearchPage> {
    const limit = clampLimit(query.limit);
    const start = parseCursor(query.cursor);
    const { ids } = await this.scope(query.accountIds);
    const empty: MailSearchPage = {
      hits: [],
      nextCursor: null,
      accountIds: ids,
      truncated: false,
      semanticUsed: false,
    };
    if (!ids.length) return empty;
    const { tenantId, db } = this.options;

    return withTenant({ tenantId }, () =>
      runWithMailSystemAccess(async () => {
        const emails = await EmailCollection.create({ db });
        const where = structuredWhere(query, tenantId, ids);

        if (query.mode === 'semantic' && query.text) {
          const ranked = await emails.semanticMatches(query.text, where);
          if (ranked?.length) {
            const hits: MailSearchHit[] = [];
            for (const match of ranked) {
              const email = (
                (await emails.list({
                  where: { ...where, id: match.id },
                  limit: 1,
                })) as Email[]
              )[0];
              if (email && matches(email, { ...query, text: undefined })) {
                hits.push(toHit(email, match.similarity));
              }
            }
            const page = hits.slice(start, start + limit);
            return {
              hits: page,
              nextCursor:
                start + limit < hits.length ? String(start + limit) : null,
              accountIds: ids,
              truncated: false,
              semanticUsed: true,
            };
          }
        }

        const hits: MailSearchHit[] = [];
        let scanned = start;
        let exhausted = false;
        while (hits.length < limit + 1 && scanned - start < SCAN_LIMIT) {
          const batch = (await emails.list({
            where,
            orderBy: ['date DESC', 'id ASC'],
            limit: SCAN_BATCH,
            offset: scanned,
          })) as Email[];
          for (const email of batch) {
            scanned += 1;
            if (matches(email, query)) hits.push(toHit(email));
            if (hits.length > limit) break;
          }
          if (batch.length < SCAN_BATCH) {
            exhausted = true;
            break;
          }
          if (hits.length > limit) break;
        }
        const more = hits.length > limit;
        const pageHits = hits.slice(0, limit);
        // Resume exactly after the last returned hit: re-scan is cheaper than
        // skipping results, so the cursor is the position of the first
        // unreturned candidate.
        let nextCursor: string | null = null;
        let truncated = false;
        if (more) {
          nextCursor = String(scanned - 1);
        } else if (!exhausted) {
          truncated = true;
          nextCursor = String(scanned);
        }
        return {
          hits: pageHits,
          nextCursor,
          accountIds: ids,
          truncated,
          semanticUsed: false,
        };
      }),
    );
  }

  /**
   * Ask each readable account's own server (SDK `search()`), falling back to
   * the local index for accounts whose provider cannot search or fails. One
   * account's failure never blocks the others. Provider hits that are already
   * synced carry their local `emailId`.
   */
  async searchProvider(
    query: MailSearchQuery = {},
  ): Promise<MailProviderSearchResult> {
    const limit = clampLimit(query.limit);
    const { ids, accounts } = await this.scope(query.accountIds);
    const result: MailProviderSearchResult = {
      hits: [],
      providerAccountIds: [],
      fallbackAccounts: [],
      accountIds: ids,
      truncated: false,
    };
    if (!ids.length) return result;
    const { tenantId, db } = this.options;
    const criteria = toSearchCriteria(query);

    for (const listing of accounts) {
      let answered = false;
      let reason = 'provider search unavailable';
      try {
        const hits = await withTenant({ tenantId }, () =>
          runWithMailSystemAccess(async () => {
            const emailAccounts = await EmailAccountCollection.create({ db });
            const account = (await emailAccounts.get({
              id: listing.id,
              tenantId,
            })) as EmailAccount | null;
            if (!account) throw new Error('account not found');
            const client = await account.createClient();
            try {
              await client.connect();
              const caps = await client.getCapabilities();
              if (!caps.search) {
                reason = 'provider does not support search';
                return null;
              }
              const found = await client.search(criteria);
              const emails = await EmailCollection.create({ db });
              const out: MailSearchHit[] = [];
              for (const msg of found.slice(0, limit)) {
                const local = msg.id
                  ? ((
                      await emails.list({
                        where: {
                          tenantId,
                          accountId: listing.id,
                          providerMessageId: msg.id,
                        },
                        limit: 1,
                      })
                    )[0] as Email | undefined)
                  : undefined;
                if (!matchesFlags(msg, query)) continue;
                out.push(
                  local
                    ? { ...toHit(local), source: 'provider' as const }
                    : {
                        accountId: listing.id,
                        emailId: null,
                        providerMessageId: msg.id ?? '',
                        threadId: msg.threadId ?? '',
                        subject: msg.subject ?? '',
                        fromAddress: msg.from?.address ?? '',
                        fromName: msg.from?.name ?? '',
                        date: msg.date ?? null,
                        snippet: (msg.text ?? '')
                          .replace(/\s+/g, ' ')
                          .slice(0, SNIPPET_LENGTH),
                        isRead: (msg.flags ?? []).includes('\\Seen' as never),
                        isFlagged: (msg.flags ?? []).includes(
                          '\\Flagged' as never,
                        ),
                        hasAttachments: (msg.attachments?.length ?? 0) > 0,
                        labels: msg.labels ?? [],
                        source: 'provider' as const,
                      },
                );
              }
              return out;
            } finally {
              await client.disconnect().catch(() => undefined);
            }
          }),
        );
        if (hits) {
          result.hits.push(...hits);
          result.providerAccountIds.push(listing.id);
          answered = true;
        }
      } catch (error) {
        reason =
          error instanceof Error
            ? error.message.slice(0, 200)
            : 'provider search failed';
      }
      if (!answered) {
        result.fallbackAccounts.push({ accountId: listing.id, reason });
        const local = await this.search({
          ...query,
          accountIds: [listing.id],
          cursor: null,
          mode: 'keyword',
        });
        result.hits.push(...local.hits);
        if (local.truncated) result.truncated = true;
      }
    }
    result.hits.sort(
      (a, b) => (b.date?.getTime() ?? 0) - (a.date?.getTime() ?? 0),
    );
    if (result.hits.length > limit) {
      result.hits = result.hits.slice(0, limit);
      result.truncated = true;
    }
    return result;
  }
}

function toSearchCriteria(q: MailSearchQuery): SearchCriteria {
  return {
    ...(q.text ? { q: q.text } : {}),
    ...(q.from ? { from: q.from } : {}),
    ...(q.to ? { to: q.to } : {}),
    ...(q.subject ? { subject: q.subject } : {}),
    ...(q.since ? { since: q.since } : {}),
    ...(q.before ? { before: q.before } : {}),
    ...(q.isRead === false ? { unread: true } : {}),
    ...(q.isFlagged ? { flagged: true } : {}),
  };
}

/** Flag filters the SDK criteria cannot express are applied to provider hits. */
function matchesFlags(
  msg: { flags?: readonly string[]; attachments?: unknown[] },
  q: MailSearchQuery,
): boolean {
  if (q.hasAttachment !== undefined) {
    if ((msg.attachments?.length ?? 0) > 0 !== q.hasAttachment) return false;
  }
  if (q.isRead === true && !(msg.flags ?? []).includes('\\Seen')) return false;
  return true;
}

/**
 * Accounts on which the principal holds `read`, paged out of
 * `listAccounts()` (the one account-discovery decision).
 */
export async function readableMailAccounts(
  options: MailSearchServiceOptions,
): Promise<MessagingAccountListing[]> {
  const settings = new MessagingSettingsService({
    db: options.db,
    tenantId: options.tenantId,
    principal: options.principal,
    resolvePersonaTenantId: async () => null,
  });
  const out: MessagingAccountListing[] = [];
  let cursor: string | null = null;
  do {
    const page = await settings.listAccounts({ limit: 200, cursor });
    for (const account of page.accounts) {
      if (account.scopes.includes('read')) out.push(account);
    }
    cursor = page.nextCursor;
  } while (cursor);
  return out;
}
