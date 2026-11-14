import oldest from '../../release-upgrade/oldest-supported.json' with {
  type: 'json',
};

export const OLDEST_SUPPORTED_RELEASE = oldest.release;

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
