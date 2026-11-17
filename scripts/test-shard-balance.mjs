/**
 * Duration-aware shard assignment for the CI test selectors (#5045).
 *
 * Assigning packages to shards by name put the five slowest SQLite suites in
 * one shard: 39.7 minutes of tests against 10.6 in its neighbour (merge-group
 * run 43955782588). The selectors now give each package to the shard with the
 * least measured time so far, longest package first.
 *
 * The tables hold measured seconds for packages that take 30 s or more;
 * everything else counts as DEFAULT_SECONDS. They only steer balance: a stale
 * or missing entry makes shards uneven, never drops a package. Refresh them
 * from the `Duration` line each package's Vitest run prints in a merge-group
 * `test-packages` or PostgreSQL job log.
 */

/** `test` task seconds at two Vitest workers, merge-group run 43955782588. */
export const TEST_SECONDS = {
  '@happyvertical/smrt-agents': 76,
  '@happyvertical/smrt-analytics': 41,
  '@happyvertical/smrt-app-runtime': 440,
  '@happyvertical/smrt-assets': 38,
  '@happyvertical/smrt-chat': 306,
  '@happyvertical/smrt-cli': 257,
  '@happyvertical/smrt-commerce': 308,
  '@happyvertical/smrt-content': 121,
  '@happyvertical/smrt-desktop': 32,
  '@happyvertical/smrt-dev-mcp': 39,
  '@happyvertical/smrt-expenses': 52,
  '@happyvertical/smrt-fields': 43,
  '@happyvertical/smrt-images': 32,
  '@happyvertical/smrt-inference': 33,
  '@happyvertical/smrt-ingestion': 824,
  '@happyvertical/smrt-jobs': 62,
  '@happyvertical/smrt-messages': 60,
  '@happyvertical/smrt-profiles': 34,
  '@happyvertical/smrt-projects': 45,
  '@happyvertical/smrt-reports': 35,
  '@happyvertical/smrt-sales': 85,
  '@happyvertical/smrt-subscriptions': 37,
  '@happyvertical/smrt-support': 45,
  '@happyvertical/smrt-svelte': 254,
  '@happyvertical/smrt-timesheets': 49,
  '@happyvertical/smrt-ui': 126,
  '@happyvertical/smrt-users': 268,
  '@happyvertical/smrt-vitest': 35,
};

/** `test:postgres` task seconds, PostgreSQL merge-group run of 2026-11-16. */
export const POSTGRES_TEST_SECONDS = {
  '@happyvertical/smrt-analytics': 40,
  '@happyvertical/smrt-app-runtime': 41,
  '@happyvertical/smrt-cli': 33,
  '@happyvertical/smrt-commerce': 285,
  '@happyvertical/smrt-core': 808,
  '@happyvertical/smrt-education': 325,
  '@happyvertical/smrt-expenses': 56,
  '@happyvertical/smrt-jobs': 44,
  '@happyvertical/smrt-ledgers': 41,
  '@happyvertical/smrt-messages': 110,
  '@happyvertical/smrt-sales': 53,
  '@happyvertical/smrt-users': 606,
};

/** Packages under 30 s are not listed; the measured median was about 12 s. */
const DEFAULT_SECONDS = 12;

/**
 * Partition `names` into `count` shards, longest first into the lightest
 * shard. Every name lands in exactly one shard, and the result depends only on
 * the set of names, never on their input order.
 *
 * @param {string[]} names
 * @param {number} count
 * @param {Record<string, number>} seconds
 * @returns {string[][]} one sorted list of names per shard
 */
export function balanceShards(names, count, seconds) {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`Invalid shard count ${count}`);
  }
  const weight = (name) => seconds[name] ?? DEFAULT_SECONDS;
  const shards = Array.from({ length: count }, () => ({ total: 0, names: [] }));
  const longestFirst = [...new Set(names)].sort(
    (a, b) => weight(b) - weight(a) || (a < b ? -1 : 1),
  );
  for (const name of longestFirst) {
    let lightest = shards[0];
    for (const shard of shards) {
      if (shard.total < lightest.total) lightest = shard;
    }
    lightest.names.push(name);
    lightest.total += weight(name);
  }
  return shards.map((shard) => shard.names.sort());
}

/**
 * Packages that never share a runner. smrt-template-sveltekit's SQLite-backed
 * onboarding cases hit SQLITE_PROTOCOL (WAL lock acquisition) when starved by
 * neighbouring heavy packages (#4990).
 */
export const DEDICATED_PACKAGES = ['@happyvertical/smrt-template-sveltekit'];

/**
 * One shard of `names`: each dedicated package alone on a trailing shard, the
 * rest balanced over the leading shards. With no more shards than dedicated
 * packages, nothing is reserved and every package is balanced together.
 *
 * @param {string[]} names
 * @param {{ index: number, count: number }} shard 1-based
 * @param {Record<string, number>} seconds
 * @returns {string[]}
 */
export function selectShard(names, { index, count }, seconds) {
  const dedicated = count > DEDICATED_PACKAGES.length ? DEDICATED_PACKAGES : [];
  const sharedShards = count - dedicated.length;
  if (index > sharedShards) {
    const owner = dedicated[index - 1 - sharedShards];
    return names.includes(owner) ? [owner] : [];
  }
  const shared = names.filter((name) => !dedicated.includes(name));
  return balanceShards(shared, sharedShards, seconds)[index - 1];
}
