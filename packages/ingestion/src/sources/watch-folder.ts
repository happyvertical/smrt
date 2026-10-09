import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import {
  deliver,
  type SourceBinding,
  SourceInputError,
  type SourceResult,
  safeFailure,
} from './common.js';

export interface WatchFolderOptions {
  binding: SourceBinding;
  /** Private producer directory; claims and processed live on the same filesystem. */
  directory: string;
  stabilityMs: number;
  now?: () => number;
  /** Observability/crash injection. Never receives file content or credentials. */
  checkpoint?(boundary: 'claimed' | 'received', claimId: string): Promise<void>;
}
export interface WatchFolderResult {
  claimId?: string;
  filename: string;
  result: SourceResult;
}
interface Claim {
  id: string;
  filename: string;
  capturedAt: string;
  sourceId: string;
  sourceVersion: string;
}
interface Observation {
  fingerprint: string;
  since: number;
}
/** Files remain in claims until the durable receipt succeeds. A restart safely replays them. */
export class WatchFolderSourceAdapter {
  private readonly observations = new Map<string, Observation>();
  private polling = false;
  constructor(private readonly options: WatchFolderOptions) {
    if (!Number.isSafeInteger(options.stabilityMs) || options.stabilityMs < 1)
      throw new Error('Positive stability interval required');
  }
  private async stable(path: string): Promise<boolean> {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new SourceInputError('invalid');
    const fingerprint = [
      stat.dev,
      stat.ino,
      stat.size,
      stat.mtimeMs,
      stat.ctimeMs,
    ].join(':');
    const now = (this.options.now ?? Date.now)();
    const prior = this.observations.get(path);
    if (!prior || prior.fingerprint !== fingerprint) {
      this.observations.set(path, { fingerprint, since: now });
      return false;
    }
    return now - prior.since >= this.options.stabilityMs;
  }
  private async syncDirectory(path: string): Promise<void> {
    const directory = await open(path, constants.O_RDONLY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
  private async importClaim(
    directory: string,
    claim: Claim,
  ): Promise<WatchFolderResult | null> {
    const path = join(directory, 'original');
    try {
      if (!(await this.stable(path))) return null;
      const handle = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      let bytes: Buffer;
      try {
        const before = await handle.stat();
        if (before.size > this.options.binding.limits.maxBytes)
          throw new SourceInputError('limit');
        bytes = Buffer.alloc(before.size);
        let offset = 0;
        while (offset < bytes.length) {
          const { bytesRead } = await handle.read(
            bytes,
            offset,
            bytes.length - offset,
            offset,
          );
          if (!bytesRead) throw new SourceInputError('invalid');
          offset += bytesRead;
        }
        const after = await handle.stat();
        if (
          before.size !== after.size ||
          before.mtimeMs !== after.mtimeMs ||
          before.ctimeMs !== after.ctimeMs
        )
          throw new SourceInputError('invalid');
      } finally {
        await handle.close();
      }
      const mediaType = /\.pdf$/i.test(claim.filename)
        ? 'application/pdf'
        : 'image/tiff';
      const result = await deliver(
        this.options.binding,
        claim.id,
        new Date(claim.capturedAt),
        [
          {
            partId: 'original',
            mediaType,
            bytes,
            sourceReference: {
              owner: 'watch-folder',
              id: claim.filename,
              version: claim.id,
            },
          },
        ],
      );
      if (result.kind === 'accepted' || result.kind === 'duplicate') {
        await this.options.checkpoint?.('received', claim.id);
        await rename(
          directory,
          join(this.options.directory, '.ingestion-processed', claim.id),
        );
        await this.syncDirectory(
          join(this.options.directory, '.ingestion-processed'),
        );
        await this.syncDirectory(
          join(this.options.directory, '.ingestion-claims'),
        );
        this.observations.delete(path);
      } else
        await writeFile(
          join(directory, 'failure.json'),
          JSON.stringify(result),
          { mode: 0o600 },
        );
      return { claimId: claim.id, filename: claim.filename, result };
    } catch (error) {
      const result = safeFailure(error);
      // Error categories only; no raw transport paths, secrets or exception text.
      await writeFile(join(directory, 'failure.json'), JSON.stringify(result), {
        mode: 0o600,
      }).catch(() => {});
      return { claimId: claim.id, filename: claim.filename, result };
    }
  }
  async poll(): Promise<WatchFolderResult[]> {
    if (!this.options.binding.enabled || this.polling) return [];
    this.polling = true;
    const results: WatchFolderResult[] = [];
    try {
      const root = this.options.directory;
      const claims = join(root, '.ingestion-claims');
      const processed = join(root, '.ingestion-processed');
      // Only an explicitly configured, existing directory is touched.
      const rootStat = await lstat(root);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
        throw new SourceInputError('invalid');
      await mkdir(claims, { recursive: true, mode: 0o700 });
      await mkdir(processed, { recursive: true, mode: 0o700 });
      for (const privatePath of [claims, processed])
        if ((await lstat(privatePath)).isSymbolicLink())
          throw new SourceInputError('invalid');
      for (const entry of await readdir(claims, { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name))
          continue;
        const directory = join(claims, entry.name);
        try {
          const claim = JSON.parse(
            await readFile(join(directory, 'claim.json'), 'utf8'),
          ) as Claim;
          if (
            claim.id !== entry.name ||
            claim.sourceId !== this.options.binding.sourceId ||
            claim.sourceVersion !== this.options.binding.sourceVersion
          )
            throw new SourceInputError('invalid');
          // A crash before rename leaves an intent without original; producer file remains untouched.
          try {
            await lstat(join(directory, 'original'));
          } catch {
            continue;
          }
          const result = await this.importClaim(directory, claim);
          if (result) results.push(result);
        } catch (error) {
          results.push({
            claimId: entry.name,
            filename: '',
            result: safeFailure(error),
          });
        }
      }
      for (const entry of await readdir(root, { withFileTypes: true })) {
        if (!/\.(pdf|tiff?)$/i.test(entry.name)) continue;
        const path = join(root, entry.name);
        try {
          if (!(await this.stable(path))) continue;
          const stat = await lstat(path);
          const claim: Claim = {
            id: randomUUID(),
            filename: entry.name,
            capturedAt: new Date(stat.mtimeMs).toISOString(),
            sourceId: this.options.binding.sourceId,
            sourceVersion: this.options.binding.sourceVersion,
          };
          const directory = join(claims, claim.id);
          await mkdir(directory, { mode: 0o700 });
          const metadata = await open(
            join(directory, 'claim.json'),
            'wx',
            0o600,
          );
          try {
            await metadata.writeFile(JSON.stringify(claim));
            await metadata.sync();
          } finally {
            await metadata.close();
          }
          await this.syncDirectory(directory);
          await this.syncDirectory(claims);
          await rename(path, join(directory, 'original'));
          await this.syncDirectory(directory);
          await this.syncDirectory(root);
          this.observations.delete(path);
          await this.options.checkpoint?.('claimed', claim.id);
          // Re-observe after rename: a producer may still hold its writing descriptor.
          await this.stable(join(directory, 'original'));
        } catch (error) {
          results.push({ filename: entry.name, result: safeFailure(error) });
        }
      }
      return results;
    } finally {
      this.polling = false;
    }
  }
}
