/**
 * Cursor-based incremental mailbox sync (Epic I, #5130).
 *
 * `EmailAccount.syncChanges()` drives the mail server's change feed
 * (`EmailClient.getChanges()`, implemented by the JMAP adapter). The feed
 * cursor is opaque. Each batch is applied first and the cursor is saved only
 * afterwards, so a failed batch is simply fetched again, and applying a batch
 * twice is harmless because every row is keyed on the server's message id.
 * A `resync-required` answer clears the cursor and starts a full pass.
 *
 * Exactly one sync runs per account at a time (one lane per account): the
 * background job is deduplicated per account (see `mail-sync-jobs.ts`) and
 * direct calls queue behind each other inside this process.
 *
 * @packageDocumentation
 */

import type {
  ChangeFeedBatch,
  EmailClient,
  EmailMessage,
  Folder,
} from '@happyvertical/email';
import { ObjectRegistry } from '@happyvertical/smrt-core';
import type { EmailCollection } from './collections/EmailCollection';
import type { EmailFolderCollection } from './collections/EmailFolderCollection';
import type { Email } from './models/Email';
import type { EmailAccount } from './models/EmailAccount';
import type { EmailFolder } from './models/EmailFolder';

export interface MailSyncOptions {
  /** Messages requested per batch. Default 100. */
  limit?: number;
  /** Most batches one run applies before stopping with `hasMore`. Default 500. */
  maxBatches?: number;
  /**
   * Store no message dated before this (a `Date` or an ISO string, so it
   * survives a job's JSON args). Overrides `EmailAccount.backfillSince` for
   * this run; `null` lifts the account's horizon. Messages already stored are
   * still updated.
   */
  since?: Date | string | null;
}

export type MailSyncSkipReason = 'inactive' | 'needs-reconnect' | 'unsupported';

export interface MailSyncResult {
  /** `skipped` runs touched nothing (no client was built for closed accounts). */
  status: 'synced' | 'skipped';
  skipped?: MailSyncSkipReason;
  batches: number;
  added: number;
  changed: number;
  removed: number;
  /** The server rejected the saved cursor and a full pass was started. */
  resynced: boolean;
  /** The run stopped at `maxBatches` with more changes waiting. */
  hasMore: boolean;
  /** Messages left out because they are dated before the backfill horizon. */
  beforeHorizon: number;
  duration: number;
}

const DEFAULT_LIMIT = 100;
const DEFAULT_MAX_BATCHES = 500;
const PRUNE_PAGE = 500;

// One lane per account within this process; across processes the job dedupe
// slot keeps a single sync job per account.
const lanes = new Map<string, Promise<unknown>>();

export async function inLane<T>(
  accountId: string,
  run: () => Promise<T>,
): Promise<T> {
  const previous = lanes.get(accountId) ?? Promise.resolve();
  const next = previous.then(run, run);
  const tail = next.catch(() => undefined);
  lanes.set(accountId, tail);
  try {
    return await next;
  } finally {
    if (lanes.get(accountId) === tail) lanes.delete(accountId);
  }
}

/** Copy a server message onto an Email row. Shared by every sync path. */
export function applyServerMessage(
  email: Email,
  msg: EmailMessage,
  location: { folderId: string; folderPath: string },
  options: { keepBodies?: boolean; deriveState?: boolean } = {},
): void {
  email.messageId = msg.messageId || '';
  email.threadId = msg.threadId || '';
  email.inReplyTo = msg.inReplyTo || '';
  email.fromAddress = msg.from?.address || '';
  email.fromName = msg.from?.name || '';
  email.toAddresses = JSON.stringify(msg.to || []);
  email.ccAddresses = JSON.stringify(msg.cc || []);
  email.bccAddresses = JSON.stringify(msg.bcc || []);
  email.replyToAddress = msg.replyTo?.address || '';
  email.replyToName = msg.replyTo?.name || '';
  email.subject = msg.subject || '';
  email.date = msg.date || null;
  // A metadata-only change (flags, folder move) must not blank a stored body.
  const metadataOnly =
    options.keepBodies && msg.text === undefined && msg.html === undefined;
  if (!metadataOnly) {
    email.textBody = msg.text || '';
    email.htmlBody = msg.html || '';
    email.body = msg.text || '';
  }
  email.folderId = location.folderId;
  email.folderPath = location.folderPath;
  email.labels = JSON.stringify(msg.labels || []);
  email.flags = JSON.stringify(msg.flags || []);
  email.hasAttachments =
    (msg.attachments && msg.attachments.length > 0) || false;
  email.size = msg.size || 0;
  email.headers = JSON.stringify(msg.headers || {});
  email.updatedAt = new Date();
  if (options.deriveState) {
    const flags = new Set((msg.flags || []).map((f) => f.toLowerCase()));
    email.isRead = flags.has('\\seen');
    email.isFlagged = flags.has('\\flagged');
    email.isAnswered = flags.has('\\answered');
    email.isDraft = flags.has('\\draft');
  }
}

