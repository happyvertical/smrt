/** Filesystem durability shared by snapshot publication and extraction. */
import { open, realpath } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Flush a directory's entries on POSIX. Windows retains file flushes only:
 * directory-handle flushing is not portable through Node's filesystem API.
 * See agents/encrypted-snapshots.md for the platform durability boundary.
 */
export async function syncSnapshotDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  try {
    const directory = await open(path, 'r');
    try {
      if (!(await directory.stat()).isDirectory()) {
        throw new Error('Snapshot directory is no longer a directory');
      }
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (cause) {
    throw new Error(
      `Cannot sync snapshot directory ${path}; check storage health and use a filesystem that supports directory fsync`,
      { cause },
    );
  }
}

/**
 * Commit a new artifact name and every ancestor entry our recursive mkdir
 * created. Syncing only the leaf directory can lose a newly created parent
 * after a crash. Real paths preserve the filesystem's symlink/.. semantics.
 */
export async function syncSnapshotParents(
  destination: string,
  firstCreatedParent: string | undefined,
): Promise<void> {
  if (process.platform === 'win32') return;
  let directory = await realpath(dirname(destination));
  const stop = firstCreatedParent
    ? dirname(await realpath(firstCreatedParent))
    : directory;
  for (;;) {
    await syncSnapshotDirectory(directory);
    if (directory === stop) return;
    const parent = dirname(directory);
    if (parent === directory) {
      throw new Error('Snapshot parent changed during publication');
    }
    directory = parent;
  }
}
