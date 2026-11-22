/**
 * The app shell's user app in a logical bundle (#5193).
 *
 * The shell keeps a person's own app in a separate database,
 * `<data root>/user-app/app.db`, with tables created at run time, so the
 * manifest-driven export never sees it. This module is the CLI's side of
 * carrying it: the engine (`@happyvertical/smrt-app-shell/engine`, the only
 * code allowed to open that database) reads and writes the database; the CLI
 * supplies the version history from the shell's own tables, refuses while
 * changes wait and drops outstanding approvals.
 *
 * Moves: changes waiting are NOT migrated (export refuses until the owner
 * applies or discards them); approvals that were still waiting to be
 * applied (`pending`, `accepted`, `executing`) are dropped from the bundle and
 * counted in the result, because each is pinned to data and a version that
 * the destination does not share. Decided approvals stay as history.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { PortableRow, PortableTable } from './portability-assets.js';

/**
 * The slice of `@happyvertical/smrt-app-shell/engine` portability uses.
 * Declared here, not imported, so the CLI neither type-checks nor builds
 * against the app shell: the shell is an optional peer, loaded at run time.
 */
export interface UserAppVersionRecord {
  version: number;
  parent: number | null;
  author: string;
  summary: string;
  definition: unknown;
  migration: { steps: unknown[]; purged?: boolean } | null;
  createdAt: string;
}

/** The bundle's `userApp` section (the engine's `PortableUserApp`). */
export interface UserAppSection {
  format: number;
  /** Which database the section was read from (`sqlite` or `postgres`). */
  source?: string;
  definition: unknown;
  version: number;
  versions: UserAppVersionRecord[];
  versionsDigest: string;
  tables: Array<{
    name: string;
    /** The engine's typed column descriptors; the CLI only carries them. */
    columns: unknown[];
    rows: Array<Record<string, unknown>>;
    digest: string;
  }>;
  digest: string;
}

export interface UserAppEngine {
  checkUserAppBundle(bundle: UserAppSection): string[];
  digestVersionHistory(versions: UserAppVersionRecord[]): string;
  exportUserApp(options: {
    dataDir: string;
    versions: UserAppVersionRecord[];
  }): Promise<UserAppSection>;
  importUserApp(options: { dataDir: string; bundle: UserAppSection }): Promise<{
    status: 'imported' | 'already-imported';
    tables: number;
    rows: number;
    digest: string;
  }>;
  inspectUserApp(options: { dataDir: string }): Promise<{
    integrity: boolean;
    recorded: boolean;
  }>;
}

/** Directory of the user app inside the data root (the shell's contract). */
export const USER_APP_DIRNAME = 'user-app';

/** Shell tables the move reads. */
export const VERSIONS_TABLE = 'app_versions';
export const DRAFTS_TABLE = 'app_drafts';
export const CHANGE_BATCHES_TABLE = 'change_batches';
export const CHANGE_CARDS_TABLE = 'change_cards';
export const APPROVALS_TABLE = 'approvals';

/** Approvals not yet applied; not carried across a move. */
export const OUTSTANDING_APPROVAL_STATUSES: ReadonlySet<string> = new Set([
  'pending',
  'accepted',
  'executing',
]);

/** Draft states that mean a working copy is in progress. */
const OPEN_DRAFT_STATUSES: ReadonlySet<string> = new Set(['starting', 'open']);

/** Batch states that hold changes the owner has not applied (`held`: an import owns them). */
const WAITING_BATCH_STATUSES: ReadonlySet<string> = new Set(['open', 'held']);

/** The user app's directory in a data root. */
export function userAppDirectory(root: string): string {
  return join(root, USER_APP_DIRNAME);
}

/** True when the data root holds a user app database (a file check only). */
export function hasUserApp(root: string | undefined | null): boolean {
  return (
    Boolean(root) &&
    existsSync(join(userAppDirectory(root as string), 'app.db'))
  );
}

const ENGINE_PACKAGE = '@happyvertical/smrt-app-shell';

/**
 * The engine's entry file as the PROJECT installs it: the project's own
 * `node_modules` (or the project itself, for the shell package), found by
 * walking up from `sourceRoot`. The CLI has no package edge to the shell
 * (it would close a dependency cycle), so it cannot resolve it by name.
 */
