/**
 * Credential retention — expired sessions and tokens (issue #2375, finding F2).
 *
 * `SessionCollection.deleteExpired()`, `MagicLinkTokenCollection.deleteExpired()`
 * and `CliAuthRequestCollection.deleteExpired()` all existed, and every one of
 * them waited for an application to remember to call it. Expired credential
 * rows are the worst kind of unbounded growth: they are worthless the moment
 * they expire and they are exactly the rows an attacker would like to still
 * find in the table.
 *
 * This module contributes them to the framework retention sweep, so
 * `smrt db:prune` and the jobs `TaskRunner`'s periodic sweep reap them like
 * every other framework-owned table.
 *
 * Registration is explicit — importing this module schedules nothing.
 *
 * @see https://github.com/happyvertical/smrt/issues/2375
 * @packageDocumentation
 */

import {
  registerRetentionTask,
  unregisterRetentionTask,
} from '@happyvertical/smrt-core';
import { UsersCliAuthRequestCollection } from './collections/CliAuthRequestCollection.js';
import { UsersMagicLinkTokenCollection } from './collections/MagicLinkTokenCollection.js';
import { SessionCollection } from './collections/SessionCollection.js';

/** Retention task name for expired and revoked sessions. */
export const SESSIONS_RETENTION_TASK = 'users-sessions';

/** Retention task name for expired magic-link tokens. */
export const MAGIC_LINK_RETENTION_TASK = 'users-magic-link-tokens';

/** Retention task name for expired CLI device-code requests. */
export const CLI_AUTH_RETENTION_TASK = 'users-cli-auth-requests';

/** Every task name {@link registerUserRetentionTasks} installs. */
export const USER_RETENTION_TASKS = [
  SESSIONS_RETENTION_TASK,
  MAGIC_LINK_RETENTION_TASK,
  CLI_AUTH_RETENTION_TASK,
] as const;

/**
 * Register session and token expiry with the framework retention sweep.
 *
 * Idempotent: re-registering replaces the previous tasks.
 *
 * Each task deletes only rows that have already expired — there is no
 * retention window to configure, because an expired credential has no value
 * to retain. Applications that keep expired sessions for audit should opt the
 * task out (`tasks: { 'users-sessions': false }`) and archive them
 * themselves.
 */
export function registerUserRetentionTasks(): void {
  registerRetentionTask({
    name: SESSIONS_RETENTION_TASK,
    description: 'Delete expired and revoked sessions',
    run: async (db, context) => {
      const sessions = await SessionCollection.create({ db });
      return sessions.deleteExpired({ dryRun: context.dryRun });
    },
  });

  registerRetentionTask({
    name: MAGIC_LINK_RETENTION_TASK,
    description: 'Delete expired magic-link tokens',
    run: async (db, context) => {
      const tokens = await UsersMagicLinkTokenCollection.create({ db });
      return tokens.deleteExpired({ dryRun: context.dryRun });
    },
  });

  registerRetentionTask({
    name: CLI_AUTH_RETENTION_TASK,
    description: 'Delete expired pending CLI auth requests',
    run: async (db, context) => {
      const requests = await UsersCliAuthRequestCollection.create({ db });
      return requests.deleteExpired({ dryRun: context.dryRun });
    },
  });
}

/** Remove the credential retention tasks from the framework sweep. */
export function unregisterUserRetentionTasks(): void {
  for (const name of USER_RETENTION_TASKS) {
    unregisterRetentionTask(name);
  }
}
