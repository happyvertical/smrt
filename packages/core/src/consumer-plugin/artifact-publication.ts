import * as fs from 'node:fs';

export interface ArtifactFile {
  path: string;
  content: string;
}

export interface ArtifactFilesystem {
  existsSync: typeof fs.existsSync;
  renameSync: typeof fs.renameSync;
  statSync: typeof fs.statSync;
  unlinkSync: typeof fs.unlinkSync;
  writeFileSync: typeof fs.writeFileSync;
  chmodSync: typeof fs.chmodSync;
}

interface StagedArtifact {
  path: string;
  stagedPath: string;
  backupPath?: string;
}

/**
 * Stage and publish a related artifact set with synchronous-failure recovery.
 *
 * Every existing target is first renamed to an adjacent backup, preserving its
 * mode, before a staged replacement is renamed into place. If a later rename
 * fails, rollback restores backups using rename only; it never truncates an
 * old target by rewriting it. A rollback failure retains its backup for manual
 * recovery and is included with the original publication failure.
 *
 * There is no portable multi-file filesystem transaction: a process crash or a
 * concurrent reader between individual renames can still observe a mixed set.
 */
export function publishArtifactFiles(
  files: ArtifactFile[],
  filesystem: ArtifactFilesystem = fs,
): void {
  const unique = `${process.pid}-${Date.now()}`;
  const staged: StagedArtifact[] = [];
  const backed: StagedArtifact[] = [];
  const published: StagedArtifact[] = [];
  let retainBackups = false;

  try {
    for (const [index, file] of files.entries()) {
      const exists = filesystem.existsSync(file.path);
      const stats = exists ? filesystem.statSync(file.path) : undefined;
      if (stats && !stats.isFile()) {
        throw new Error(`Artifact target is not a file: ${file.path}`);
      }
      const mode = stats ? stats.mode & 0o777 : undefined;
      const stagedFile = {
        path: file.path,
        stagedPath: `${file.path}.smrt-${unique}-${index}.tmp`,
        backupPath: exists
          ? `${file.path}.smrt-${unique}-${index}.bak`
          : undefined,
      };
      // Register before the write: a failed write can still leave a partial
      // temporary file, which the finally cleanup must see.
      staged.push(stagedFile);
      filesystem.writeFileSync(stagedFile.stagedPath, file.content, 'utf-8');
      if (mode !== undefined) filesystem.chmodSync(stagedFile.stagedPath, mode);
    }
    for (const file of staged) {
      if (!file.backupPath) continue;
      filesystem.renameSync(file.path, file.backupPath);
      backed.push(file);
    }
    for (const file of staged) {
      filesystem.renameSync(file.stagedPath, file.path);
      published.push(file);
    }
  } catch (publicationError) {
    const rollbackErrors: unknown[] = [];
    for (const file of backed.reverse()) {
      try {
        if (!file.backupPath) {
          throw new Error(`Missing artifact backup: ${file.path}`);
        }
        // Replacing a published staged file is safe: its authoritative prior
        // contents are held by backupPath until this rename succeeds.
        filesystem.renameSync(file.backupPath, file.path);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    for (const file of published) {
      if (file.backupPath) continue;
      try {
        if (filesystem.existsSync(file.path)) filesystem.unlinkSync(file.path);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length > 0) {
      retainBackups = true;
      throw new AggregateError(
        [publicationError, ...rollbackErrors],
        'Artifact publication failed and rollback retained recovery backups',
      );
    }
    throw publicationError;
  } finally {
    for (const file of staged) {
      try {
        if (filesystem.existsSync(file.stagedPath))
          filesystem.unlinkSync(file.stagedPath);
      } catch {
        // A staging file is not an authoritative artifact.
      }
      if (!retainBackups) {
        try {
          if (file.backupPath && filesystem.existsSync(file.backupPath)) {
            filesystem.unlinkSync(file.backupPath);
          }
        } catch {
          // A failed cleanup leaves a recoverable backup behind.
        }
      }
    }
  }
}