/**
 * JMAP folders are mailboxes a message may sit in several at once; keep them
 * all as labels when the server sent no provider labels. Shared by sync and
 * triage write-back so both store a server message identically.
 */
export function withMailboxLabels(msg: EmailMessage): EmailMessage {
  return msg.labels?.length || !msg.folders?.length
    ? msg
    : { ...msg, labels: msg.folders };
}

export interface SyncContext {
  account: EmailAccount;
  accountId: string;
  emails: EmailCollection;
  folders: EmailFolderCollection;
  childOptions: Record<string, unknown>;
  /** folder path -> folder row id */
  folderIds: Map<string, string>;
  /** Backfill horizon in effect for this run, if any. */
  horizon?: Date | null;
  /** Messages skipped for being older than the horizon. */
  beforeHorizon?: number;
}

export async function ensureFolder(
  ctx: SyncContext,
  path: string,
  details: Partial<Folder> = {},
): Promise<string> {
  let folder: EmailFolder | null = await ctx.folders.getByPath(
    ctx.accountId,
    path,
  );
  if (!folder) {
    const { EmailFolder: EmailFolderModel } = await import(
      './models/EmailFolder'
    );
    folder = new (ObjectRegistry.resolveEffectiveConstructor(EmailFolderModel))(
      {
        ...ctx.childOptions,
        accountId: ctx.accountId,
        name: details.name || path,
        path,
      },
    );
    await folder.initialize();
  }
  if (details.name !== undefined) folder.name = details.name;
  if (details.delimiter !== undefined) folder.delimiter = details.delimiter;
  folder.specialUse = details.specialUse ?? folder.specialUse ?? '';
  if (details.subscribed !== undefined) folder.subscribed = details.subscribed;
  folder.updatedAt = new Date();
  await folder.save();
  const id = folder.id ?? '';
  ctx.folderIds.set(path, id);
  return id;
}

export async function folderIdFor(
  ctx: SyncContext,
  path: string,
): Promise<string> {
  if (!path) return '';
  return ctx.folderIds.get(path) ?? (await ensureFolder(ctx, path));
}

async function findByProviderId(
  ctx: SyncContext,
  providerMessageId: string,
): Promise<Email[]> {
  return (await ctx.emails.list({
    where: { accountId: ctx.accountId, providerMessageId },
  })) as Email[];
}

async function upsertMessage(
  ctx: SyncContext,
  msg: EmailMessage,
  touched: Set<string>,
  isChange: boolean,
): Promise<void> {
  if (!msg.id)
    throw new Error('Mail change feed returned a message without an id');
  const [existing] = await findByProviderId(ctx, msg.id);
  if (
    !existing &&
    ctx.horizon &&
    msg.date &&
    new Date(msg.date).getTime() < ctx.horizon.getTime()
  ) {
    ctx.beforeHorizon = (ctx.beforeHorizon ?? 0) + 1;
    return;
  }
  const folderPath = msg.folder ?? msg.folders?.[0] ?? '';
  const folderId = await folderIdFor(ctx, folderPath);
  let email = existing;
  if (!email) {
    const { Email: EmailModel } = await import('./models/Email');
    email = new (ObjectRegistry.resolveEffectiveConstructor(EmailModel))({
      ...ctx.childOptions,
      accountId: ctx.accountId,
    });
    await email.initialize();
  } else if (email.folderId) {
    touched.add(email.folderId);
  }
  email.providerMessageId = msg.id;
  applyServerMessage(
    email,
    withMailboxLabels(msg),
    { folderId, folderPath },
    { keepBodies: isChange, deriveState: true },
  );
  await email.save();
  if (folderId) touched.add(folderId);
}

async function removeMessages(
  ctx: SyncContext,
  ids: string[],
  touched: Set<string>,
): Promise<number> {
  let removed = 0;
  for (const id of ids) {
    for (const email of await findByProviderId(ctx, id)) {
      if (email.folderId) touched.add(email.folderId);
      await email.delete();
      removed++;
    }
  }
  return removed;
}

/** Drop stored messages the server no longer has after a complete full pass. */
async function pruneUnseen(
  ctx: SyncContext,
  seen: Set<string>,
  touched: Set<string>,
): Promise<number> {
  let removed = 0;
  for (let offset = 0; ; offset += PRUNE_PAGE) {
    const page = (await ctx.emails.list({
      where: { accountId: ctx.accountId },
      limit: PRUNE_PAGE,
      offset,
    })) as Email[];
    for (const email of page) {
      if (!email.providerMessageId || seen.has(email.providerMessageId))
        continue;
      if (email.folderId) touched.add(email.folderId);
      await email.delete();
      removed++;
      offset--; // the next row slid into this slot
    }
    if (page.length < PRUNE_PAGE) return removed;
  }
}

