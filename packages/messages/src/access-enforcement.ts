/**
 * Collection-layer enforcement of per-account mail access (see `access.ts`).
 *
 * Registered once at package load as a `GlobalInterceptors` entry, so every
 * list/get/count/raw read of an owned account's emails, folders and
 * attachments is filtered in the collection, not in a component. Matching is
 * by STI ancestry, so an app subclass of `Email` is governed too.
 *
 * Account rows themselves are not filtered here: senders, routes and the
 * outbox read them without a principal, and the content (emails, folders,
 * attachments) is what an account grant protects.
 *
 * @packageDocumentation
 */

import {
  type CollectionInterceptor,
  GlobalInterceptors,
  type InterceptorContext,
  type ListOptions,
  ObjectRegistry,
  type QueryInterceptResult,
  type QueryOptions,
  type SmrtObject,
} from '@happyvertical/smrt-core';
import {
  decideMailAccess,
  deniedMailAccountIds,
  getMailAccessConfig,
  inMailSystemAccess,
  MailAccessError,
  runWithMailSystemAccess,
} from './access.js';
import { Attachment } from './models/Attachment.js';
import { EmailFolder } from './models/EmailFolder.js';
import { Message } from './models/Message.js';

type Kind = 'message' | 'folder' | 'attachment';

const NAME_FALLBACK: Record<string, Kind> = {
  Message: 'message',
  Email: 'message',
  EmailFolder: 'folder',
  Attachment: 'attachment',
  EmailAttachment: 'attachment',
};

function descends(ctor: unknown, base: unknown): boolean {
  if (typeof ctor !== 'function') return false;
  return (
    ctor === base ||
    (ctor as { prototype: object }).prototype instanceof
      (base as new () => object)
  );
}

function kindOf(className: string, context: InterceptorContext): Kind | null {
  const registered =
    ObjectRegistry.getClass(context.qualifiedClassName ?? className) ??
    ObjectRegistry.getClass(className);
  const ctor = registered?.constructor;
  if (ctor) {
    if (descends(ctor, Message)) return 'message';
    if (descends(ctor, EmailFolder)) return 'folder';
    if (descends(ctor, Attachment)) return 'attachment';
    return null;
  }
  return NAME_FALLBACK[className] ?? null;
}

/** SQL parameter budget for one exclusion list; beyond it, fail closed. */
const MAX_EXCLUDED_IDS = 900;

function restrict(
  where: ListOptions['where'],
  denied: string[],
  column = 'accountId',
): ListOptions['where'] {
  const groups: Record<string, unknown>[][] = Array.isArray(where)
    ? where
    : [[where ?? {}]];
  // NOT IN drops NULL accountIds, which are not an owned account's rows.
  return groups.flatMap((group) => [
    [...group, { [`${column} not in`]: denied }],
    [...group, { [column]: null }],
  ]);
}

/** The owning message's account id: '' for none, null when the message is missing. */
async function accountIdOfMessage(messageId: string): Promise<string | null> {
  const config = getMailAccessConfig();
  if (!config) return '';
  const { MessageCollection } = await import(
    './collections/MessageCollection.js'
  );
  // System scope: the message read must not be filtered by the very policy
  // being evaluated, or a hidden message would look like a missing one.
  const message = await runWithMailSystemAccess(async () =>
    (await MessageCollection.create(config.options)).get({ id: messageId }),
  );
  return message ? message.accountId || '' : null;
}

async function accountAllowed(accountId: string | null): Promise<boolean> {
  if (!accountId) return true;
  const config = getMailAccessConfig();
  if (!config) return true;
  const { AccountCollection } = await import(
    './collections/AccountCollection.js'
  );
  const account = await runWithMailSystemAccess(async () =>
    (await AccountCollection.create(config.options)).get({ id: accountId }),
  );
  // An account that cannot be found (deleted by another path, or outside this
  // tenant) must not turn its mail into tenant-wide mail: fail closed.
  if (!account) return false;
  return (
    await decideMailAccess(
      {
        id: account.id,
        tenantId: account.tenantId,
        ownerUserId: account.ownerUserId,
      },
      'read',
    )
  ).allowed;
}

