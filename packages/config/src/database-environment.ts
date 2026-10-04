/**
 * `DATABASE_URL` / `DATABASE_TYPE` as the fallback for the CLI database
 * (`packages.cli.database`), shared by `smrt` and `smrt-dev-mcp` (#3410,
 * #3446). The precedence is explicit:
 *
 * 1. `packages.cli.database.url` from any config layer (runtime `setConfig`,
 *    `smrt.config` `packages.cli`, or the global `smrt` section) — an explicit
 *    project setting always wins, so a stray shell `DATABASE_URL` can never
 *    retarget a project that names its database.
 * 2. `DATABASE_URL`, with the engine from the config's `database.type`, else
 *    `DATABASE_TYPE` (`sqlite`, `postgres`, `postgresql`), else inferred from
 *    the URL scheme (`postgres://`/`postgresql://` → postgres, anything else
 *    sqlite — the same default the commands apply to a typeless config).
 * 3. Nothing: callers apply their own default (`:memory:` for the CLI).
 *
 * URL and engine travel as a pair: a configured URL never combines with an
 * environment engine. An unrecognised `DATABASE_TYPE` disables the fallback
 * rather than guess; its error names the variable, never the URL.
 */

/** Database engines `packages.cli.database.type` accepts from the environment. */
export type CliDatabaseType = 'sqlite' | 'postgres';

/** Where {@link resolveCliDatabase} found the effective CLI database. */
export type CliDatabaseSource =
  /** A config layer declares `database.url`; the environment was not read. */
  | 'config'
  /** `DATABASE_URL` supplies the database. */
  | 'environment'
  /** `DATABASE_URL` is set but `DATABASE_TYPE` is not a supported engine. */
  | 'invalid-environment'
  /** Neither the config nor the environment names a database. */
  | 'none';

/** Result of {@link resolveCliDatabase}. */
export interface ResolvedCliDatabase {
  readonly source: CliDatabaseSource;
  /**
   * The effective database: the declared block (`type` only when the config
   * declares a string) for `config`, the resolved pair for `environment`,
   * otherwise `null`.
   */
  readonly database: { readonly type?: string; readonly url: string } | null;
  /** For `invalid-environment`: why the fallback was refused (no URL). */
  readonly error?: string;
}

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
 * Apply the precedence above to a declared `packages.cli.database` block.
 *
 * @internal Exported through `resolveCliDatabaseConfig()` in the package
 * entry, which supplies the declared block from the loaded config layers.
 */
export function resolveCliDatabase(
  declared: { url?: unknown; type?: unknown } | undefined,
  env: Readonly<Record<string, string | undefined>>,
): ResolvedCliDatabase {
  if (typeof declared?.url === 'string' && declared.url !== '') {
    return {
      source: 'config',
      database:
        typeof declared.type === 'string'
          ? { type: declared.type, url: declared.url }
          : { url: declared.url },
    };
  }

  const url = env.DATABASE_URL?.trim();
  if (!url) return { source: 'none', database: null };

  let type: CliDatabaseType;
  try {
    type =
      declared?.type === 'sqlite' || declared?.type === 'postgres'
        ? declared.type
        : (environmentType(env.DATABASE_TYPE) ??
          (POSTGRES_URL.test(url) ? 'postgres' : 'sqlite'));
  } catch (error) {
    return {
      source: 'invalid-environment',
      database: null,
      error: (error as Error).message,
    };
  }
  return { source: 'environment', database: { type, url } };
}
