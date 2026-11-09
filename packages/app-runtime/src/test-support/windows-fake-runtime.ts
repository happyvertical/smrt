/**
 * In-memory Windows machine for the custody tests. It implements
 * {@link WindowsCustodyRuntime}, so the Windows rule runs unchanged on any
 * host. Test-only: excluded from the published type declarations.
 *
 * The SDDL fixtures below were written from memory of the default Windows
 * ACLs and MUST be re-captured from a real machine (see the real-Windows test
 * file) before they are treated as ground truth.
 */

import type { BigIntStats } from 'node:fs';
import { win32 } from 'node:path';
import type { WindowsAclInspection } from '../windows-acl-inspector.js';
import type {
  WindowsCustodyRuntime,
  WindowsFileHandle,
} from '../windows-custody.js';
import { foldWindowsCase } from '../windows-paths.js';

export const USER_SID = 'S-1-5-21-111-222-333-1001';
export const OTHER_SID = 'S-1-5-21-111-222-333-1002';

/** Default DACLs, from memory of a stock Windows 11 install. */
export const SDDL = {
  /** `%LOCALAPPDATA%` and everything the user creates beneath it. */
  userPrivate: (user = USER_SID) =>
    `O:${user}G:${user}D:PAI(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)(A;OICIID;FA;;;${user})`,
  /** Owner `BUILTIN\Administrators`, as an elevated admin creates objects. */
  adminOwned: (user = USER_SID) =>
    `O:BAG:SYD:PAI(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)(A;OICIID;FA;;;${user})`,
  /** What `icacls /inheritance:r /grant:r` of the three SIDs leaves behind. */
  locked: (user = USER_SID) =>
    `O:${user}G:${user}D:P(A;OICI;FA;;;${user})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)`,
  /** `C:\` itself. */
  driveRoot:
    'O:SYG:SYD:PAI(A;OICIIO;SDGXGWGR;;;AU)(A;;0x1200a9;;;BU)(A;OICIIO;GXGR;;;BU)(A;;FA;;;SY)(A;OICIIO;GA;;;SY)(A;;FA;;;BA)(A;OICIIO;GA;;;BA)(A;;LC;;;AU)(A;;DC;;;AU)',
  /** What a directory created directly under `C:\` inherits. */
  driveRootChild: (user = USER_SID) =>
    `O:${user}G:${user}D:AI(A;OICIID;0x1301bf;;;AU)(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)(A;OICIID;0x1200a9;;;BU)`,
  /** `C:\Users`. */
  users:
    'O:SYG:SYD:PAI(A;;0x1200a9;;;BU)(A;OICIIO;GXGR;;;BU)(A;;FA;;;SY)(A;OICIIO;GA;;;SY)(A;;FA;;;BA)(A;OICIIO;GA;;;BA)(A;;0x1200a9;;;WD)(A;OICIIO;GXGR;;;WD)',
  /** A tree anyone may read (the source checkout). */
  readable:
    'O:BAG:SYD:PAI(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)(A;OICIID;0x1200a9;;;BU)',
} as const;

const NTFS = { driveFormat: 'NTFS', driveType: 3 } as const;

export interface FakeNode {
  kind: 'dir' | 'file' | 'symlink';
  /** True-case canonical path. */
  path: string;
  ino: bigint;
  birthtimeNs: bigint;
  nlink: bigint;
  size: bigint;
  sddl: string;
  attributes: number;
  /** DACL a child created in this directory inherits. */
  childSddl: string;
  /** What native `realpath` returns when it is not the path itself. */
  realpath?: string;
  /** Identity an opened handle reports when it differs from `lstat`. */
  handleIno?: bigint;
  content?: string;
}

export interface FakeVolume {
  driveFormat: string;
  driveType: number;
}

function enoent(path: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(`ENOENT: ${path}`);
  error.code = 'ENOENT';
  return error;
}

function eexist(path: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(`EEXIST: ${path}`);
  error.code = 'EEXIST';
  return error;
}

export class FakeWindowsMachine {
  readonly nodes = new Map<string, FakeNode>();
  readonly volumes = new Map<string, FakeVolume>();
  readonly operations: string[] = [];
  readonly inspections: string[][] = [];
  /** Every `lockDirectory` call, kept apart from `operations`. */
  readonly locks: Array<{ path: string; userSid: string }> = [];
  /**
   * `record` (default) only records a lock, leaving the inherited DACL in
   * place; `apply` replaces it the way icacls does (protected, three entries).
   */
  lockMode: 'record' | 'apply' = 'record';
  /** Makes `lockDirectory` throw. */
  lockFailure: Error | undefined;
  userSid = USER_SID;
  env: NodeJS.ProcessEnv = {
    SystemRoot: 'C:\\Windows',
    LOCALAPPDATA: 'C:\\Users\\Will\\AppData\\Local',
  };
  /** Runs inside `inspectAcl`, after the answer is computed. */
  duringInspection: (() => void) | undefined;
  /** Replace the inspector's answer (to model a lying or failing inspector). */
  inspectOverride:
    | ((paths: readonly string[]) => WindowsAclInspection)
    | undefined;
  private nextIno = 0x0001_0000_0000_0010n;

  private key(path: string): string {
    return foldWindowsCase(path.replace(/\\$/, ''));
  }