function engineEntryFor(sourceRoot: string): string | null {
  for (let dir = resolve(sourceRoot); ; dir = dirname(dir)) {
    for (const base of [
      dir,
      join(dir, 'node_modules', '@happyvertical', 'smrt-app-shell'),
    ]) {
      try {
        const manifest = JSON.parse(
          readFileSync(join(base, 'package.json'), 'utf8'),
        ) as {
          name?: string;
          exports?: Record<string, { import?: string } | string>;
        };
        const entry = manifest.exports?.['./engine'];
        const file = typeof entry === 'string' ? entry : entry?.import;
        if (manifest.name === ENGINE_PACKAGE && file) return join(base, file);
      } catch {
        // not here
      }
    }
    if (dirname(dir) === dir) return null;
  }
}

/** Load the engine from the project, or explain how to get it. */
export async function loadUserAppEngine(
  sourceRoot: string,
): Promise<UserAppEngine> {
  const entry = engineEntryFor(sourceRoot);
  if (!entry) {
    throw new Error(
      `This data root holds an app shell user app, but ${ENGINE_PACKAGE} is not installed in the project, so it cannot be read or verified. Install it and retry.`,
    );
  }
  return (await import(pathToFileURL(entry).href)) as UserAppEngine;
}

/**
 * THE waiting check. True when the owner has changes waiting (#5178): a batch
 * `open`/`held` with at least one active card, or a working copy still open
 * (`app_drafts`). Kept in one small function so a change to the concept is a
 * change here and nowhere else.
 */
export function hasChangesWaiting(tables: readonly PortableTable[]): boolean {
  const rowsOf = (name: string) =>
    tables.find((table) => table.name === name)?.rows ?? [];
  const waitingBatches = new Set(
    rowsOf(CHANGE_BATCHES_TABLE)
      .filter((row) => WAITING_BATCH_STATUSES.has(String(row.status ?? '')))
      .map((row) => String(row.id ?? '')),
  );
  return (
    rowsOf(CHANGE_CARDS_TABLE).some(
      (row) =>
        row.status === 'active' && waitingBatches.has(String(row.batch_id)),
    ) ||
    rowsOf(DRAFTS_TABLE).some((row) =>
      OPEN_DRAFT_STATUSES.has(String(row.status ?? '')),
    )
  );
}

/** Refuse a move while changes wait, telling the owner what to do. */
export function assertNoChangesWaiting(tables: readonly PortableTable[]): void {
  if (hasChangesWaiting(tables)) {
    throw new Error(
      'Changes are waiting in the app. Changes waiting are not carried across an export or migration: apply them or discard them in the app, then run this again.',
    );
  }
}

/** Remove approvals still waiting to be applied; report how many. */
export function withoutOutstandingApprovals(tables: PortableTable[]): {
  tables: PortableTable[];
  dropped: number;
} {
  let dropped = 0;
  const kept = tables.map((table) => {
    if (table.name !== APPROVALS_TABLE) return table;
    const rows = table.rows.filter((row: PortableRow) => {
      const outstanding = OUTSTANDING_APPROVAL_STATUSES.has(
        String(row.status ?? ''),
      );
      if (outstanding) dropped += 1;
      return !outstanding;
    });
    return { ...table, rows };
  });
  return { tables: kept, dropped };
}

/** The engine's version records, from the shell's `app_versions` rows. */
export function userAppVersionsFromTables(
  tables: readonly PortableTable[],
): UserAppVersionRecord[] {
  const rows =
    tables.find((table) => table.name === VERSIONS_TABLE)?.rows ?? [];
  return rows
    .map((row) => {
      const migration = row.migration
        ? (JSON.parse(String(row.migration)) as {
            steps: never[];
            purged?: boolean;
          })
        : null;
      if (migration && row.purged && row.purged !== '0')
        migration.purged = true;
      const parent = Number(row.parent);
      const created = row.created_at as unknown;
      return {
        version: Number(row.version),
        parent: parent < 0 ? null : parent,
        author: String(row.author ?? ''),
        summary: String(row.summary ?? ''),
        definition: JSON.parse(String(row.definition)),
        migration,
        createdAt:
          created instanceof Date ? created.toISOString() : String(created),
      };
    })
    .sort((left, right) => left.version - right.version);
}

/** What a result reports about the carried user app. */
export interface UserAppSummary {
  tables: number;
  rows: number;
  versions: number;
  digest: string;
}

/** Counts and digest of a bundle section. */
export function summarizeUserApp(section: UserAppSection): UserAppSummary {
  return {
    tables: section.tables.length,
    rows: section.tables.reduce((count, table) => count + table.rows.length, 0),
    versions: section.versions.length,
    digest: section.digest,
  };
}
