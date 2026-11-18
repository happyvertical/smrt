/**
 * Triage write-back (Epic I, #5131): mark read or unread, star, archive,
 * spam, label and move, written to the mail server first and to the local row
 * second.
 *
 * `EmailAccount.triage()` (or `Email.triage()`) is the entry point. The rules:
 *
 * - Access first. The acting principal needs both `read` and `triage` on the
 *   message's account (`decideMailAccess`, fail closed). Nothing is sent to
 *   the server or written locally for a refused call.
 * - Server first. The provider's write-back call runs before any row changes.
 *   The result is per message: the local row is updated only for ids the
 *   server accepted, and every refusal is reported in `failed`.
 * - The local row is the server's own word. After the server accepts an id the
 *   message is read back and stored exactly as sync stores it, so the next
 *   sync of the same message is a no-op and cannot flap. If the read-back
 *   fails the id is reported in `stale` and the next sync fixes the row.
 * - Triage runs in the account's sync lane, so in this process it never
 *   interleaves with a sync of the same account.
 * - Idempotent: every write-back operation is absolute (set or clear), so
 *   repeating a call changes nothing.
 * - Providers without the matching `writeBack` capability fail with
 *   {@link MailWriteBackUnsupportedError} before anything is changed.
 *
 * @packageDocumentation
 */

import type {
  EmailClient,
  EmailClientCapabilities,
  EmailMessage,
  WriteBackResult,
} from '@happyvertical/email';
import {
  assertMailAccess,
  MailAccessError,
  runWithMailSystemAccess,
} from './access.js';
import type { EmailCollection } from './collections/EmailCollection.js';
import type { EmailFolderCollection } from './collections/EmailFolderCollection.js';
import {
  applyServerMessage,
  folderIdFor,
  inLane,
  refreshCounts,
  rethrowAfterAuthCheck,
  type SyncContext,
  withMailboxLabels,
} from './mail-sync.js';
import type { Email } from './models/Email.js';
import type { EmailAccount } from './models/EmailAccount.js';

/** What to do to the selected messages. */
export type MailTriageAction =
  | { kind: 'markRead' }
  | { kind: 'markUnread' }
  | { kind: 'star' }
  | { kind: 'unstar' }
  /** Out of the inbox and into the archive; other labels are kept. */
  | { kind: 'archive' }
  /** Into the junk mailbox, flagged as spam. */
  | { kind: 'markSpam' }
  /** Back to the inbox, flagged as not spam. */
  | { kind: 'unmarkSpam' }
  /** Add mailbox/label membership (paths as stored on `EmailFolder`, names, ids). */
  | { kind: 'addLabels'; labels: string[] }
  | { kind: 'removeLabels'; labels: string[] }
  /** Make `folder` the only mailbox a message is in. */
  | { kind: 'move'; folder: string };

export type MailTriageActionKind = MailTriageAction['kind'];

/** The `writeBack` capability each action needs. */
export type MailWriteBackCapability = 'flags' | 'labels' | 'archive' | 'spam';

const ACTION_CAPABILITY: Record<MailTriageActionKind, MailWriteBackCapability> =
  {
    markRead: 'flags',
    markUnread: 'flags',
    star: 'flags',
    unstar: 'flags',
    archive: 'archive',
    markSpam: 'spam',
    unmarkSpam: 'spam',
    addLabels: 'labels',
    removeLabels: 'labels',
    move: 'labels',
  };

const CAPABILITY_METHOD = {
  flags: 'updateFlags',
  labels: 'updateLabels',
  archive: 'archive',
  spam: 'markSpam',
} as const;

/** Thrown, before anything is changed, when the provider cannot do the action. */
export class MailWriteBackUnsupportedError extends Error {
  readonly code = 'WRITE_BACK_UNSUPPORTED';
  constructor(
    readonly action: MailTriageActionKind,
    readonly capability: MailWriteBackCapability,
    readonly providerType: string,
  ) {
    super(
      `Mail provider '${providerType}' cannot write '${action}' back to the server (no '${capability}' write-back).`,
    );
    this.name = 'MailWriteBackUnsupportedError';
  }
}

export interface MailTriageFailure {
  /** The local `Email` row id. */
  id: string;
  /**
   * `notFound` (no such row on this account), `notSynced` (the row has no
   * server id yet), or the server's own code (`notFound`, `forbidden`, ...).
   */
  code: string;
  message?: string;
}

