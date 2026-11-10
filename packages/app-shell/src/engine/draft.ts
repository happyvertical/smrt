// Drafts: a draft is a second app host over a COPY of the live data, in its own
// directory next to the live one. The directory carries a marker file that only
// the engine writes; it is what makes a directory a draft (and therefore what
// allows `autoApprove`, and what lets a discard delete it).
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { EngineError } from './errors.ts';

export const DRAFT_MARKER_FILE = '.smrt-draft.json';

export interface DraftMarker {
  kind: 'smrt-app-draft';
  format: 1;
  /** The live data directory this draft was copied from (real path). */
  liveDir: string;
  /** The live version the draft started from. */
  baseVersion: number;
  createdAt: string;
}

/** A path as the file system sees it; the plain resolved path while it does not exist. */
export function realDir(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

export function sameDir(a: string, b: string): boolean {
  return realDir(a) === realDir(b);
}

/** The marker of a draft directory, or null for an ordinary (live) one. */
export function readDraftMarker(dataDir: string): DraftMarker | null {
  const file = join(dataDir, DRAFT_MARKER_FILE);
  if (!existsSync(file)) return null;
  let m: Partial<DraftMarker>;
  try {
    m = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new EngineError(
      `${DRAFT_MARKER_FILE} in ${dataDir} is unreadable; remove the draft directory`,
      'refused',
    );
  }
  if (
    m?.kind !== 'smrt-app-draft' ||
    m.format !== 1 ||
    typeof m.liveDir !== 'string' ||
    !Number.isInteger(m.baseVersion)
  )
    throw new EngineError(
      `${DRAFT_MARKER_FILE} in ${dataDir} is not a draft marker`,
      'refused',
    );
  return m as DraftMarker;
}

/** Engine-internal: nothing outside the engine may make a directory a draft. */
export function writeDraftMarker(
  dataDir: string,
  liveDir: string,
  baseVersion: number,
): DraftMarker {
  const marker: DraftMarker = {
    kind: 'smrt-app-draft',
    format: 1,
    liveDir: realDir(liveDir),
    baseVersion,
    createdAt: new Date().toISOString(),
  };
  writeFileSync(join(dataDir, DRAFT_MARKER_FILE), JSON.stringify(marker), {
    flag: 'wx',
  });
  return marker;
}
