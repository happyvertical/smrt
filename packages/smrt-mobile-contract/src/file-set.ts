import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Writes every `relPath → content` entry under `rootDir`. */
export function writeFileSet(
  rootDir: string,
  files: Map<string, string>,
): void {
  for (const [relPath, content] of files) {
    const absPath = join(rootDir, relPath);
    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, content);
  }
}

/**
 * Compares every entry against disk. Returns the list of missing/stale
 * relative paths (empty = fresh).
 */
export function verifyFileSet(
  rootDir: string,
  files: Map<string, string>,
): string[] {
  const stale: string[] = [];
  for (const [relPath, content] of files) {
    const absPath = join(rootDir, relPath);
    if (!existsSync(absPath) || readFileSync(absPath, 'utf8') !== content) {
      stale.push(relPath);
    }
  }
  return stale;
}