export async function refreshCounts(
  ctx: SyncContext,
  folderIds: Set<string>,
): Promise<void> {
  for (const folderId of folderIds) {
    const folder = await ctx.folders.get({ id: folderId });
    if (!folder) continue;
    folder.messageCount = await ctx.emails.countByFolder(folderId);
    folder.unreadCount = await ctx.emails.countUnreadByFolder(folderId);
    await folder.save();
  }
}

/**
 * Recompute every folder's counts from the stored messages. A batch that
 * deleted or moved messages and then failed before refreshCounts() leaves its
 * mutations persisted but the cursor unmoved; on replay those rows are gone or
 * already moved, so the folders they left never enter `touched`. Reconciling
 * every folder up front repairs that.
 */
async function reconcileAllCounts(ctx: SyncContext): Promise<void> {
  const folders = (await ctx.folders.list({
    where: { accountId: ctx.accountId },
  })) as Array<{ id?: string }>;
  await refreshCounts(
    ctx,
    new Set(folders.map((f) => f.id).filter((id): id is string => !!id)),
  );
}

async function applyBatch(
  ctx: SyncContext,
  batch: ChangeFeedBatch,
  seen: Set<string> | null,
): Promise<{
  added: number;
  changed: number;
  removed: number;
  touched: Set<string>;
}> {
  const touched = new Set<string>();
  for (const folder of batch.folders ?? []) {
    await ensureFolder(ctx, folder.path, folder);
  }
  for (const msg of batch.added) {
    await upsertMessage(ctx, msg, touched, false);
    if (seen && msg.id) seen.add(msg.id);
  }
  for (const msg of batch.changed) {
    await upsertMessage(ctx, msg, touched, true);
    if (seen && msg.id) seen.add(msg.id);
  }
  const removed = await removeMessages(ctx, batch.removed, touched);
  return {
    added: batch.added.length,
    changed: batch.changed.length,
    removed,
    touched,
  };
}

/** Whether `next` reaches back further than the horizon a cursor was built under. */
function widensHorizon(
  built: Date | null,
  next: Date | null | undefined,
): boolean {
  if (!built) return false; // built unbounded: nothing was dropped
  if (!next) return true;
  return next.getTime() < new Date(built).getTime();
}

