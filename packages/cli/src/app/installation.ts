/**
 * `smrt app installation` — restore/move versus copy of a local installation
 * (#4704).
 *
 * ```
 * smrt app installation [status]
 * smrt app installation restore --origin-retired
 * smrt app installation reseed --confirm-destroy-seed
 * smrt app installation recover-seed <seed-file> [--unverified]
 * smrt app installation retire
 * ```
 *
 * Local profile only. `status` is read-only. Every other subcommand takes the
 * operation lock and refuses while a writer is active, so stop the
 * application first. Output is secret-free JSON: the seed is never printed.
 */

import { resolve } from 'node:path';
import {
  inspectInstallationCustody,
  RESEED_CONFIRMATION_MESSAGE,
  recoverInstallationSeed,
  reseedInstallation,
  restoreInstallation,
  retireInstallation,
  withOperationLock,
} from '@happyvertical/smrt-app-runtime';
import { assertLocalOperation } from './operations.js';
import { type AppContext, preparedStateRoot } from './runtime.js';

/** Usage text for `smrt app installation`. */
export const INSTALLATION_USAGE =
  'Usage: smrt app installation [status] | restore --origin-retired | reseed --confirm-destroy-seed | recover-seed <seed-file> [--unverified] | retire';

const SUBCOMMANDS = [
  'status',
  'restore',
  'reseed',
  'recover-seed',
  'retire',
] as const;

const NOTICES: Record<string, string> = {
  restore:
    'Same installation: seed, identities and tokens are unchanged. Keep the origin stopped or deleted; two active origins need "reseed --confirm-destroy-seed" on one of them.',
  reseed:
    'Independent installation: device, tenant, owner, profile and membership derivations changed and seed-keyed tokens no longer work. Existing rows keep their IDs; sessions are untouched. The previous seed was not kept.',
  'recover-seed':
    'Seed restored: identities and tokens are exactly as before. Run "smrt app installation status" to confirm custody.',
  retire:
    'This location can no longer start the application. Use "restore --origin-retired" here to bring it back.',
};

function printJson(context: AppContext, value: unknown): void {
  context.io.stdout(`${JSON.stringify(value, null, 2)}\n`);
}

/** Run `smrt app installation <args…>` and resolve to the exit code. */
export async function runInstallationOperation(
  context: AppContext,
  args: string[],
): Promise<number> {
  const [first, ...rest] = args;
  if (first === 'help' || first === '--help' || first === '-h') {
    context.io.stdout(`${INSTALLATION_USAGE}\n`);
    return 0;
  }
  const subcommand = first ?? 'status';
  if (!(SUBCOMMANDS as readonly string[]).includes(subcommand)) {
    throw new Error(
      `Unknown installation operation: ${subcommand}. ${INSTALLATION_USAGE}`,
    );
  }
  let originRetired = false;
  let unverified = false;
  let confirmDestroySeed = false;
  const positional: string[] = [];
  for (const arg of rest) {
    if (arg === '--origin-retired' && subcommand === 'restore') {
      originRetired = true;
    } else if (arg === '--confirm-destroy-seed' && subcommand === 'reseed') {
      confirmDestroySeed = true;
    } else if (arg === '--unverified' && subcommand === 'recover-seed') {
      unverified = true;
    } else if (arg.startsWith('--')) {
      throw new Error(
        `Unknown installation option: ${arg}. ${INSTALLATION_USAGE}`,
      );
    } else {
      positional.push(arg);
    }
  }
  if (
    subcommand === 'recover-seed'
      ? positional.length !== 1
      : positional.length > 0
  ) {
    throw new Error(
      `installation ${subcommand} takes ${subcommand === 'recover-seed' ? 'exactly one seed file' : 'no arguments'}. ${INSTALLATION_USAGE}`,
    );
  }
  // Irreversible, so refuse before the operation lock or any state is touched.
  if (subcommand === 'reseed' && !confirmDestroySeed) {
    throw new Error(RESEED_CONFIRMATION_MESSAGE);
  }
  await assertLocalOperation(context, 'app:installation');
  const options = {
    appId: context.appId,
    dataDirectory: process.env.SMRT_DATA_DIR,
    sourceRoot: context.sourceRoot,
  };

  if (subcommand === 'status') {
    const report = await inspectInstallationCustody(options);
    printJson(context, report);
    // Scripts gate on the exit code: only a healthy state is zero.
    return report.status === 'in-custody' || report.status === 'unrecorded'
      ? 0
      : 1;
  }
  return withOperationLock(
    preparedStateRoot(context),
    `installation-${subcommand}`,
    async (lock) => {
      const declared = { ...options, operationInstance: lock.instance };
      const outcome =
        subcommand === 'restore'
          ? await restoreInstallation({ ...declared, originRetired })
          : subcommand === 'reseed'
            ? await reseedInstallation({ ...declared, confirmDestroySeed })
            : subcommand === 'retire'
              ? await retireInstallation(declared)
              : await recoverInstallationSeed({
                  ...declared,
                  seedFile: resolve(positional[0]),
                  allowUnverified: unverified,
                });
      printJson(context, { ...outcome, notice: NOTICES[subcommand] });
      return 0;
    },
  );
}
