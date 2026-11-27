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
 * or missing entry makes shards uneven, never drops a package. Refresh the
 * `test` table with `scripts/measure-test-seconds.mjs` over merge-group
 * `test-packages` job logs; refresh the PostgreSQL table from the `Duration`
 * lines each package's Vitest runs print in a PostgreSQL job log, summed per
 * package.
 *
 * Read those logs with `gh api repos/{owner}/{repo}/actions/jobs/{id}/logs`.
 * `gh run view --job {id} --log` cuts a large job log short without saying so:
 * the first table was built from it and missed five packages, among them the
 * second and fourth slowest (#5074).
 */

/**
 * `test` task seconds at two Vitest workers: the median of five full-mode
 * merge-group runs, 45826454208, 45845580152, 45876975431, 45890569809 and
 * 45891849139 (2026-11-26, after #5667's weights). Each is the wall time of the
 * unit's turbo task, from Vitest's `Start at` to the task's log block, so it
 * includes the sibling task on the other `--concurrency=2` lane (#5706;
 * `scripts/measure-test-seconds.mjs` reproduces it). Packages under 30 s are
 * not listed. smrt-template-sveltekit is not listed either: it always has a
 * shard to itself (DEDICATED_PACKAGES), so its weight steers nothing.
 *
 * app-shell: see SPLIT_TEST_UNITS. Its three units were 1196 s as one unit
 * (merge-group run 44699654477), the long pole of `test-packages (2/5)`.
 */
export const TEST_SECONDS = {
  '@happyvertical/smrt-agents': 77,
  '@happyvertical/smrt-analytics': 52,
  '@happyvertical/smrt-app-runtime': 504,
  '@happyvertical/smrt-app-shell#test:configs': 540,
  '@happyvertical/smrt-app-shell#test:unit:1of2': 951,
  '@happyvertical/smrt-app-shell#test:unit:2of2': 785,
  '@happyvertical/smrt-assets': 48,
  '@happyvertical/smrt-bundle-gate': 68,
  '@happyvertical/smrt-chat': 387,
  '@happyvertical/smrt-cli': 331,
  '@happyvertical/smrt-comments': 35,
  '@happyvertical/smrt-commerce': 426,
  '@happyvertical/smrt-content': 155,
  '@happyvertical/smrt-desktop': 33,
  '@happyvertical/smrt-dev-mcp': 41,
  '@happyvertical/smrt-education': 321,
  '@happyvertical/smrt-expenses': 99,
  '@happyvertical/smrt-facts': 40,
  '@happyvertical/smrt-fields': 39,
  '@happyvertical/smrt-images': 33,
  '@happyvertical/smrt-inference': 46,
  '@happyvertical/smrt-ingestion': 621,
  '@happyvertical/smrt-jobs': 86,
  '@happyvertical/smrt-manufacturing': 50,
  '@happyvertical/smrt-messages': 560,
  '@happyvertical/smrt-planner': 91,
  '@happyvertical/smrt-profiles': 37,
  '@happyvertical/smrt-projects': 60,
  '@happyvertical/smrt-reports': 40,
  '@happyvertical/smrt-sales': 93,
  '@happyvertical/smrt-subscriptions': 38,
  '@happyvertical/smrt-support': 67,
  '@happyvertical/smrt-svelte': 403,
  '@happyvertical/smrt-tenancy': 43,
  '@happyvertical/smrt-timesheets': 55,
  '@happyvertical/smrt-ui': 169,
  '@happyvertical/smrt-users': 284,
  '@happyvertical/smrt-vitest': 38,
  '@happyvertical/smrt-workflows': 35,
};

/**
 * `test:postgres` task seconds, PostgreSQL merge-group run of 2026-11-16, with
 * the #5649 additions from merge-group run 45076013203 (core), and #5664's
 * app-shell units.
 * Keys are package names, or `<package>#<task>` ids for a package listed in
 * SPLIT_POSTGRES_UNITS.
 */
export const POSTGRES_TEST_SECONDS = {
  '@happyvertical/smrt-analytics': 40,
  // app-shell: see SPLIT_POSTGRES_UNITS. 1386 s measured as one unit (12
  // files, one process), the long pole of `remaining:1/3` (30.9 min). The
  // unit weights split that by each file's test time in PostgreSQL run
  // 45718543710 (1of3 postgres-drafts 393 s; 2of3 store-in-swap and six small
  // files 227 s; 3of3 four files 201 s), scaled by 1386/822 to the measured total.
  '@happyvertical/smrt-app-shell#test:postgres:1of3': 664,
  '@happyvertical/smrt-app-shell#test:postgres:2of3': 383,
  '@happyvertical/smrt-app-shell#test:postgres:3of3': 339,
  '@happyvertical/smrt-app-runtime': 41,
  '@happyvertical/smrt-cli': 33,
  '@happyvertical/smrt-commerce': 285,
  // core: see SPLIT_POSTGRES_UNITS. The real-PG half measured about 360 s; the
  // PGlite half 721-1227 s over 41 files (it was chained after the real-PG
  // run, 808 s as one unit before). 960 s sits mid-range.
  '@happyvertical/smrt-core#test:postgres:pglite': 960,
  '@happyvertical/smrt-core#test:postgres:real': 360,
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

/**
 * Packages whose `test:postgres` script chains a suite that needs the run's
 * database with one that does not (#5649). `core` ran its real-PG files
 * (`optional.test.ts`, one shared database, one process) and then 41 PGlite
 * files in-process, one after the other in a single 721-1227 s tail. Each half
 * is its own package script and `turbo.json` task so the two can run on
 * different runners. The `test:postgres` script stays the local aggregate and
 * is never scheduled in CI for a package listed here, so no file runs twice.
 *
 * `app-shell` (#5664) is three file-list units. Its 12 files each build their
 * own schemas and roles, so they need no shared database; each unit runs in
 * its own process on its own disposable database, and
 * `scripts/app-shell-postgres-units.test.mjs` pins that the units' files are
 * exactly `POSTGRES_SUITES`, each once.
 */
export const SPLIT_POSTGRES_UNITS = {
  '@happyvertical/smrt-app-shell': [
    'test:postgres:1of3',
    'test:postgres:2of3',
    'test:postgres:3of3',
  ],
  '@happyvertical/smrt-core': ['test:postgres:real', 'test:postgres:pglite'],
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

/**
 * Turn registered `test:postgres` package names into lane units: a package in
 * SPLIT_POSTGRES_UNITS becomes one unit per task, every other package its
 * plain `test:postgres`.
 *
 * @param {string[]} names
 * @returns {string[]} unit ids, sorted and de-duplicated
 */
export function expandPostgresUnits(names) {
  return [
    ...new Set(
      names.flatMap((name) =>
        (SPLIT_POSTGRES_UNITS[name] ?? ['test:postgres']).map((task) =>
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
    // Units of one package (app-shell's) avoid sharing a shard while a shard
    // without a sibling exists: sibling units run in the same package
    // directory, and two of them can run at once under `--concurrency=2`.
    const owner = unitPackage(name);
    const hasSibling = (shard) =>
      shard.names.some((other) => other !== name && unitPackage(other) === owner);
    const free = shards.filter((shard) => !hasSibling(shard));
    const pool = free.length > 0 ? free : shards;
    let lightest = pool[0];
    for (const shard of pool) {
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