export interface MailTriageResult {
  action: MailTriageActionKind;
  accountId: string;
  /** Local `Email` row ids the server accepted and whose rows now match it. */
  updated: string[];
  /** Ids that were refused, or never reached the server. Nothing changed for these. */
  failed: MailTriageFailure[];
  /**
   * Ids the server accepted but whose row could not be refreshed. The server is
   * right and the row is behind; the next sync corrects it.
   */
  stale: string[];
  /**
   * Set when the server refused the saved sign-in after earlier work already
   * landed: the account is now marked for reconnection and the partial result
   * is still returned rather than thrown away.
   */
  needsReconnect?: boolean;
}

export interface MailTriageDeps {
  createClient: () => Promise<EmailClient>;
  childOptions: Record<string, unknown>;
  isAuthFailure: (error: unknown) => boolean;
}

function parseLabels(email: Email): string[] {
  const labels = email.getLabels();
  return labels.length > 0
    ? labels
    : email.folderPath
      ? [email.folderPath]
      : [];
}

function assertValid(action: MailTriageAction): void {
  if (!(action.kind in ACTION_CAPABILITY)) {
    throw new TypeError(
      `Unknown triage action '${(action as { kind: string }).kind}'`,
    );
  }
  const names =
    action.kind === 'addLabels' || action.kind === 'removeLabels'
      ? action.labels
      : action.kind === 'move'
        ? [action.folder]
        : null;
  if (
    names &&
    (!Array.isArray(names) ||
      names.length === 0 ||
      names.some((n) => typeof n !== 'string' || !n.trim()))
  ) {
    throw new TypeError(
      `Triage action '${action.kind}' needs at least one non-empty label or folder name`,
    );
  }
}

function requireCapability(
  action: MailTriageActionKind,
  client: EmailClient,
  capabilities: EmailClientCapabilities,
  providerType: string,
): void {
  const capability = ACTION_CAPABILITY[action];
  const method = CAPABILITY_METHOD[capability];
  if (
    !capabilities.writeBack?.[capability] ||
    typeof client[method] !== 'function'
  ) {
    throw new MailWriteBackUnsupportedError(action, capability, providerType);
  }
}

/**
 * Resolve a requested mailbox against the account's known folders: exact path,
 * then case-insensitive path, then a unique case-insensitive display name.
 * Unknown names pass through for the server to judge.
 */
async function resolveMailbox(
  folders: EmailFolderCollection,
  accountId: string,
  requested: string,
): Promise<string> {
  const wanted = requested.trim();
  const known = await folders.getByAccount(accountId);
  const lower = wanted.toLowerCase();
  const exact = known.find((f) => f.path === wanted);
  if (exact?.path) return exact.path;
  const byPath = known.filter((f) => f.path?.toLowerCase() === lower);
  if (byPath.length === 1 && byPath[0].path) return byPath[0].path;
  const byName = known.filter((f) => f.name?.toLowerCase() === lower);
  if (byName.length === 1 && byName[0].path) return byName[0].path;
  return wanted;
}

/** One server call: the provider ids it covers, and how to make it. */
interface Call {
  ids: string[];
  run: () => Promise<WriteBackResult>;
}

