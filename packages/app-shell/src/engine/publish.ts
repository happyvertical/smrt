// Publishing a draft: the pure parts (digest, definition diff) and the file
// operations around the guarded swap of `app.db`, with their crash recovery.
//
// The swap, in order (host.ts drives it; every step has a tested failure path):
//   1. a consistent copy of live is rehearsed with the draft's changes
//   2. a snapshot of live is taken (snapshots/<ts>-0-migrate-prepublish.db)
//   3. the journal is written, the live worker is retired
//   4. live's app.db (+ -wal/-shm/-journal) is renamed to `<name>.prepublish`,
//      the rehearsed file is renamed to app.db        <- the crash window
//   5. the new worker starts, the versions are written to the store
//   6. the journal and the `.prepublish` files are removed
// Before step 4 nothing of live has changed; after a failure in 4 or 5 the
// `.prepublish` files are renamed back, so app.db is byte-for-byte what it was.
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { AppDefinition, FieldDef, MethodDef, Step } from './definition.ts';
import { EngineError } from './errors.ts';
import type { VersionRecord } from './store.ts';

// ---------- the draft's chain, its digest ----------

/** What a draft hands to a publish: its base and the versions made since, oldest first. */
export interface DraftChain {
  baseVersion: number;
  base: VersionRecord;
  versions: VersionRecord[];
}

/** Stable JSON: object keys sorted, so equal values give equal text. */
export function canonical(v: unknown): string {
  const norm = (x: unknown): unknown =>
    Array.isArray(x)
      ? x.map(norm)
      : x && typeof x === 'object'
        ? Object.fromEntries(
            Object.entries(x as Record<string, unknown>)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([k, val]) => [k, norm(val)]),
          )
        : x;
  return JSON.stringify(norm(v));
}

/**
 * Identity of what a publish would apply: the live version it starts from and,
 * per draft version, its summary, definition and steps. The numbers the
 * versions get in live are not part of it.
 */
export function chainDigest(liveVersion: number, chain: DraftChain): string {
  return createHash('sha256')
    .update(
      canonical({
        liveVersion,
        base: chain.base.definition,
        versions: chain.versions.map((r) => ({
          author: r.author,
          summary: r.summary,
          definition: r.definition,
          steps: r.migration?.steps ?? [],
        })),
      }),
    )
    .digest('hex');
}

// ---------- the definition diff ----------

export interface FieldChange {
  field: string;
  from: FieldDef;
  to: FieldDef;
}
export interface ModelDiff {
  fieldsAdded: string[];
  fieldsRemoved: string[];
  fieldsChanged: FieldChange[];
}
export interface DefinitionDiff {
  modelsAdded: string[];
  modelsRemoved: string[];
  /** Per model that exists on both sides and differs. */
  models: Record<string, ModelDiff>;
  recipesAdded: string[];
  recipesRemoved: string[];
}

const keys = (o: object | undefined) => Object.keys(o ?? {});

/** What changes from `from` to `to`. A rename shows as a removal and an addition; the steps say it was a rename. */
export function diffDefinitions(
  from: AppDefinition,
  to: AppDefinition,
): DefinitionDiff {
  const out: DefinitionDiff = {
    modelsAdded: keys(to.models).filter((m) => !(m in from.models)),
    modelsRemoved: keys(from.models).filter((m) => !(m in to.models)),
    models: {},
    recipesAdded: to.recipes.filter((r) => !from.recipes.includes(r)),
    recipesRemoved: from.recipes.filter((r) => !to.recipes.includes(r)),
  };
  for (const m of keys(to.models)) {
    if (!(m in from.models)) continue;
    const a = from.models[m].fields;
    const b = to.models[m].fields;
    const d: ModelDiff = {
      fieldsAdded: keys(b).filter((f) => !(f in a)),
      fieldsRemoved: keys(a).filter((f) => !(f in b)),
      fieldsChanged: keys(b)
        .filter((f) => f in a && canonical(a[f]) !== canonical(b[f]))
        .map((f) => ({ field: f, from: a[f], to: b[f] })),
    };
    if (
      d.fieldsAdded.length ||
      d.fieldsRemoved.length ||
      d.fieldsChanged.length
    )
      out.models[m] = d;
  }
  return out;
}

export interface PublishMethod {
  model: string;
  name: string;
  description: string;
  params: Record<string, unknown>;
  /** The full code: what the owner approves is what will run. */
  code: string;
  change: 'added' | 'changed' | 'unchanged';
}

/** Every method of `to`, in full, marked against `from`. */
export function listMethods(
  from: AppDefinition,
  to: AppDefinition,
): PublishMethod[] {
  const out: PublishMethod[] = [];
  for (const [model, md] of Object.entries(to.models))
    for (const [name, meth] of Object.entries(md.methods ?? {})) {
      const before: MethodDef | undefined = from.models[model]?.methods?.[name];
      out.push({
        model,
        name,
        description: meth.description,
        params: meth.params ?? {},
        code: meth.code,
        change: !before
          ? 'added'
          : canonical(before) === canonical(meth)
            ? 'unchanged'
            : 'changed',
      });
    }
  return out;
}

/** Names of the archive tables a chain's steps create. */
export function archivedTables(steps: Step[]): string[] {
  return steps.flatMap((s) => (s.op === 'archiveTable' ? [s.archivedAs] : []));
}

// ---------- the journal and the file swap ----------

