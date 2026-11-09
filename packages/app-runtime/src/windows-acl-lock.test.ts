/**
 * The runtime locks the directories it creates on Windows (smrt#4843),
 * exercised on any host through the injected `lockDirectory` seam and an
 * injected `exec` for the icacls invocation itself.
 */

import { describe, expect, it } from 'vitest';
import {
  FakeWindowsMachine,
  OTHER_SID,
  SDDL,
  USER_SID,
} from './test-support/windows-fake-runtime.js';
import type { InspectorExec } from './windows-acl-inspector.js';
import {
  buildIcaclsLockArgv,
  createIcaclsDirectoryLocker,
  icaclsExecutable,
} from './windows-acl-lock.js';
import { preparePrivateWindowsTree } from './windows-custody.js';

const LOCAL = 'C:\\Users\\Will\\AppData\\Local';
const ROOT = `${LOCAL}\\MyApp`;
/** The third-party group the profile's AppData\Local inherits (smrt#4843). */
const GROUP_SID = 'S-1-5-21-111-222-333-1003';
const INHERITED_GROUP = `D:AI(A;OICIID;0x1200a9;;;${GROUP_SID})(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)(A;OICIID;FA;;;${USER_SID})`;

function profileWithInheritedGroup(): FakeWindowsMachine {
  const machine = FakeWindowsMachine.standard();
  const sddl = `O:${USER_SID}G:${USER_SID}${INHERITED_GROUP}`;
  machine.at(LOCAL).childSddl = sddl;
  return machine;
}

describe('a created directory is locked (smrt#4843)', () => {
  it('locks the new leaf, passes custody, and writes nothing before the lock', () => {
    const machine = profileWithInheritedGroup();
    machine.lockMode = 'apply';
    const result = preparePrivateWindowsTree(machine.runtime(), {
      directory: ROOT,
      file: { path: `${ROOT}\\.marker` },
    });
    expect(result.createdDirectories).toEqual([ROOT]);
    expect(machine.locks).toEqual([{ path: ROOT, userSid: USER_SID }]);
    // create, lock, then write.
    expect(machine.operations).toEqual([
      `mkdir ${ROOT}`,
      `create ${ROOT}\\.marker`,
    ]);
    expect(machine.at(ROOT).sddl).toBe(SDDL.locked());
  });

  it('is refused without the lock: the inherited group reaches the new directory', () => {
    const machine = profileWithInheritedGroup();
    machine.lockMode = 'record';
    expect(() =>
      preparePrivateWindowsTree(machine.runtime(), { directory: ROOT }),
    ).toThrow(new RegExp(`access is granted to ${GROUP_SID}`));
    expect(machine.exists(ROOT)).toBe(false);
  });

  it('locks every directory it creates, ancestors included, but nothing that already existed', () => {
    const machine = FakeWindowsMachine.standard();
    machine.lockMode = 'apply';
    preparePrivateWindowsTree(machine.runtime(), {
      directory: `${LOCAL}\\Vendor\\App`,
    });
    expect(machine.locks.map((lock) => lock.path)).toEqual([
      `${LOCAL}\\Vendor`,
      `${LOCAL}\\Vendor\\App`,
    ]);
    // The directory that already existed (LOCAL) is never locked.
    expect(machine.locks.map((lock) => lock.path)).not.toContain(LOCAL);
  });

  it('never touches a directory that already exists', () => {
    const machine = FakeWindowsMachine.standard();
    machine.dir(ROOT, SDDL.locked());
    machine.lockMode = 'apply';
    const before = machine.at(ROOT).sddl;
    const result = preparePrivateWindowsTree(machine.runtime(), {
      directory: ROOT,
    });
    expect(result.createdDirectories).toEqual([]);
    expect(machine.locks).toEqual([]);
    expect(machine.operations).toEqual([]);
    expect(machine.at(ROOT).sddl).toBe(before);
  });

  it('does not lock a directory another process created first', () => {
    const machine = FakeWindowsMachine.standard();
    const rt = machine.runtime();
    const racing = {
      ...rt,
      mkdir: (path: string) => {
        machine.dir(path, SDDL.locked());
        throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
      },
    };
    preparePrivateWindowsTree(racing, { directory: ROOT });
    expect(machine.locks).toEqual([]);
    expect(machine.exists(ROOT)).toBe(true);
  });

  it('removes the new directory and errors when locking fails', () => {
    const machine = profileWithInheritedGroup();
    machine.lockFailure = new Error('icacls exited with 5');
    expect(() =>
      preparePrivateWindowsTree(machine.runtime(), {
        directory: ROOT,
        file: { path: `${ROOT}\\.marker` },
      }),
    ).toThrow(/Could not restrict the new directory/);
    expect(machine.exists(ROOT)).toBe(false);
    expect(machine.operations).toEqual([`mkdir ${ROOT}`, `rmdir ${ROOT}`]);
  });

  it('surfaces a LocalRuntimeError from the locker unchanged', () => {
    const machine = FakeWindowsMachine.standard();
    machine.lockFailure = Object.assign(new Error('x'), { code: 'EPERM' });
    let thrown: unknown;
    try {
      preparePrivateWindowsTree(machine.runtime(), { directory: ROOT });
    } catch (error) {
      thrown = error;
    }
    expect((thrown as Error).name).toBe('LocalRuntimeError');
    expect(machine.exists(ROOT)).toBe(false);
  });

  it('removes the new directory when verification fails after locking', () => {
    const machine = FakeWindowsMachine.standard();
    // The lock "succeeds" but the directory still admits another principal.
    machine.lockMode = 'record';
    machine.at(LOCAL).childSddl =
      `O:${USER_SID}G:${USER_SID}D:P(A;OICI;FA;;;${USER_SID})(A;OICI;FA;;;${OTHER_SID})`;
    expect(() =>
      preparePrivateWindowsTree(machine.runtime(), { directory: ROOT }),
    ).toThrow(new RegExp(`access is granted to ${OTHER_SID}`));
    expect(machine.locks).toHaveLength(1);
    expect(machine.exists(ROOT)).toBe(false);
  });

  it('refuses a directory swapped for a link before it is locked', () => {
    const machine = FakeWindowsMachine.standard();
    const rt = machine.runtime();
    const swapped = {
      ...rt,
      mkdir: (path: string) => {
        rt.mkdir(path);
        machine.at(path).kind = 'symlink';
      },
    };
    expect(() =>
      preparePrivateWindowsTree(swapped, { directory: ROOT }),
    ).toThrow(/changed while it was being created/);
    expect(machine.locks).toEqual([]);
  });

  it('refuses a directory swapped while it is being locked', () => {
    const machine = FakeWindowsMachine.standard();
    const rt = machine.runtime();
    const swapped = {
      ...rt,
      lockDirectory: (path: string, userSid: string) => {
        rt.lockDirectory(path, userSid);
        machine.at(path).ino += 1n;
      },
    };
    expect(() =>
      preparePrivateWindowsTree(swapped, { directory: ROOT }),
    ).toThrow(/changed while it was being locked/);
    expect(machine.exists(ROOT)).toBe(false);
  });
});

