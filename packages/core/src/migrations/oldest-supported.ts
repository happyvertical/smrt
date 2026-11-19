import oldest from '../../release-upgrade/oldest-supported.json' with {
  type: 'json',
};

export const OLDEST_SUPPORTED_RELEASE = oldest.release;

/**
 * The system-table schema version the oldest supported release stamps in
 * `_smrt_migrations` (`SMRT_SCHEMA_VERSION` at that release), or `null` when
 * the floor record does not carry one.
 *
 * Migrate records start at 0.61.4; every release before that stamps its system
 * schema version only when it prepares system tables (`smrt db:migrate`, the
 * first model use), not when an app migrates through `migrateSmrtSchemas`.
 * So a stamp dates a database's system tables, not its application tables:
 * see {@link checkUnrecordedDatabaseAge}.
 */
export const OLDEST_SUPPORTED_SYSTEM_SCHEMA: string | null =
  (oldest as typeof oldest & { systemSchema?: string }).systemSchema ?? null;

/** Semver ordering, including prerelease identifiers; build metadata is ignored. */
export function compareReleases(a: string, b: string): number {
  const parse = (value: string) => {
    const match =
      /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
        value,
      );
    if (!match) throw new Error(`Invalid smrt release: ${value}`);
    return {
      numbers: match.slice(1, 4).map(Number),
      pre: match[4]?.split('.'),
    };
  };
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < 3; i++) {
    if (left.numbers[i] !== right.numbers[i])
      return left.numbers[i] < right.numbers[i] ? -1 : 1;
  }
  if (!left.pre && !right.pre) return 0;
  if (!left.pre) return 1;
  if (!right.pre) return -1;
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
    const x = left.pre[i];
    const y = right.pre[i];
    if (x === y) continue;
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) return Number(x) < Number(y) ? -1 : 1;
    if (xn !== yn) return xn ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** No record means the first run under the release-record scheme. No writes. */
export function checkOldestSupportedRelease(recordedRelease: string | null):
  | { ok: true }
  | {
      ok: false;
      message: string;
      /** Structured parts of the stop, for writers that word it themselves. */
      recorded: string;
      oldest: string;
      /** Absent when the recorded release could not be read. */
      firstHop?: string;
    } {
  if (recordedRelease === null) return { ok: true };
  try {
    if (compareReleases(recordedRelease, OLDEST_SUPPORTED_RELEASE) >= 0)
      return { ok: true };
  } catch {
    return {
      ok: false,
      recorded: recordedRelease,
      oldest: OLDEST_SUPPORTED_RELEASE,
      message: `This database has an unreadable smrt release record: ${recordedRelease}. This build supports upgrades from ${OLDEST_SUPPORTED_RELEASE} and later. Check the last migrate record before retrying.`,
    };
  }
  // A move command records the first hop in plain words as well as this field.
  const record = oldest as typeof oldest & { upgradeFirstTo?: string };
  const firstHop = record.upgradeFirstTo ?? OLDEST_SUPPORTED_RELEASE;
  return {
    ok: false,
    recorded: recordedRelease,
    oldest: OLDEST_SUPPORTED_RELEASE,
    firstHop,
    message: `This database was last migrated by smrt ${recordedRelease}. This build supports upgrades from ${OLDEST_SUPPORTED_RELEASE} and later. First upgrade the database with smrt ${firstHop}, then run this build's migrate again.`,
  };
}

/**
 * A warning for a database with no migrate record whose system tables are
 * older than the oldest supported release's, or `null`. No writes; never a
 * refusal.
 *
 * `systemSchema` is the highest version stamped in `_smrt_migrations`
 * (`readRecordedSystemSchema`). A stamp below the floor's means the system
 * tables were last prepared by a release older than the floor. It does not
 * prove the application tables are that old: releases 0.60.17 to 0.61.3
 * migrate application tables through `migrateSmrtSchemas` without stamping,
 * so a supported database migrated only that way shows an old stamp. Nor does
 * a stamp at the floor prove the database is new enough: 0.60.16 shares the
 * floor's system schema, and newer model code stamps its own version when it
 * starts, before any migrate. No evidence in the database tells these
 * histories apart, so the run proceeds and the warning asks the operator to
 * confirm.
 */
export function checkUnrecordedDatabaseAge(
  systemSchema: string | null,
): string | null {
  if (systemSchema === null || OLDEST_SUPPORTED_SYSTEM_SCHEMA === null)
    return null;
  try {
    if (compareReleases(systemSchema, OLDEST_SUPPORTED_SYSTEM_SCHEMA) >= 0)
      return null;
  } catch {
    // A stamp that is not a version dates nothing.
    return null;
  }
  const record = oldest as typeof oldest & { upgradeFirstTo?: string };
  const firstHop = record.upgradeFirstTo ?? OLDEST_SUPPORTED_RELEASE;
  return `This database has no migrate record, and its system tables were last prepared by a smrt release older than ${OLDEST_SUPPORTED_RELEASE} (system schema ${systemSchema}; smrt ${OLDEST_SUPPORTED_RELEASE} has ${OLDEST_SUPPORTED_SYSTEM_SCHEMA}). This build supports upgrades from ${OLDEST_SUPPORTED_RELEASE} and later, and cannot tell from the database which release last migrated its application tables. If that was a release older than ${OLDEST_SUPPORTED_RELEASE}, stop and upgrade the database with smrt ${firstHop} first. A database an app on smrt ${OLDEST_SUPPORTED_RELEASE} to 0.61.3 migrated through migrateSmrtSchemas also shows this and is safe to continue.`;
}
