/**
 * `DATABASE_URL` / `DATABASE_TYPE` as the CLI's database fallback (#3410).
 *
 * Every `smrt db:*` command reads `packages.cli.database` from smrt-config.
 * `smrt app setup` / `smrt app migrate` hand a child `smrt db:migrate` the
 * profile-owned database through the environment, so an application had to
 * forward those variables in its own config. This module closes that gap
 * once, before any command runs, with an explicit precedence:
 *
 * 1. `packages.cli.database.url` from any config layer (runtime `setConfig`,
 *    `smrt.config` `packages.cli`, or the global `smrt` section) — an explicit
 *    project setting always wins, so a stray shell `DATABASE_URL` can never
 *    retarget a project that names its database.
 * 2. `DATABASE_URL`, with the engine from the config's `database.type`, else
 *    `DATABASE_TYPE` (`sqlite`, `postgres`, `postgresql`), else inferred from
 *    the URL scheme (`postgres://`/`postgresql://` → postgres, anything else
 *    sqlite — the same default the commands apply to a typeless config).
 * 3. The built-in default (`:memory:`), which the schema commands refuse.
 *
 * URL and engine travel as a pair: a configured URL never combines with an
 * environment engine. An unrecognised `DATABASE_TYPE` disables the fallback
 * (with a warning that names the variable, never its URL) rather than guess.
 */

/** Database engines the CLI's `packages.cli.database.type` accepts. */
export type CliDatabaseType = 'sqlite' | 'postgres';

/** Where {@link applyDatabaseEnvironment} found the effective database. */
export type DatabaseConfigSource =
  /** A config layer declares `database.url`; the environment was not read. */
  | 'config'
  /** `DATABASE_URL` was applied as the runtime `packages.cli.database`. */
  | 'environment'
  /** `DATABASE_URL` is set but `DATABASE_TYPE` is not a supported engine. */
  | 'invalid-environment'
  /** Neither the config nor the environment names a database. */
  | 'none';

const POSTGRES_URL = /^postgres(?:ql)?:\/\//i;

function environmentType(value: string | undefined): CliDatabaseType | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === 'sqlite') return 'sqlite';
  if (normalized === 'postgres' || normalized === 'postgresql') {
    return 'postgres';
  }
  throw new TypeError('DATABASE_TYPE must be sqlite or postgres.');
}

/**
 * Apply `DATABASE_URL`/`DATABASE_TYPE` as the CLI database when no config
 * layer declares `packages.cli.database.url`. Call after `loadConfig()`.
 *
 * @param env - Environment to read (defaults to `process.env`).
 * @param warn - Sink for the one-line invalid-type warning.
 * @returns Which source supplies the effective database.
 */
export async function applyDatabaseEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  warn: (message: string) => void = (message) =>
    void process.stderr.write(`${message}\n`),
): Promise<DatabaseConfigSource> {
  const { getPackageConfig, setConfig } = await import(
    '@happyvertical/smrt-config'
  );
  // No defaults: only a value some config layer actually declares counts.
  const declared = getPackageConfig<{
    database?: { url?: unknown; type?: unknown };
  }>('cli').database;
  if (typeof declared?.url === 'string' && declared.url !== '') {
    return 'config';
  }

  const url = env.DATABASE_URL?.trim();
  if (!url) return 'none';

  let type: CliDatabaseType;
  try {
    type =
      declared?.type === 'sqlite' || declared?.type === 'postgres'
        ? declared.type
        : (environmentType(env.DATABASE_TYPE) ??
          (POSTGRES_URL.test(url) ? 'postgres' : 'sqlite'));
  } catch (error) {
    warn(
      `⚠️  Ignoring DATABASE_URL: ${(error as Error).message} Configure packages.cli.database in smrt.config instead.`,
    );
    return 'invalid-environment';
  }

  setConfig({ packages: { cli: { database: { type, url } } } });
  return 'environment';
}