async function allowedInstance(
  kind: Kind,
  instance: SmrtObject,
): Promise<boolean> {
  const row = instance as unknown as {
    accountId?: string | null;
    messageId?: string | null;
    id?: string;
  };
  if (kind === 'attachment') {
    if (row.accountId) return accountAllowed(row.accountId);
    if (!row.messageId) return true;
    const accountId = await accountIdOfMessage(row.messageId);
    // A parent message that cannot be found is not provably the caller's.
    return accountId === null ? false : accountAllowed(accountId);
  }
  return accountAllowed(row.accountId || null);
}

export const MAIL_ACCESS_INTERCEPTOR_NAME = 'smrt-messages-account-access';

export function createMailAccessInterceptor(): CollectionInterceptor {
  return {
    name: MAIL_ACCESS_INTERCEPTOR_NAME,
    // After tenancy (100) so tenant scoping has already narrowed the read.
    priority: 50,

    async beforeList(className, options, context) {
      if (!getMailAccessConfig() || inMailSystemAccess()) return options;
      const kind = kindOf(className, context);
      if (!kind) return options;
      const denied = await deniedMailAccountIds('read');
      if (!denied.length) return options;
      if (denied.length > MAX_EXCLUDED_IDS) {
        throw new MailAccessError('read', 'denied');
      }
      return { ...options, where: restrict(options.where, denied) };
    },

    async beforeSave(instance, context) {
      if (!getMailAccessConfig()) return;
      const kind = kindOf(instance.constructor.name, context);
      if (kind !== 'attachment') return;
      const row = instance as unknown as {
        accountId?: string | null;
        messageId?: string | null;
      };
      if (row.accountId || !row.messageId) return;
      // Denormalize the owning account so reads can be filtered in SQL.
      const accountId = await accountIdOfMessage(row.messageId);
      if (accountId) row.accountId = accountId;
    },

    async afterList(className, results, context) {
      if (!getMailAccessConfig() || inMailSystemAccess()) return results;
      const kind = kindOf(className, context);
      if (!kind) return results;
      // Defense in depth for rows that reached here by another path, and the
      // only filter for attachments.
      const kept: typeof results = [];
      const cache = new Map<string, boolean>();
      for (const item of results) {
        const row = item as unknown as {
          accountId?: string | null;
          messageId?: string | null;
        };
        const key = `${kind}:${row.accountId ?? ''}:${row.messageId ?? ''}`;
        let ok = cache.get(key);
        if (ok === undefined) {
          ok = await allowedInstance(kind, item);
          cache.set(key, ok);
        }
        if (ok) kept.push(item);
      }
      return kept;
    },

    async afterGet(className, instance, context) {
      if (!instance || !getMailAccessConfig() || inMailSystemAccess()) {
        return instance;
      }
      const kind = kindOf(className, context);
      if (!kind) return instance;
      return (await allowedInstance(kind, instance)) ? instance : null;
    },

    async beforeQuery(
      className,
      options: QueryOptions,
      context,
    ): Promise<QueryInterceptResult> {
      const unchanged = { sql: options.sql, params: options.params };
      if (!getMailAccessConfig() || inMailSystemAccess()) return unchanged;
      if (!kindOf(className, context)) return unchanged;
      // Raw SQL cannot be narrowed to granted accounts. When any account is
      // closed to the principal, refuse rather than leak its rows.
      if ((await deniedMailAccountIds('read')).length) {
        throw new MailAccessError('read', 'denied');
      }
      return unchanged;
    },
  };
}

let registered = false;

/** Idempotent; called at package load. */
export function ensureMailAccessEnforcementRegistered(): void {
  if (registered) return;
  registered = true;
  GlobalInterceptors.register(createMailAccessInterceptor());
}