function plan(
  action: MailTriageAction,
  client: EmailClient,
  rows: Map<string, Email>,
  destination: string | null,
): Call[] {
  const ids = [...rows.keys()];
  switch (action.kind) {
    case 'markRead':
      return [
        { ids, run: () => client.updateFlags!(ids, { add: ['\\Seen'] }) },
      ];
    case 'markUnread':
      return [
        { ids, run: () => client.updateFlags!(ids, { remove: ['\\Seen'] }) },
      ];
    case 'star':
      return [
        { ids, run: () => client.updateFlags!(ids, { add: ['\\Flagged'] }) },
      ];
    case 'unstar':
      return [
        { ids, run: () => client.updateFlags!(ids, { remove: ['\\Flagged'] }) },
      ];
    case 'archive':
      return [{ ids, run: () => client.archive!(ids) }];
    case 'markSpam':
      return [{ ids, run: () => client.markSpam!(ids, true) }];
    case 'unmarkSpam':
      return [{ ids, run: () => client.markSpam!(ids, false) }];
    case 'addLabels': {
      const add = [...new Set(action.labels)];
      return [{ ids, run: () => client.updateLabels!(ids, { add }) }];
    }
    case 'removeLabels': {
      const remove = [...new Set(action.labels)];
      return [{ ids, run: () => client.updateLabels!(ids, { remove }) }];
    }
    case 'move': {
      // Each message leaves the mailboxes it is in now; messages with the same
      // current mailboxes share one call.
      const target = destination ?? action.folder;
      const groups = new Map<string, { remove: string[]; ids: string[] }>();
      const inPlace: string[] = [];
      for (const [id, row] of rows) {
        const labels = parseLabels(row);
        const remove = labels.filter((label) => label !== target).sort();
        if (remove.length === 0 && labels.includes(target)) {
          inPlace.push(id); // already exactly there: nothing to tell the server
          continue;
        }
        const key = JSON.stringify(remove);
        const group = groups.get(key) ?? { remove, ids: [] };
        group.ids.push(id);
        groups.set(key, group);
      }
      const calls: Call[] = [...groups.values()].map((group) => ({
        ids: group.ids,
        run: () =>
          client.updateLabels!(group.ids, {
            add: [target],
            ...(group.remove.length > 0 ? { remove: group.remove } : {}),
          }),
      }));
      if (inPlace.length > 0) {
        calls.unshift({
          ids: inPlace,
          run: async () => ({ updated: inPlace, failed: [] }),
        });
      }
      return calls;
    }
  }
}

/**
 * Write a triage action for `emailIds` (local `Email` row ids of `account`) to
 * the server, then update the accepted rows. See the module comment; call
 * `EmailAccount.triage()` rather than this directly.
 */
