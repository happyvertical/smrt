/**
 * Narrowly scoped, TEST-ONLY failure injection for runtime-profile recovery
 * assertions (#2578).
 *
 * Nothing here adds an environment-controlled production backdoor: the only
 * seams used are ordinary caller-supplied arguments — a runtime configuration
 * object and the documented `prepareDatabase` migration callback that
 * `initializeLocalApplicationRuntime()` already accepts from its caller.
 *
 * Public API (also usable by the #2579 aggregate):
 *
 * - {@link SECRET_LIKE_MARKER} — a synthetic credential-shaped string used to
 *   prove failure output stays secret-free.
 * - {@link missingRuntimeProfileConfig} / {@link corruptRuntimeProfileConfig}
 * - {@link failingMigration} — a `prepareDatabase` callback that always fails.
 * - {@link captureRecovery} — run something and normalize its failure into a
 *   stable `{ codes, recoveries, message }` report.
 * - {@link initializeWithFailingMigration} — start the reference application
 *   through its ordinary local-runtime entry point with a migration that fails.
 */

import { initializeLocalApplicationRuntime } from '@happyvertical/smrt-app-runtime';
import type { DatabaseInterface } from '@happyvertical/sql';

import {
  REFERENCE_FIXTURE_NOW,
  copyRuntimeProfileReference,
  generateReferenceFixtureManifest,

} from '../../fixtures/runtime-profile-reference/index.js';

/**
 * Synthetic, non-functional credential-shaped value. It never authenticates
 * anything; it exists so a redaction assertion has something to look for.
 */
export const SECRET_LIKE_MARKER =
  'postgres://fixture-user:fixture-not-a-real-password@fixture.invalid:5432/db';

/** A runtime configuration with no profile selected at all. */
export function missingRuntimeProfileConfig(): Record<string, unknown> {
  return {};
}

/**
 * A runtime configuration whose provider override is invalid AND carries a
 * secret-shaped value, so recovery output can be checked for leakage.
 */
export function corruptRuntimeProfileConfig(
  marker: string = SECRET_LIKE_MARKER,
): Record<string, unknown> {
  return {
    profile: 'local',
    providers: { jobs: { topology: marker } },
  };
}

/** Fixed, secret-free text thrown by {@link failingMigration}. */
export const MIGRATION_FAILURE_MESSAGE =
  'fixture migration failure: reference schema step rejected';

/**
 * A `prepareDatabase` callback that fails the way a broken migration does.
 *
 * The message is deliberately fixed and secret-free: it is the APPLICATION's
 * own error text, so a caller can assert that the framework startup envelope
 * neither redacts away a legitimate diagnosis nor adds runtime paths, database
 * locations, or bootstrap material of its own on the way out.
 */
export function failingMigration(): (db: DatabaseInterface) => Promise<void> {
  return async () => {
    throw new Error(MIGRATION_FAILURE_MESSAGE);
  };
}

/** Normalized, secret-checkable view of a recoverable startup failure. */
export interface RecoveryReport {
  readonly failed: true;
  readonly name: string;
  readonly message: string;
  readonly codes: readonly string[];
  readonly recoveries: readonly string[];
}

/**
 * Run `operation`, requiring it to fail, and normalize the failure.
 *
 * `codes`/`recoveries` come from the framework's own structured failure
 * contracts (`RuntimeProfileValidationError.issues`, `LocalRuntimeError.code`).
 * A failure with neither reports an empty list rather than inventing one — a
 * missing stable code is a finding, not something this helper should paper over.
 */
export async function captureRecovery(
  operation: () => unknown | Promise<unknown>,
): Promise<RecoveryReport> {
  try {
    await operation();
  } catch (error) {
    const failure = error as {
      name?: string;
      message?: string;
      code?: string;
      issues?: readonly { code?: string; recovery?: string }[];
    };
    const issues = Array.isArray(failure.issues) ? failure.issues : [];
    const codes = [
      ...(typeof failure.code === 'string' ? [failure.code] : []),
      ...issues.flatMap((issue) =>
        typeof issue.code === 'string' ? [issue.code] : [],
      ),
    ].sort();
    return {
      failed: true,
      name: failure.name ?? 'Error',
      message: failure.message ?? '',
      codes,
      recoveries: issues
        .flatMap((issue) =>
          typeof issue.recovery === 'string' ? [issue.recovery] : [],
        )
        .sort(),
    };
  }
  throw new Error('Expected the injected failure to be raised.');
}

/**
 * Initialize the reference application exactly the way the fixture does, but
 * with a migration step that always fails.
 *
 * This deliberately reuses the published `initializeLocalApplicationRuntime()`
 * entry point and the fixture's own copy/manifest helpers rather than
 * modifying either: the ONLY difference is the caller-supplied
 * `prepareDatabase` callback.
 */
export async function initializeWithFailingMigration(
  sourceRoot: string,
  dataDirectory: string,
): Promise<never> {
  const fixture = copyRuntimeProfileReference(sourceRoot);
  await generateReferenceFixtureManifest(fixture);
  await initializeLocalApplicationRuntime({
    appId: 'runtime-profile-reference',
    sourceRoot: fixture.root,
    dataDirectory,
    backgroundJobs: true,
    now: () => REFERENCE_FIXTURE_NOW,
    prepareDatabase: failingMigration(),
  });
  throw new Error('Expected the injected migration failure to be raised.');
}
