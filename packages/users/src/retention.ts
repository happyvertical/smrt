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
 * The package entry point registers all three on import (see `index.ts`), so
 * any process that loaded `@happyvertical/smrt-users` contributes them.
 * Registration is not scheduling: nothing is deleted until something runs a
 * sweep, and a policy can turn any task off by name. Task names are prefixed
 * with the owning package's short name, because the registry is one
 * process-global namespace shared with every other package.
 *
 * @see https://github.com/happyvertical/smrt/issues/2375
 * @packageDocumentation
 */

import {
  registerRetentionTask,
  unregisterRetentionTask,
} from '@happyvertical/smrt-core';
import { UsersCliAuthRequestCollection } from './collections/CliAuthRequestCollection.js';
import { UsersLoginAttemptCollection } from './collections/LoginAttemptCollection.js';
import { UsersLoginAuditEventCollection } from './collections/LoginAuditEventCollection.js';
import { UsersMagicLinkTokenCollection } from './collections/MagicLinkTokenCollection.js';
import { SessionCollection } from './collections/SessionCollection.js';
import {
  DEFAULT_LOGIN_ATTEMPT_WINDOW_SECONDS,
  DEFAULT_LOGIN_LOCKOUT_MAX_SECONDS,
} from './services/LoginAttemptLimiter.js';

/** Retention task name for expired and revoked sessions. */
export const SESSIONS_RETENTION_TASK = 'users-sessions';

/** Retention task name for expired magic-link tokens. */
export const MAGIC_LINK_RETENTION_TASK = 'users-magic-link-tokens';

/** Retention task name for expired CLI device-code requests. */
export const CLI_AUTH_RETENTION_TASK = 'users-cli-auth-requests';

/** Retention task name for idle login-attempt limiter rows (#3273). */
export const LOGIN_ATTEMPTS_RETENTION_TASK = 'users-login-attempts';

/** Retention task name for login audit events (#3273). */
export const LOGIN_AUDIT_RETENTION_TASK = 'users-login-audit-events';

/** How long login audit events are kept by default. */
export const DEFAULT_LOGIN_AUDIT_RETENTION_DAYS = 90;

/**
 * Limiter rows idle for longer than this are pruned. Twice the largest
 * default horizon, matching the limiter's own streak-forgiveness default, so
 * the sweep never deletes a row the limiter still reasons about.
 */
const LOGIN_ATTEMPT_IDLE_MS =
  Math.max(
    DEFAULT_LOGIN_ATTEMPT_WINDOW_SECONDS,
    DEFAULT_LOGIN_LOCKOUT_MAX_SECONDS,
  ) *
  2 *
  1000;

/** Every task name {@link registerUserRetentionTasks} installs. */
export const USER_RETENTION_TASKS = [
  SESSIONS_RETENTION_TASK,
  MAGIC_LINK_RETENTION_TASK,
  CLI_AUTH_RETENTION_TASK,
  LOGIN_ATTEMPTS_RETENTION_TASK,
  LOGIN_AUDIT_RETENTION_TASK,
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
    description:
      'Delete expired pending, lazily-expired, and consumed CLI auth requests',
    run: async (db, context) => {
      const requests = await UsersCliAuthRequestCollection.create({ db });
      return requests.deleteExpired({ dryRun: context.dryRun });
    },
  });

  registerRetentionTask({
    name: LOGIN_ATTEMPTS_RETENTION_TASK,
    description: 'Delete idle login-attempt limiter rows',
    run: async (db, context) => {
      const attempts = await UsersLoginAttemptCollection.create({ db });
      return attempts.deleteIdle(LOGIN_ATTEMPT_IDLE_MS, {
        dryRun: context.dryRun,
      });
    },
  });

  registerRetentionTask({
    name: LOGIN_AUDIT_RETENTION_TASK,
    description: `Delete login audit events older than ${DEFAULT_LOGIN_AUDIT_RETENTION_DAYS} days`,
    run: async (db, context) => {
      const events = await UsersLoginAuditEventCollection.create({ db });
      return events.deleteOlderThan(
        DEFAULT_LOGIN_AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000,
        { dryRun: context.dryRun },
      );
    },
  });
}

/** Remove the credential retention tasks from the framework sweep. */
export function unregisterUserRetentionTasks(): void {
  for (const name of USER_RETENTION_TASKS) {
    unregisterRetentionTask(name);
  }
}