describe('a pre-existing directory that fails the rule is refused by name', () => {
  it('names the extra SID and how to fix it, and is left untouched', () => {
    const machine = FakeWindowsMachine.standard();
    machine.dir(ROOT, `O:${USER_SID}G:${USER_SID}${INHERITED_GROUP}`);
    machine.lockMode = 'apply';
    let message = '';
    try {
      preparePrivateWindowsTree(machine.runtime(), { directory: ROOT });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain(ROOT);
    expect(message).toContain(`access is granted to ${GROUP_SID}`);
    expect(message).toMatch(/never changes the permissions/);
    expect(message).toMatch(/Move the data directory/);
    expect(message).toMatch(/remove that access/);
    expect(machine.locks).toEqual([]);
    expect(machine.operations).toEqual([]);
    expect(machine.at(ROOT).sddl).toContain(GROUP_SID);
  });

  it('adds the well-known name next to a well-known group', () => {
    const machine = FakeWindowsMachine.standard();
    machine.dir(ROOT, `O:${USER_SID}G:${USER_SID}D:P(A;OICI;0x1200a9;;;BU)`);
    expect(() =>
      preparePrivateWindowsTree(machine.runtime(), { directory: ROOT }),
    ).toThrow(/access is granted to ALIAS:BU \(BUILTIN\\Users\)/);
  });
});

describe('icacls invocation (no injection through the path)', () => {
  const hostile = [
    "C:\\a'; calc #\\b",
    'C:\\$(calc)\\x',
    'C:\\a&b\\x',
    'C:\\a^b\\%PATH%\\x',
    'C:\\a;b\\(x)\\[y]\\{z}',
    'C:\\`n\\x',
    'C:\\caf\u00e9 \u2603\\x',
    'C:\\a b\\-flag\\x',
  ];

  function capture() {
    const calls: Array<{
      file: string;
      args: readonly string[];
      options: Parameters<InspectorExec>[2];
    }> = [];
    const exec: InspectorExec = (file, args, options) => {
      calls.push({ file, args, options });
      return '';
    };
    return { calls, exec };
  }

  const env = {
    SystemRoot: 'C:\\Windows',
    PATHEXT: '.COM;.EXE',
    PATH: 'C:\\evil',
    SECRET: 'x',
  };

  it('runs the exact fixed argv by absolute path with no shell', () => {
    const { calls, exec } = capture();
    createIcaclsDirectoryLocker({ exec, env })(ROOT, USER_SID);
    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe('C:\\Windows\\System32\\icacls.exe');
    expect([...calls[0].args]).toEqual([
      ROOT,
      '/inheritance:r',
      '/grant:r',
      `*${USER_SID}:(OI)(CI)F`,
      '*S-1-5-18:(OI)(CI)F',
      '*S-1-5-32-544:(OI)(CI)F',
    ]);
    expect(calls[0].options.shell).toBe(false);
    expect(calls[0].options.windowsHide).toBe(true);
    expect(calls[0].options.timeout).toBeLessThanOrEqual(30_000);
    expect(calls[0].options.maxBuffer).toBeLessThanOrEqual(1024 * 1024);
    expect(calls[0].options.stdio).toEqual(['ignore', 'pipe', 'pipe']);
  });

  it('passes a minimal allow-listed environment without PATH', () => {
    const { calls, exec } = capture();
    createIcaclsDirectoryLocker({ exec, env })(ROOT, USER_SID);
    const passed = calls[0].options.env as Record<string, string>;
    expect(passed.SystemRoot).toBe('C:\\Windows');
    expect(passed.PATHEXT).toBe('.COM;.EXE');
    expect(Object.keys(passed).map((key) => key.toLowerCase())).not.toContain(
      'path',
    );
    expect(passed.SECRET).toBeUndefined();
  });

  it('keeps a hostile path as exactly one argv element, verbatim', () => {
    for (const path of hostile) {
      const { calls, exec } = capture();
      createIcaclsDirectoryLocker({ exec, env })(path, USER_SID);
      const args = calls[0].args;
      expect(args).toHaveLength(6);
      expect(args[0]).toBe(path);
      expect(args.slice(1).join(' ')).not.toContain(path);
      for (const arg of args.slice(1)) expect(arg).not.toContain('\\');
    }
  });

  it('refuses wildcards, non-SID users and non-canonical paths without running', () => {
    const { calls, exec } = capture();
    const lock = createIcaclsDirectoryLocker({ exec, env });
    expect(() => lock('C:\\a*\\b', USER_SID)).toThrow();
    expect(() => lock('C:\\a?\\b', USER_SID)).toThrow();
    expect(() => lock('C:\\a\\..\\b', USER_SID)).toThrow();
    expect(() => lock('\\\\?\\C:\\a', USER_SID)).toThrow();
    expect(() => lock('relative\\a', USER_SID)).toThrow();
    expect(() => lock('C:\\a & del C:\\x\\y', USER_SID)).toThrow();
    expect(() => lock(ROOT, 'Everyone')).toThrow(/not a SID/);
    expect(() => lock(ROOT, `${USER_SID} /deny`)).toThrow(/not a SID/);
    expect(calls).toEqual([]);
  });

  it('treats a non-zero exit, a timeout and a missing binary as failure', () => {
    for (const code of ['EPERM', 'ETIMEDOUT', 'ENOENT', 'ENOBUFS']) {
      const exec: InspectorExec = () => {
        throw Object.assign(new Error('failed'), { code, status: 5 });
      };
      expect(() =>
        createIcaclsDirectoryLocker({ exec, env })(ROOT, USER_SID),
      ).toThrow(/Could not restrict the new directory/);
    }
  });

  it('refuses when SystemRoot is missing or hostile', () => {
    const { calls, exec } = capture();
    expect(() =>
      createIcaclsDirectoryLocker({ exec, env: {} })(ROOT, USER_SID),
    ).toThrow(/SystemRoot/);
    expect(() => icaclsExecutable({ SystemRoot: '..\\evil' })).toThrow();
    expect(calls).toEqual([]);
  });

  it('builds the argv without interpolating the path into any other element', () => {
    const argv = buildIcaclsLockArgv(ROOT, USER_SID);
    expect(argv.filter((arg) => arg.includes('MyApp'))).toEqual([ROOT]);
  });
});
