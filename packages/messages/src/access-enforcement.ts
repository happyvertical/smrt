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
  assertHydratedMailAccess,
  deniedMailAccountIds,
  getEffectiveMailAccessConfigs,
  inMailSystemAccess,
  learnMailAccessOptions,
  MailAccessError,
  runWithMailSystemAccess,
} from './access.js';
import { Account } from './models/Account.js';
import { Attachment } from './models/Attachment.js';
import { EmailFolder } from './models/EmailFolder.js';
import { Message } from './models/Message.js';

type Kind = 'message' | 'folder' | 'attachment' | 'account';

const NAME_FALLBACK: Record<string, Kind> = {
  Message: 'message',
  Email: 'message',
  EmailFolder: 'folder',
  Attachment: 'attachment',
  Account: 'account',
  EmailAccount: 'account',
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
    if (descends(ctor, Account)) return 'account';
    return null;
  }
  return NAME_FALLBACK[className] ?? null;
}

/** SQL parameter budget for one exclusion list; beyond it, fail closed. */
const MAX_EXCLUDED_IDS = 900;

function restrict(
  where: ListOptions['where'],
  denied: string[],
  unaccounted: Record<string, unknown>[],
): ListOptions['where'] {
  const groups: Record<string, unknown>[][] = Array.isArray(where)
    ? where
    : [[where ?? {}]];
  // NOT IN drops NULL accountIds, so rows with no account are added back
  // explicitly, and only the shapes that are provably not a mailbox's.
  return groups.flatMap((group) => [
    [...group, { 'accountId not in': denied }],
    ...unaccounted.map((extra) => [...group, extra]),
  ]);
}

type Row = {
  accountId?: string | null;
  messageId?: string | null;
  options?: unknown;
};

async function allowedInstance(
  kind: Kind,
  instance: SmrtObject,
): Promise<boolean> {
  const row = instance as unknown as Row;
  try {
    await assertHydratedMailAccess(
      kind === 'attachment'
        ? row
        : { accountId: row.accountId, options: row.options },
    );
    return true;
  } catch (error) {
    if (error instanceof MailAccessError) return false;
    throw error;
  }
}

export const MAIL_ACCESS_INTERCEPTOR_NAME = 'smrt-messages-account-access';

export function createMailAccessInterceptor(): CollectionInterceptor {
  return {
    name: MAIL_ACCESS_INTERCEPTOR_NAME,
    // After tenancy (100) so tenant scoping has already narrowed the read.
    priority: 50,

    onCollectionReady(className, collection, context) {
      // Every read path starts here, whichever collection class serves the
      // item (a default collection for an app subclass or Tweet included), so
      // the database is registered before any filtering decision.
      if (!kindOf(className, context)) return;
      learnMailAccessOptions({
        ...(collection.options as object),
        db: collection.db,
      } as never);
    },

    async beforeList(className, options, context) {
      if (!getEffectiveMailAccessConfigs().length || inMailSystemAccess()) {
        return options;
      }
      const kind = kindOf(className, context);
      if (!kind || kind === 'account') return options;
      const denied = await deniedMailAccountIds('read');
      if (!denied.length) return options;
      if (denied.length > MAX_EXCLUDED_IDS) {
        throw new MailAccessError('read', 'denied');
      }
      const unaccounted =
        kind === 'attachment'
          ? [
              { accountId: null, messageId: null },
              { accountId: null, messageId: '' },
            ]
          : [{ accountId: null }];
      return {
        ...options,
        where: restrict(options.where, denied, unaccounted),
      };
    },

    async beforeSave(instance, context) {
      const kind = kindOf(instance.constructor.name, context);
      if (kind === 'account') {
        learnMailAccessOptions((instance as unknown as Row).options as never);
        return;
      }
      if (kind !== 'attachment') return;
      const row = instance as unknown as Row;
      // Always derive the account from the message: a caller-supplied
      // accountId (for instance through a generated create) is never trusted.
      row.accountId = null;
      if (!row.messageId || !row.options) return;
      const { MessageCollection } = await import(
        './collections/MessageCollection.js'
      );
      const message = await runWithMailSystemAccess(async () =>
        (await MessageCollection.create(row.options as never)).get({
          id: row.messageId as string,
        }),
      );
      row.accountId = message?.accountId || null;
    },

    async afterList(className, results, context) {
      if (inMailSystemAccess()) return results;
      const kind = kindOf(className, context);
      if (!kind) return results;
      if (kind === 'account') {
        for (const item of results) {
          learnMailAccessOptions((item as unknown as Row).options as never);
        }
        return results;
      }
      // Filters hydrated rows (the only filter for legacy attachments) and
      // defends rows that reached here by another path.
      const kept: typeof results = [];
      const cache = new Map<string, boolean>();
      for (const item of results) {
        const row = item as unknown as Row;
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
      if (!instance || inMailSystemAccess()) return instance;
      const kind = kindOf(className, context);
      if (!kind) return instance;
      if (kind === 'account') {
        learnMailAccessOptions((instance as unknown as Row).options as never);
        return instance;
      }
      return (await allowedInstance(kind, instance)) ? instance : null;
    },

    async beforeQuery(
      className,
      options: QueryOptions,
      context,
    ): Promise<QueryInterceptResult> {
      const unchanged = { sql: options.sql, params: options.params };
      if (!getEffectiveMailAccessConfigs().length || inMailSystemAccess()) {
        return unchanged;
      }
      const kind = kindOf(className, context);
      if (!kind || kind === 'account') return unchanged;
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