export const JOURNAL_FILE = 'publish-journal.json';
export const ASIDE = '.prepublish';
/** The files that make up a SQLite database, main file LAST (see {@link moveAside}). */
const DB_PARTS = ['app.db-journal', 'app.db-shm', 'app.db-wal', 'app.db'];
const REHEARSAL = /^publish-rehearsal-[A-Za-z0-9]+$/;

export interface PublishJournal {
  format: 1;
  /** Live's version before, the version the publish ends on. */
  oldVersion: number;
  finalVersion: number;
  rehearsal: string;
  /** The prepublish snapshot (a retained copy of the old data). */
  snapshot: string;
  startedAt: string;
}

export function readJournal(dataDir: string): PublishJournal | null {
  const file = join(dataDir, JOURNAL_FILE);
  if (!existsSync(file)) return null;
  try {
    const j = JSON.parse(readFileSync(file, 'utf8')) as PublishJournal;
    if (
      j?.format !== 1 ||
      !Number.isInteger(j.oldVersion) ||
      !Number.isInteger(j.finalVersion)
    )
      throw new Error('bad shape');
    return j;
  } catch {
    // Guessing about a half-finished swap could lose data: refuse to start.
    throw new EngineError(
      `${JOURNAL_FILE} in ${dataDir} is unreadable, so an interrupted publish cannot be recovered automatically; restore app.db from the .prepublish files or the newest migrate-prepublish snapshot`,
      'refused',
    );
  }
}

/** Written whole and renamed into place, so it is either absent or complete. */
export function writeJournal(dataDir: string, j: PublishJournal): void {
  const tmp = join(dataDir, `${JOURNAL_FILE}.tmp`);
  writeFileSync(tmp, JSON.stringify(j));
  renameSync(tmp, join(dataDir, JOURNAL_FILE));
}

export function removeJournal(dataDir: string): void {
  rmSync(join(dataDir, JOURNAL_FILE), { force: true });
  rmSync(join(dataDir, `${JOURNAL_FILE}.tmp`), { force: true });
}

/**
 * A `.prepublish` file already there is not ours (a publish removes its own):
 * restoring it later would replace live's data with it. So a publish refuses
 * to start, and `restoreAside` is only ever run for asides this publish made.
 */
export function assertNoAside(dataDir: string): void {
  for (const n of DB_PARTS)
    if (existsSync(join(dataDir, n + ASIDE)))
      throw new EngineError(
        `${n + ASIDE} is already there from an earlier publish; not overwriting it`,
        'refused',
      );
}

/**
 * Rename live's database files to `<name>.prepublish`. The side files go
 * first and `app.db` last, so "app.db is gone" always means "all of them are
 * aside". Refuses if an aside file is already there (a leftover to look at).
 */
export function moveAside(dataDir: string): void {
  assertNoAside(dataDir);
  for (const n of DB_PARTS)
    if (existsSync(join(dataDir, n)))
      renameSync(join(dataDir, n), join(dataDir, n + ASIDE));
}

/**
 * Put the `.prepublish` files back. If the main file was moved aside, whatever
 * stands at the live names now belongs to the new database and is removed
 * first (a foreign -wal next to the old file would be replayed into it).
 * If only side files were moved, the main file never left: just rename them back.
 * Safe to run at any point of the swap, and again.
 */
export function restoreAside(dataDir: string): void {
  if (existsSync(join(dataDir, `app.db${ASIDE}`)))
    for (const n of DB_PARTS) rmSync(join(dataDir, n), { force: true });
  for (const n of DB_PARTS)
    if (existsSync(join(dataDir, n + ASIDE)))
      renameSync(join(dataDir, n + ASIDE), join(dataDir, n));
}

export function dropAside(dataDir: string): void {
  for (const n of DB_PARTS) rmSync(join(dataDir, n + ASIDE), { force: true });
}

export function rehearsalDirName(): string {
  return `publish-rehearsal-${createHash('sha1')
    .update(`${process.hrtime.bigint()}${Math.random()}`)
    .digest('hex')
    .slice(0, 10)}`;
}

export function makeRehearsalDir(dataDir: string): string {
  const dir = join(dataDir, rehearsalDirName());
  mkdirSync(join(dir, 'final'), { recursive: true });
  return dir;
}

/** Remove one rehearsal directory, only if it is one of ours (by name). */
export function removeRehearsal(dataDir: string, dir: string): void {
  if (dirname(dir) === dataDir && REHEARSAL.test(basename(dir)))
    rmSync(dir, { recursive: true, force: true });
}

/**
 * Run at every host start, before the app opens: finish or undo an interrupted
 * publish. The new database was never written to before the store committed
 * (the change queue is held until then), so:
 *  - the store already points at the published version: the publish happened,
 *    only the leftovers are removed;
 *  - otherwise the old files come back.
 * Returns what it did.
 */
export function reconcilePublish(
  dataDir: string,
  current: number | null,
): 'none' | 'rolled-forward' | 'rolled-back' {
  const journal = readJournal(dataDir);
  let did: 'none' | 'rolled-forward' | 'rolled-back' = 'none';
  if (journal) {
    if (current === journal.finalVersion) {
      dropAside(dataDir);
      did = 'rolled-forward';
    } else {
      restoreAside(dataDir);
      did = 'rolled-back';
    }
    removeJournal(dataDir);
  }
  for (const e of readdirSync(dataDir, { withFileTypes: true }))
    if (e.isDirectory() && REHEARSAL.test(e.name))
      rmSync(join(dataDir, e.name), { recursive: true, force: true });
  return did;
}
