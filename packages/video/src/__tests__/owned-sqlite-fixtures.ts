import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type Closable = { close?: () => void | Promise<void> };

/** Keeps each video test module's file-backed SQLite fixtures explicitly owned. */
export function createOwnedSqliteFixtures() {
  const files = new Set<string>();
  const databases = new Set<Closable>();

  return {
    url(name: string): string {
      const file = join(tmpdir(), `${name}-${randomUUID()}.db`);
      files.add(file);
      return `file:${file}`;
    },
    track<T extends Closable>(database: T): T {
      databases.add(database);
      return database;
    },
    async cleanup(): Promise<void> {
      const closeResults = await Promise.allSettled(
        [...databases].map((database) => database.close?.()),
      );
      databases.clear();
      const removeResults = await Promise.allSettled(
        [...files].flatMap((file) =>
          [file, `${file}-wal`, `${file}-shm`, `${file}-journal`].map((path) =>
            rm(path, { force: true }),
          ),
        ),
      );
      files.clear();
      const failures = [...closeResults, ...removeResults]
        .filter(
          (result): result is PromiseRejectedResult =>
            result.status === 'rejected',
        )
        .map((result) => result.reason);
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          'Failed to clean owned SQLite fixtures',
        );
      }
    },
  };
}
