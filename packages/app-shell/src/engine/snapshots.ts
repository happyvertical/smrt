// Retention for `<dataDir>/snapshots`. Only plain files whose names match the
// engine's own pattern are ever touched: never a directory, a symlink, or a
// file someone else put there.
import { readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

/** How many `method-*` snapshots stay (each applied method write takes one). */
export const METHOD_SNAPSHOTS_KEPT = 20;

export type SnapshotKind = 'method' | 'migrate' | 'schema';

/** `<epoch ms>-<counter>-<kind...>.db`, as `AppRuntime.snapshot` names them. */
const NAME =
  /^(\d{1,16})-(\d{1,9})-(method-|migrate-|schema)[A-Za-z0-9._-]*\.db$/;

interface Found {
  name: string;
  at: number;
  n: number;
  kind: SnapshotKind;
}

function ours(dir: string): Found[] {
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: Found[] = [];
  for (const e of entries) {
    if (!e.isFile()) continue; // symlinks and directories are left alone
    const m = NAME.exec(e.name);
    if (!m) continue;
    out.push({
      name: e.name,
      at: Number(m[1]),
      n: Number(m[2]),
      kind: m[3].replace(/-$/, '') as SnapshotKind,
    });
  }
  return out.sort((a, b) => a.at - b.at || a.n - b.n);
}

function remove(dir: string, files: Found[]): number {
  let removed = 0;
  for (const f of files)
    try {
      unlinkSync(join(dir, f.name));
      removed++;
    } catch {
      // already gone or not ours to remove: retention is best effort
    }
  return removed;
}

/** Keep the newest `keep` `method-*` snapshots; delete the rest. */
export function pruneMethodSnapshots(
  dir: string,
  keep = METHOD_SNAPSHOTS_KEPT,
): number {
  const method = ours(dir).filter((f) => f.kind === 'method');
  return remove(dir, method.slice(0, Math.max(0, method.length - keep)));
}

/** Delete `migrate-*` and `schema-*` snapshots taken before `beforeMs`. */
export function pruneMigrationSnapshots(dir: string, beforeMs: number): number {
  return remove(
    dir,
    ours(dir).filter((f) => f.kind !== 'method' && f.at < beforeMs),
  );
}