  add(
    path: string,
    kind: FakeNode['kind'],
    sddl: string,
    options: Partial<FakeNode> = {},
  ): FakeNode {
    const node: FakeNode = {
      kind,
      path,
      ino: this.nextIno,
      birthtimeNs: 1_700_000_000_000_000_000n,
      nlink: 1n,
      size: 0n,
      sddl,
      attributes: kind === 'dir' ? 0x10 : 0x20,
      childSddl: sddl,
      ...options,
    };
    this.nextIno += 1n;
    this.nodes.set(this.key(path), node);
    return node;
  }

  dir(path: string, sddl: string, options: Partial<FakeNode> = {}): FakeNode {
    return this.add(path, 'dir', sddl, options);
  }

  file(path: string, sddl: string, options: Partial<FakeNode> = {}): FakeNode {
    return this.add(path, 'file', sddl, options);
  }

  node(path: string): FakeNode | undefined {
    return this.nodes.get(this.key(path));
  }

  /** The node at `path`; throws when the test arranged none. */
  at(path: string): FakeNode {
    const node = this.node(path);
    if (!node) throw new Error(`No fake node at ${path}`);
    return node;
  }

  /** `C:\`, `C:\Users`, the user's profile, `AppData\Local`, and a source tree. */
  static standard(): FakeWindowsMachine {
    const machine = new FakeWindowsMachine();
    machine.dir('C:\\', SDDL.driveRoot, { childSddl: SDDL.driveRootChild() });
    machine.dir('C:\\Users', SDDL.users, { childSddl: SDDL.userPrivate() });
    for (const path of [
      'C:\\Users\\Will',
      'C:\\Users\\Will\\AppData',
      'C:\\Users\\Will\\AppData\\Local',
    ]) {
      machine.dir(path, SDDL.userPrivate());
    }
    machine.dir('C:\\work', SDDL.readable);
    machine.dir('C:\\work\\app', SDDL.readable);
    return machine;
  }

  private statsOf(node: FakeNode, ino = node.ino): BigIntStats {
    return {
      dev: 7n,
      ino,
      nlink: node.nlink,
      size: node.size,
      birthtimeNs: node.birthtimeNs,
      isDirectory: () => node.kind === 'dir',
      isFile: () => node.kind === 'file',
      isSymbolicLink: () => node.kind === 'symlink',
    } as unknown as BigIntStats;
  }

  runtime(): WindowsCustodyRuntime {
    const find = (path: string): FakeNode => {
      const node = this.node(path);
      if (!node) throw enoent(path);
      return node;
    };
    const parentOf = (path: string): FakeNode => find(win32.dirname(path));
    return {
      env: this.env,
      lstat: (path) => this.statsOf(find(path)),
      realpath: (path) => {
        const node = find(path);
        return node.realpath ?? node.path;
      },
      mkdir: (path) => {
        this.operations.push(`mkdir ${path}`);
        if (this.node(path)) throw eexist(path);
        const parent = parentOf(path);
        this.add(path, 'dir', parent.childSddl, {
          childSddl: parent.childSddl,
        });
      },
      lockDirectory: (path, userSid) => {
        this.locks.push({ path, userSid });
        if (this.lockFailure) throw this.lockFailure;
        if (this.lockMode === 'apply') {
          const node = find(path);
          node.sddl = SDDL.locked(userSid);
          node.childSddl = SDDL.locked(userSid);
        }
      },
      rmdir: (path) => {
        this.operations.push(`rmdir ${path}`);
        const node = find(path);
        const prefix = `${this.key(path)}\\`;
        for (const key of this.nodes.keys()) {
          if (key.startsWith(prefix)) {
            const error: NodeJS.ErrnoException = new Error('ENOTEMPTY');
            error.code = 'ENOTEMPTY';
            throw error;
          }
        }
        this.nodes.delete(this.key(node.path));
      },
      unlink: (path) => {
        this.operations.push(`unlink ${path}`);
        find(path);
        this.nodes.delete(this.key(path));
      },
      readdir: (path) => {
        find(path);
        const parent = this.key(path);
        return [...this.nodes.values()]
          .filter(
            (node) =>
              node.path.length > 3 &&
              this.key(win32.dirname(node.path)) === parent,
          )
          .map((node) => win32.basename(node.path));
      },
      openFile: (path, mode): WindowsFileHandle => {
        if (mode === 'create') {
          this.operations.push(`create ${path}`);
          if (this.node(path)) throw eexist(path);
          const parent = parentOf(path);
          this.add(path, 'file', parent.childSddl);
        }
        const node = find(path);
        return {
          stat: () => this.statsOf(node, node.handleIno ?? node.ino),
          readUtf8: () => node.content ?? '',
          close: () => undefined,
        };
      },
      inspectAcl: (paths) => {
        this.inspections.push([...paths]);
        if (this.inspectOverride) return this.inspectOverride(paths);
        const records = paths.map((path) => {
          const node = find(path);
          const volume = this.volumes.get(path[0].toUpperCase()) ?? NTFS;
          return {
            sddl: node.sddl,
            attributes: node.attributes,
            driveFormat: volume.driveFormat,
            driveType: volume.driveType,
          };
        });
        this.duringInspection?.();
        return { userSid: this.userSid, records };
      },
    };
  }

  /** Paths of every created entry that still exists, for rollback assertions. */
  exists(path: string): boolean {
    return this.node(path) !== undefined;
  }
}