function resolveHorizon(
  since: MailSyncOptions['since'],
  stored: Date | null,
): Date | null {
  const value = since === undefined ? stored : since;
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid mail backfill horizon: ${String(value)}`);
  }
  return date;
}

/** Copy the fields a sync run changes (and the revision token) onto `target`. */
function mirrorAccountState(from: EmailAccount, to: EmailAccount): void {
  to.syncCursor = from.syncCursor;
  to.cursorHorizon = from.cursorHorizon;
  to.lastSyncAt = from.lastSyncAt;
  to.connectionStatus = from.connectionStatus;
  to.statusMessage = from.statusMessage;
  to.lastSyncError = from.lastSyncError;
  to.backlog = from.backlog;
  to.isActive = from.isActive;
  to.updatedAt = from.updatedAt;
  (to as unknown as { updated_at: unknown }).updated_at = (
    from as unknown as { updated_at: unknown }
  ).updated_at;
}

async function persistCursor(
  account: EmailAccount,
  cursor: string | null,
  horizon: Date | null = null,
): Promise<void> {
  account.syncCursor = cursor;
  // The cursor now covers mail as far back as this horizon (null: everything).
  account.cursorHorizon = horizon;
  account.updatedAt = new Date();
  await account.save();
}

export async function rethrowAfterAuthCheck(
  account: EmailAccount,
  error: unknown,
  isAuthFailure: (e: unknown) => boolean,
  options: { recordError?: boolean } = {},
): Promise<never> {
  const err = error instanceof Error ? error : new Error(String(error));
  if (options.recordError) {
    // Persist why the run failed; never touches connectionStatus here.
    account.lastSyncError = err.message.slice(0, 500);
    account.updatedAt = new Date();
    await account.save().catch(() => undefined);
  }
  if (isAuthFailure(err)) {
    // The server refused the saved sign-in: ask the owner to reconnect, and
    // tell the job runner that retrying cannot help.
    await account.markNeedsReconnect(err.message).catch(() => undefined);
    (err as Error & { retryable?: boolean }).retryable = false;
  }
  throw err;
}

/**
 * Sync one account from its server's change feed. See the module comment;
 * call `EmailAccount.syncChanges()` rather than this directly.
 */
export async function syncMailChanges(
  source: EmailAccount,
  options: MailSyncOptions = {},
  deps: {
    createClient: (account: EmailAccount) => Promise<EmailClient>;
    childOptions: Record<string, unknown>;
    isAuthFailure: (error: unknown) => boolean;
  },
): Promise<MailSyncResult> {
  if (!source.id) {
    throw new Error('EmailAccount.syncChanges requires a persisted account');
  }
  const accountId = source.id;
  return inLane(accountId, async () => {
    const startedAt = Date.now();
    const result: MailSyncResult = {
      status: 'synced',
      batches: 0,
      added: 0,
      changed: 0,
      removed: 0,
      resynced: false,
      hasMore: false,
      beforeHorizon: 0,
      duration: 0,
    };
    const skip = (reason: MailSyncSkipReason): MailSyncResult => ({
      ...result,
      status: 'skipped',
      skipped: reason,
      duration: Date.now() - startedAt,
    });

    // Another run in this lane may have moved the cursor or closed the
    // account since the caller loaded it, and the row is revision-guarded: work
    // on the stored row, and copy the outcome back onto the caller's instance.
    const { EmailAccountCollection } = await import(
      './collections/EmailAccountCollection'
    );
    const accounts = await EmailAccountCollection.create(deps.childOptions);
    const account =
      ((await accounts.get({ id: accountId })) as EmailAccount | null) ??
      source;
    try {
      return await runLane(account);
    } finally {
      if (account !== source) mirrorAccountState(account, source);
    }

    async function runLane(account: EmailAccount): Promise<MailSyncResult> {
      if (!account.isActive) return skip('inactive');
      if (account.needsReconnect) return skip('needs-reconnect');

      const limit = options.limit ?? DEFAULT_LIMIT;
      const maxBatches = options.maxBatches ?? DEFAULT_MAX_BATCHES;
      let client: EmailClient | undefined;
      try {
        client = await deps.createClient(account);
        await client.connect();
        if (typeof client.getChanges !== 'function') return skip('unsupported');

        const { EmailCollection: EmailCollectionClass } = await import(
          './collections/EmailCollection'
        );
        const { EmailFolderCollection: FolderCollectionClass } = await import(
          './collections/EmailFolderCollection'
        );
        const ctx: SyncContext = {
          account,
          accountId,
          emails: await EmailCollectionClass.create(deps.childOptions),
          folders: await FolderCollectionClass.create(deps.childOptions),
          childOptions: deps.childOptions,
          folderIds: new Map(),
          horizon: resolveHorizon(options.since, account.backfillSince),
          beforeHorizon: 0,
        };

        await reconcileAllCounts(ctx);

        // A saved cursor is past mail the horizon it was built under dropped.
        // Widening or clearing the horizon must refetch that mail: restart
        // with a full pass (which also prunes). Narrowing needs nothing.
        if (
          account.syncCursor &&
          widensHorizon(account.cursorHorizon, ctx.horizon)
        ) {
          await persistCursor(account, null, ctx.horizon);
        }
        let cursor: string | undefined = account.syncCursor || undefined;
        // A pass that starts without a cursor sees every server message, so what
        // it did not see is gone; a resumed pass cannot know and never prunes.
        let seen: Set<string> | null = cursor === undefined ? new Set() : null;

        while (result.batches < maxBatches) {
          const next = await client.getChanges({
            cursor,
            limit,
            includeBodies: true,
          });
          // (not the SDK's isResyncRequired: this module must not load the email SDK)
          if (next.status === 'resync-required') {
            if (result.resynced) {
              throw new Error(
                `Mail server asked for a second resync in one run (${next.reason})`,
              );
            }
            result.resynced = true;
            cursor = undefined;
            seen = new Set();
            await persistCursor(account, null, ctx.horizon);
            continue;
          }

          const applied = await applyBatch(ctx, next, seen);
          result.batches++;
          result.added += applied.added;
          result.changed += applied.changed;
          result.removed += applied.removed;
          if (seen && next.initial && !next.hasMore) {
            result.removed += await pruneUnseen(ctx, seen, applied.touched);
          }
          await refreshCounts(ctx, applied.touched);

          // Only now is the batch durable: the cursor may move past it.
          await persistCursor(account, next.cursor, ctx.horizon ?? null);
          cursor = next.cursor;
          if (!next.hasMore) break;
          if (result.batches >= maxBatches) result.hasMore = true;
        }

        result.beforeHorizon = ctx.beforeHorizon ?? 0;
        account.lastSyncAt = new Date();
        account.connectionStatus = 'connected';
        account.statusMessage = null;
        account.lastSyncError = null;
        account.backlog = result.hasMore;
        account.updatedAt = new Date();
        await account.save();
        result.duration = Date.now() - startedAt;
        return result;
      } catch (error) {
        return rethrowAfterAuthCheck(account, error, deps.isAuthFailure, {
          recordError: true,
        });
      } finally {
        await client?.disconnect().catch(() => undefined);
      }
    }
  });
}
