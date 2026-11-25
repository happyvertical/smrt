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
 * from the `Duration` lines each package's Vitest runs print in a merge-group
 * `test-packages` or PostgreSQL job log, summed per package.
 *
 * Read those logs with `gh api repos/{owner}/{repo}/actions/jobs/{id}/logs`.
 * `gh run view --job {id} --log` cuts a large job log short without saying so:
 * the first table was built from it and missed five packages, among them the
 * second and fourth slowest (#5074).
 */

/** `test` task seconds at two Vitest workers, merge-group run 44026049881. */
export const TEST_SECONDS = {
  '@happyvertical/smrt-agents': 96,
  '@happyvertical/smrt-analytics': 57,
  '@happyvertical/smrt-app-mcp': 31,
  '@happyvertical/smrt-app-runtime': 546,
  // app-shell: see SPLIT_TEST_UNITS. 1196 s measured as one unit (118 files,
  // merge-group run 44699654477), the long pole of `test-packages (2/5)`
  // (29.7 min against 14-16 in its neighbours). The unit weights split that
  // time by a local run at two workers (default config 649 s over two
  // shards, pglite+dom+packed 175 s), scaled by 1200/824 to CI speed.
  // Refresh them from a merge-group log, as for every other entry.
  '@happyvertical/smrt-app-shell#test:configs': 255,
  '@happyvertical/smrt-app-shell#test:unit:1of2': 470,
  '@happyvertical/smrt-app-shell#test:unit:2of2': 470,
  '@happyvertical/smrt-assets': 49,
  '@happyvertical/smrt-bundle-gate': 82,
  '@happyvertical/smrt-chat': 392,
  '@happyvertical/smrt-cli': 315,
  '@happyvertical/smrt-comments': 35,
  '@happyvertical/smrt-commerce': 400,
  '@happyvertical/smrt-content': 189,
  '@happyvertical/smrt-desktop': 34,
  '@happyvertical/smrt-dev-mcp': 51,
  '@happyvertical/smrt-education': 466,
  '@happyvertical/smrt-expenses': 90,
  '@happyvertical/smrt-facts': 42,
  '@happyvertical/smrt-fields': 52,
  '@happyvertical/smrt-human-resources': 32,
  '@happyvertical/smrt-images': 42,
  '@happyvertical/smrt-inference': 53,
  '@happyvertical/smrt-ingestion': 692,
  '@happyvertical/smrt-jobs': 99,
  '@happyvertical/smrt-manufacturing': 59,
  '@happyvertical/smrt-messages': 82,
  '@happyvertical/smrt-planner': 147,
  '@happyvertical/smrt-profiles': 41,
  '@happyvertical/smrt-projects': 79,
  '@happyvertical/smrt-reports': 46,
  '@happyvertical/smrt-sales': 104,
  '@happyvertical/smrt-subscriptions': 51,
  '@happyvertical/smrt-support': 61,
  '@happyvertical/smrt-svelte': 401,
  '@happyvertical/smrt-timesheets': 55,
  '@happyvertical/smrt-ui': 199,
  '@happyvertical/smrt-users': 336,
  '@happyvertical/smrt-vitest': 42,
  '@happyvertical/smrt-workflows': 37,
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

/**
 * Packages whose `test` task is too long for one runner and is exposed as
 * several hard-coded sibling tasks instead (#5647). Each task is its own
 * `package.json` script and `turbo.json` task, because Turbo hands `--` args
 * to the last command of an `&&` chain and to every package in a run.
 *
 * `app-shell` ran four Vitest configs back to back, 1049-1462 s as one unit.
 * The default config (`fileParallelism: false`) is split with `--shard`; the
 * pglite, dom and packed configs run together as `test:configs`. The `test`
 * script stays the local aggregate and is never scheduled in CI for a package
 * listed here, so no file runs twice.
 */
export const SPLIT_TEST_UNITS = {
  '@happyvertical/smrt-app-shell': [
    'test:unit:1of2',
    'test:unit:2of2',
    'test:configs',
  ],
};

/** A unit id: `<package>#<turbo task>`, the form `turbo run` accepts. */
export const unitId = (packageName, task) => `${packageName}#${task}`;

/** The package part of a unit id, or the name itself for a bare package. */
export const unitPackage = (name) => name.split('#')[0];

/**
 * Turn package names into the CI units to run: a split package becomes one
 * unit per task in SPLIT_TEST_UNITS, every other package its plain `test`.
 *
 * @param {string[]} names
 * @returns {string[]} unit ids, sorted and de-duplicated
 */
export function expandTestUnits(names) {
  return [
    ...new Set(
      names.flatMap((name) =>
        (SPLIT_TEST_UNITS[name] ?? ['test']).map((task) =>
          unitId(name, task),
        ),
      ),
    ),
  ].sort();
}

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
  // A plain `<package>#test` unit weighs what its package does.
  const weight = (name) =>
    seconds[name] ?? seconds[unitPackage(name)] ?? DEFAULT_SECONDS;
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
 * `names` are package names or `<package>#<task>` unit ids (see
 * `expandTestUnits`); a dedicated package is recognised by its package part.
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
    return names.filter((name) => unitPackage(name) === owner);
  }
  const shared = names.filter(
    (name) => !dedicated.includes(unitPackage(name)),
  );
  return balanceShards(shared, sharedShards, seconds)[index - 1];
}