export async function triageMailMessages(
  suppliedAccount: EmailAccount,
  action: MailTriageAction,
  emailIds: readonly string[],
  deps: MailTriageDeps,
): Promise<MailTriageResult> {
  if (!suppliedAccount.id) {
    throw new Error('EmailAccount.triage requires a persisted account');
  }
  const accountId = suppliedAccount.id;
  let account = suppliedAccount;
  assertValid(action);
  // Fail closed before touching anything. Triage acts on what the principal
  // can see, so it takes the read scope as well as the triage scope.
  await assertMailAccess(account, 'read');
  await assertMailAccess(account, 'triage');

  const result: MailTriageResult = {
    action: action.kind,
    accountId,
    updated: [],
    failed: [],
    stale: [],
  };
  const requested = [...new Set(emailIds)];
  if (requested.length === 0) return result;

  return inLane(accountId, async () => {
    // The caller's instance may be stale: the account can have been claimed,
    // transferred or had a grant revoked while this call waited for the lane.
    // Re-authorize against the stored row before any server call or write.
    const { EmailAccountCollection: AccountCollectionClass } = await import(
      './collections/EmailAccountCollection.js'
    );
    const stored = (await runWithMailSystemAccess(async () =>
      (
        await AccountCollectionClass.create(deps.childOptions)
      ).get({
        id: accountId,
      }),
    )) as EmailAccount | null;
    if (!stored?.id) throw new MailAccessError('read', 'denied');
    await assertMailAccess(stored, 'read');
    await assertMailAccess(stored, 'triage');
    account = stored;
    if (!account.isActive || !suppliedAccount.isActive) {
      throw new Error('Mail account is inactive');
    }
    if (account.needsReconnect || suppliedAccount.needsReconnect) {
      throw new Error('Mail account needs to be reconnected');
    }
    return runWithMailSystemAccess(async () => {
      const { EmailCollection: EmailCollectionClass } = await import(
        './collections/EmailCollection.js'
      );
      const { EmailFolderCollection: FolderCollectionClass } = await import(
        './collections/EmailFolderCollection.js'
      );
      const emails: EmailCollection = await EmailCollectionClass.create(
        deps.childOptions,
      );
      const folders: EmailFolderCollection = await FolderCollectionClass.create(
        deps.childOptions,
      );

      // Which rows can go to the server at all.
      const rows = new Map<string, Email>(); // provider id -> row
      const byLocalId = new Map<string, Email>();
      for (const id of requested) {
        const row = (await emails.get({ id })) as Email | null;
        if (!row || row.accountId !== accountId) {
          result.failed.push({ id, code: 'notFound' });
        } else if (!row.providerMessageId) {
          result.failed.push({
            id,
            code: 'notSynced',
            message: 'The message has not been synced from the server yet',
          });
        } else if (rows.has(row.providerMessageId)) {
          result.failed.push({
            id,
            code: 'duplicate',
            message: 'Another selected row has the same server id',
          });
        } else {
          rows.set(row.providerMessageId, row);
          byLocalId.set(id, row);
        }
      }

      const client = await deps.createClient();
      try {
        await client.connect();
        requireCapability(
          action.kind,
          client,
          await client.getCapabilities(),
          account.providerType,
        );
        if (rows.size === 0) return result;

        const destination =
          action.kind === 'move'
            ? await resolveMailbox(folders, accountId, action.folder)
            : null;

        const ctx: SyncContext = {
          account,
          accountId,
          emails,
          folders,
          childOptions: deps.childOptions,
          folderIds: new Map(),
        };
        const touched = new Set<string>();
        const accepted = new Set<string>();

        const calls = plan(action, client, rows, destination);
        let firstError: unknown;
        let authError: unknown;
        let completed = 0;
        for (const call of calls) {
          let outcome: WriteBackResult;
          if (authError) {
            outcome = { updated: [], failed: [] };
            for (const id of call.ids)
              outcome.failed.push({
                id,
                code: 'skipped',
                message: 'Not attempted: the server refused the sign-in',
              });
          } else {
            try {
              outcome = await call.run();
              completed++;
            } catch (error) {
              // Earlier calls were already applied on the server: report this
              // call's ids as failed and carry on, never lose the rest.
              firstError ??= error;
              if (deps.isAuthFailure(error)) authError = error;
              outcome = { updated: [], failed: [] };
              for (const id of call.ids)
                outcome.failed.push({
                  id,
                  code: 'serverError',
                  message: 'The server call failed before reporting an outcome',
                });
            }
          }
          const wanted = new Set(call.ids);
          const settled = new Set<string>();
          for (const providerId of outcome.updated) {
            if (!wanted.has(providerId) || settled.has(providerId)) continue;
            settled.add(providerId);
            accepted.add(providerId);
          }
          for (const failure of outcome.failed) {
            const row = rows.get(failure.id);
            if (!row?.id || settled.has(failure.id) || !wanted.has(failure.id))
              continue;
            settled.add(failure.id);
            result.failed.push({
              id: row.id,
              code: failure.code,
              ...(failure.message ? { message: failure.message } : {}),
            });
          }
          for (const providerId of call.ids) {
            if (settled.has(providerId)) continue;
            const row = rows.get(providerId);
            if (!row?.id) continue;
            result.failed.push({
              id: row.id,
              code: 'unknown',
              message: 'Server did not report an outcome for this message',
            });
          }
        }

        // The server accepted these: store each as the server now has it.
        let readBackAuthError: unknown;
        for (const providerId of accepted) {
          const row = rows.get(providerId);
          if (!row?.id) continue;
          if (readBackAuthError) {
            // The sign-in was refused: the server applied it, the row lags.
            result.stale.push(row.id);
            continue;
          }
          try {
            if (row.folderId) touched.add(row.folderId);
            const fresh: EmailMessage = await client.getMessage(providerId);
            const folderPath = fresh.folder ?? fresh.folders?.[0] ?? '';
            const folderId = folderPath
              ? await folderIdFor(ctx, folderPath)
              : '';
            applyServerMessage(
              row,
              withMailboxLabels(fresh),
              { folderId, folderPath },
              { keepBodies: true, deriveState: true },
            );
            await row.save();
            if (folderId) touched.add(folderId);
            result.updated.push(row.id);
          } catch (error) {
            result.stale.push(row.id);
            if (deps.isAuthFailure(error)) readBackAuthError = error;
          }
        }
        if (touched.size > 0) await refreshCounts(ctx, touched).catch(() => {});
        // Nothing reached the server: surface the cause as an error.
        if (firstError && completed === 0) throw firstError;
        const lateAuthError = authError ?? readBackAuthError;
        if (lateAuthError) {
          // Earlier work landed on the server: keep the result and flag the
          // reconnect rather than throwing the outcome away.
          const err =
            lateAuthError instanceof Error
              ? lateAuthError
              : new Error(String(lateAuthError));
          await account.markNeedsReconnect(err.message).catch(() => undefined);
          result.needsReconnect = true;
        }
        return result;
      } catch (error) {
        return rethrowAfterAuthCheck(account, error, deps.isAuthFailure);
      } finally {
        await client.disconnect().catch(() => undefined);
      }
    });
  });
}
