import { constants } from 'node:fs';
import type {
  DesktopFs,
  FileHandleLike,
  StatsLike,
} from '../internal/fs-seam.js';

/**
 * In-memory `DesktopFs` for tests. Not part of the published API. Models just
 * enough of a filesystem to exercise ownership, mode, symlink and ordering
 * rules, including Windows-style paths that no POSIX host can create.
 */

export interface MemoryNode {
  kind: 'file' | 'dir' | 'symlink';
  uid: number;
  mode: number;
  content: Uint8Array;
}

function errno(code: string): Error {
  return Object.assign(new Error(code), { code });
}

function stats(node: MemoryNode): StatsLike {
  return {
    isFile: () => node.kind === 'file',
    isDirectory: () => node.kind === 'dir',
    isSymbolicLink: () => node.kind === 'symlink',
    uid: node.uid,
    mode: node.mode,
    size: node.content.length,
  };
}

export class MemoryFs implements DesktopFs {
  readonly nodes = new Map<string, MemoryNode>();
  /** Chronological operation log: `open:<path>`, `sync`, `rename:a>b`, ... */
  readonly log: string[] = [];
  /** Paths whose `realpath` differs from the path itself. */
  readonly realpaths = new Map<string, string>();
  failNextWriteWith: string | undefined;

  set(
    path: string,
    kind: MemoryNode['kind'],
    options: { uid?: number; mode?: number; content?: string } = {},
  ): this {
    this.nodes.set(path, {
      kind,
      uid: options.uid ?? 1000,
      mode:
        options.mode ??
        (kind === 'dir' ? 0o755 : kind === 'symlink' ? 0o777 : 0o644),
      content: new TextEncoder().encode(options.content ?? ''),
    });
    return this;
  }

  text(path: string): string | undefined {
    const node = this.nodes.get(path);
    return node ? new TextDecoder().decode(node.content) : undefined;
  }

  async lstat(path: string): Promise<StatsLike> {
    const node = this.nodes.get(path);
    if (!node) throw errno('ENOENT');
    return stats(node);
  }

  async realpath(path: string): Promise<string> {
    if (!this.nodes.has(path)) throw errno('ENOENT');
    return this.realpaths.get(path) ?? path;
  }

  async rename(from: string, to: string): Promise<void> {
    const node = this.nodes.get(from);
    if (!node) throw errno('ENOENT');
    this.nodes.delete(from);
    this.nodes.set(to, node);
    this.log.push(`rename:${from}>${to}`);
  }

  async unlink(path: string): Promise<void> {
    if (!this.nodes.delete(path)) throw errno('ENOENT');
    this.log.push(`unlink:${path}`);
  }

  async open(
    path: string,
    flags: number,
    mode?: number,
  ): Promise<FileHandleLike> {
    let node = this.nodes.get(path);
    const create = (flags & constants.O_CREAT) !== 0;
    if (node && create && (flags & constants.O_EXCL) !== 0) {
      throw errno('EEXIST');
    }
    if (
      node?.kind === 'symlink' &&
      (flags & (constants.O_NOFOLLOW ?? 0)) !== 0
    ) {
      throw errno('ELOOP');
    }
    if (!node) {
      if (!create) throw errno('ENOENT');
      this.set(path, 'file', { mode: (mode ?? 0o666) & ~0o022 });
      node = this.nodes.get(path) as MemoryNode;
    }
    const target = node;
    this.log.push(`open:${path}`);
    let position = 0;
    return {
      stat: async () => stats(target),
      read: async (buffer, offset, length) => {
        const slice = target.content.subarray(position, position + length);
        buffer.set(slice, offset);
        position += slice.length;
        return { bytesRead: slice.length };
      },
      write: async (data, offset, length) => {
        if (this.failNextWriteWith) {
          const code = this.failNextWriteWith;
          this.failNextWriteWith = undefined;
          throw errno(code);
        }
        const chunk = data.subarray(offset, offset + length);
        const next = new Uint8Array(target.content.length + chunk.length);
        next.set(target.content);
        next.set(chunk, target.content.length);
        target.content = next;
        return { bytesWritten: chunk.length };
      },
      sync: async () => {
        this.log.push('sync');
      },
      close: async () => undefined,
    };
  }
}
