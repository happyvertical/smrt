// Operator commands of the hosted shell (#5193). They run as a one-shot process
// ON the host (`smrt-app-shell <command>`, `tools/operator-entry.js`), never as
// a route: an operator acts on an owner's app only by naming the owner, and the
// shell then checks that person is the tenant's real owner (an ACTIVE
// membership holding the system `owner` role, `requireOwner`) before anything
// runs as them. No principal is built here from the operator's say-so, and the
// tenant is the verified owner's (`migrateOwnAppToPostgres` takes it from the
// async scope, never from an argument).
import type { MigrateToPostgresResult } from '../../engine/index.ts';
import { EngineError } from '../../engine/index.ts';
import { migrateOwnAppToPostgres, safeId, shellProfile } from './host.ts';
import { PolicyError, requireOwner, runAs } from './owner.ts';

export const MIGRATE_COMMAND = 'migrate-to-postgres';

const USAGE = `usage: smrt-app-shell ${MIGRATE_COMMAND} --tenant <tenant id> --user <owner user id> [--json]

Moves the tenant's SQLite app (app.db) into its PostgreSQL schema. Hosted
profile only, run on the host with the server's own environment. The user must
be the tenant's owner. Refuses (nothing written) while a draft, changes
waiting or an unsettled approval exists. The SQLite file is kept. Rerunning
after a crash is safe.`;

export interface OperatorIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

export interface MigrateArgs {
  tenantId: string;
  userId: string;
  json: boolean;
}

/** Parse the command's flags, or throw a usage error. Values are never read from the environment. */
export function parseMigrateArgs(argv: readonly string[]): MigrateArgs {
  const values: Record<string, string> = {};
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') {
      json = true;
      continue;
    }
    const m = /^--(tenant|user)(?:=(.*))?$/.exec(arg);
    if (!m) throw new UsageError(`unknown argument ${JSON.stringify(arg)}`);
    const value = m[2] ?? argv[++i];
    if (!value || value.startsWith('--'))
      throw new UsageError(`--${m[1]} needs a value`);
    if (m[1] in values) throw new UsageError(`--${m[1]} given twice`);
    values[m[1]] = value;
  }
  if (!values.tenant || !values.user)
    throw new UsageError('--tenant and --user are required');
  return { tenantId: values.tenant, userId: values.user, json };
}

class UsageError extends Error {}

/**
 * Migrate one tenant's SQLite app into PostgreSQL as its verified owner.
 * Hosted profile only. `userId` must hold the tenant's owner role; anything
 * else is refused before any app file or schema is touched.
 */
export async function migrateAppToPostgresAsOperator(input: {
  tenantId: string;
  userId: string;
}): Promise<MigrateToPostgresResult> {
  if ((await shellProfile()) !== 'cloud')
    throw new EngineError(
      'migrating to PostgreSQL is a hosted-profile operation',
      'refused',
    );
  const tenantId = safeId(input.tenantId, 'the tenant');
  const userId = safeId(input.userId, 'the user');
  // The verified owner, looked up in shell.db; a non-owner or a tenant that
  // does not exist is the same refusal (nothing says which).
  let owner: Awaited<ReturnType<typeof requireOwner>>;
  try {
    owner = await requireOwner({ id: userId, tenantId });
  } catch (error) {
    if (error instanceof PolicyError)
      throw new EngineError(
        'that user is not the owner of that tenant',
        'refused',
      );
    throw error;
  }
  return runAs(owner, () => migrateOwnAppToPostgres());
}

/**
 * Run an operator command line (`argv` after the command name's position, i.e.
 * the full list with the command first). Returns the exit code: 0 done, 1
 * refused or failed, 2 usage. Never throws.
 */
export async function runOperatorCommand(
  argv: readonly string[],
  io: OperatorIo,
): Promise<number> {
  const [command, ...rest] = argv;
  if (command !== MIGRATE_COMMAND) {
    io.err(`unknown command ${JSON.stringify(command ?? '')}\n${USAGE}`);
    return 2;
  }
  let args: MigrateArgs;
  try {
    args = parseMigrateArgs(rest);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    io.err(`${error.message}\n${USAGE}`);
    return 2;
  }
  try {
    const result = await migrateAppToPostgresAsOperator(args);
    io.out(
      args.json
        ? JSON.stringify({ ok: true, tenantId: args.tenantId, ...result })
        : `${result.status}: ${result.tables} tables, ${result.rows} rows, digest ${result.digest}`,
    );
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.err(
      args.json
        ? JSON.stringify({ ok: false, tenantId: args.tenantId, error: message })
        : `not done: ${message}`,
    );
    return 1;
  }
}
