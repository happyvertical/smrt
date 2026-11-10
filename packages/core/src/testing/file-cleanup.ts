import { rm } from 'node:fs/promises';

type ClosableDatabase = {
  close?: () => Promise<void>;
};

/** Close an owned file-backed database before removing it and SQLite sidecars. */
export async function cleanupFileDatabase(
  db: ClosableDatabase | undefined,
  path: string | undefined,
): Promise<void> {
  try {
    if (typeof db?.close === 'function') {
      await db.close();
    }
  } finally {
    if (path) {
      await Promise.all(
        [path, `${path}-journal`, `${path}-shm`, `${path}-wal`].map((file) =>
          rm(file, { force: true }),
        ),
      );
    }
  }
}

/** Close an owned directory-backed database before removing its data directory. */
export async function cleanupDirectoryDatabase(
  db: ClosableDatabase | undefined,
  path: string | undefined,
): Promise<void> {
  try {
    if (typeof db?.close === 'function') {
      await db.close();
    }
  } finally {
    if (path) {
      await rm(path, { recursive: true, force: true });
    }
  }
}
