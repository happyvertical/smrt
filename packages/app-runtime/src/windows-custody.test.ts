/**
 * Windows custody rule (smrt#4837), exercised on any host.
 *
 * Every test drives the real Windows rule through an in-memory machine
 * (`test-support/windows-fake-runtime.ts`) injected with
 * `runWithCustodyContext`, so nothing here needs Windows. Each threat in the
 * README table is closed by a test named after it; the real-Windows
 * counterparts live in `windows-custody.win32.test.ts`.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { resolveApplicationRuntime } from '@happyvertical/smrt-config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runWithCustodyContext } from './custody-context.js';
import {
  initializeLocalApplicationRuntime,
  LocalRuntimeError,
  openLocalMcpTokenStore,
  prepareApplicationStateRoot,
  prepareLocalDatabaseStorage,
  resolveApplicationStateRoot,
  resolveLocalRuntimePaths,
  validateLocalDatabaseStorage,
} from './index.js';
import {
  acquireInitializationLock,
  acquireLocalDatabase,
  ensureApplicationSecret,
  preflightLocalApplicationRoot,
  prepareLocalFilesystem,
  validateApplicationSecret,
  windowsSecureFileCustody,
} from './local-custody.js';
import { composeSmrtSvelteKitRuntime } from './sveltekit/runtime.js';
import {
  FakeWindowsMachine,
  OTHER_SID,
  SDDL,
  USER_SID,
} from './test-support/windows-fake-runtime.js';
import {
  buildInspectorEnvironment,
  createPowerShellAclInspector,
  type InspectorExec,
  POWERSHELL_INSPECTOR_ARGV,
  POWERSHELL_INSPECTOR_SCRIPT,
  parseInspectorOutput,
} from './windows-acl-inspector.js';
import {
  createWindowsDatabaseVerifier,
  preparePrivateWindowsTree,
  verifyWindowsFile,
  windowsCanonicalIdentity,
} from './windows-custody.js';
import {
  isWindowsReservedName,
  validateWindowsApplicationId,
  validateWindowsPath,
  windowsPathComponents,
} from './windows-paths.js';
import { assertWindowsSecurityPolicy, parseSddl } from './windows-sddl.js';

const sqlMock = vi.hoisted(() => ({
  getDatabase: undefined as unknown as ReturnType<typeof vi.fn>,
}));

vi.mock('@happyvertical/sql', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@happyvertical/sql')>();
  const { vi: vitest } = await import('vitest');
  sqlMock.getDatabase = vitest.fn();
  return {
    ...actual,
    getDatabase: (...args: unknown[]) => sqlMock.getDatabase(...args),
  };
});

const workers = vi.hoisted(() => ({
  created: [] as Array<{
    path: string;
    custodyRoot: string;
    lockOnly: boolean;
  }>,
}));

vi.mock('node:worker_threads', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:worker_threads')>();
  const { EventEmitter: Emitter } = await import('node:events');
  class FakeWorker extends Emitter {
    constructor(
      _code: string,
      options: { workerData: (typeof workers.created)[number] },
    ) {
      super();
      workers.created.push(options.workerData);
      queueMicrotask(() => this.emit('message', { type: 'acquired' }));
    }
    postMessage(message: { type?: string }) {
      if (message?.type === 'release') {
        queueMicrotask(() => this.emit('message', { type: 'released' }));
      }
    }
    terminate() {
      return Promise.resolve(0);
    }
  }
  return { ...actual, Worker: FakeWorker };
});

const LOCAL = 'C:\\Users\\Will\\AppData\\Local';
const ROOT = `${LOCAL}\\MyApp`;
const SOURCE = 'C:\\work\\app';
const ENV = { LOCALAPPDATA: LOCAL, SystemRoot: 'C:\\Windows' };

function onWindows<T>(machine: FakeWindowsMachine, action: () => T): T {
  return runWithCustodyContext(
    { platform: 'win32', windows: machine.runtime() },
    action,
  );
}

function windowsOptions(extra: Record<string, unknown> = {}) {
  return {
    appId: 'myapp',
    dataDirectory: ROOT,
    sourceRoot: SOURCE,
    platform: 'win32' as const,
    homeDirectory: 'C:\\Users\\Will',
    env: ENV,
    ...extra,
  };
}

function policy(
  role: 'custodied' | 'ancestor',
  sddl: string,
  user: string = USER_SID,
) {
  return () =>
    assertWindowsSecurityPolicy(parseSddl(sddl), role, user, 'C:\\p');
}

afterEach(() => {
  workers.created.length = 0;
  sqlMock.getDatabase.mockReset();
  vi.restoreAllMocks();
});

describe('W1 lexical rule (WT5: aliases, devices, streams)', () => {
  it.each([
    ['UNC', '\\\\server\\share\\x'],
    ['WSL', '\\\\wsl$\\Ubuntu\\x'],
    ['WSL localhost', '\\\\wsl.localhost\\Ubuntu\\x'],
    ['extended-length prefix', '\\\\?\\C:\\x'],
    ['device prefix', '\\\\.\\C:\\x'],
    ['forward-slash extended prefix', '//?/C:/x'],
    ['forward-slash UNC', '//server/share/x'],
    ['NT object prefix', '\\??\\C:\\x'],
    ['drive-relative', 'C:x'],
    ['bare drive', 'C:'],
    ['rooted without a drive', '\\x'],
    ['relative', 'x\\y'],
    ['empty', ''],
  ])('refuses the %s form', (_name, path) => {
    expect(() => validateWindowsPath(path, 'p')).toThrow(LocalRuntimeError);
  });

  it.each([
    'C:\\a\\b:ads',
    'C:\\a\\b::$DATA',
    'C:\\a\\b::$INDEX_ALLOCATION',
    'C:\\a:b\\c',
  ])('refuses the alternate data stream %s', (path) => {
    expect(() => validateWindowsPath(path, 'p')).toThrow(/reserved or control/);
  });

  it.each([
    'C:\\a.\\b',
    'C:\\a \\b',
    'C:\\a\\b.',
    'C:\\a\\b ',
  ])('refuses the trailing dot or space in %s', (path) => {
    expect(() => validateWindowsPath(path, 'p')).toThrow(/trailing dot/);
  });

  it.each([
    'C:\\con',
    'C:\\CON',
    'C:\\a\\nul.txt',
    'C:\\a\\aux.tar.gz',
    'C:\\prn',
    'C:\\com1',
    'C:\\COM9.log',
    'C:\\lpt0',
    'C:\\COM\u00B9',
    'C:\\LPT\u00B2',
    'C:\\COM\u00B3.txt',
    'C:\\CONIN$',
    'C:\\conout$.txt',
    'C:\\con .txt',
  ])('refuses the device name in %s', (path) => {
    expect(() => validateWindowsPath(path, 'p')).toThrow(/device name/);
  });

  it.each([
    'C:\\a\\..\\b',
    'C:\\a\\.\\b',
    'C:\\a\\\\b',
    'C:\\a\\b\u0000',
    'C:\\a\\b\nc',
    'C:\\a\\<b>',
    'C:\\a\\b|c',
    'C:\\a\\b?',
    'C:\\a\\b*',
    'C:\\a\\"b"',
    'C:\\a\\\ud800',
  ])('refuses the unsafe component in %j', (path) => {
    expect(() => validateWindowsPath(path, 'p')).toThrow(LocalRuntimeError);
  });

  it('refuses a path whose derived children would exceed the length cap', () => {
    const near = `C:\\${'a'.repeat(150)}`;
    expect(validateWindowsPath(near, 'p')).toBe(near);
    expect(() => validateWindowsPath(near, 'p', 110)).toThrow(/longer than/);
    expect(() => validateWindowsPath(`C:\\${'a'.repeat(250)}`, 'p')).toThrow(
      /longer than/,
    );
  });

  it('accepts and canonicalises a plain path', () => {
    expect(
      validateWindowsPath('c:/Users/Will/AppData/Local/My.App/', 'p'),
    ).toBe('C:\\Users\\Will\\AppData\\Local\\My.App');
    expect(validateWindowsPath('d:\\', 'p')).toBe('D:\\');
    expect(validateWindowsPath('C:\\.smrt-lease-0a\\x', 'p')).toBe(
      'C:\\.smrt-lease-0a\\x',
    );
  });

  it('flags every device spelling Windows reserves', () => {
    for (const name of ['CON', 'nul.txt', 'Com3', 'LPT\u00B3.x', 'CONIN$']) {
      expect(isWindowsReservedName(name)).toBe(true);
    }
    for (const name of ['console', 'comx', 'aux1', 'lpt', 'a.con', 'COM10']) {
      expect(isWindowsReservedName(name)).toBe(false);
    }
  });
});

describe('appId against Windows device names (WT5)', () => {
  it.each([
    'con',
    'nul',
    'com1',
    'aux',
    'prn',
    'lpt9',
    'con.app',
    'foo.',
  ])('refuses appId %j on win32 and keeps it valid elsewhere', (appId) => {
    expect(() => validateWindowsApplicationId(appId)).toThrow(
      LocalRuntimeError,
    );
    expect(() =>
      resolveLocalRuntimePaths({ ...windowsOptions({ appId }) }),
    ).toThrow(LocalRuntimeError);
    expect(
      resolveLocalRuntimePaths({
        appId,
        dataDirectory: '/data/test/x',
        sourceRoot: '/workspace/y',
        platform: 'linux',
        homeDirectory: '/home/test',
      }).root,
    ).toBe(resolve('/data/test/x'));
  });
});

describe('data root base (WT6: roaming profile)', () => {
  it('uses the machine-local LOCALAPPDATA', () => {
    expect(
      resolveLocalRuntimePaths({
        appId: 'myapp',
        sourceRoot: SOURCE,
        platform: 'win32',
        homeDirectory: 'C:\\Users\\Will',
        env: ENV,
      }).root,
    ).toBe(`${LOCAL}\\myapp`);
  });

  it.each([
    ['missing', {}],
    ['empty', { LOCALAPPDATA: '' }],
    [
      'only the roaming profile',
      { APPDATA: 'C:\\Users\\Will\\AppData\\Roaming' },
    ],
    ['relative', { LOCALAPPDATA: 'Local' }],
    ['a network share', { LOCALAPPDATA: '\\\\srv\\profiles\\will\\Local' }],
    [
      'a device path',
      { LOCALAPPDATA: '\\\\?\\C:\\Users\\Will\\AppData\\Local' },
    ],
  ])('never falls back when LOCALAPPDATA is %s', (_name, env) => {
    expect(() =>
      resolveLocalRuntimePaths({
        appId: 'myapp',
        sourceRoot: SOURCE,
        platform: 'win32',
        homeDirectory: 'C:\\Users\\Will',
        env,
      }),
    ).toThrow(LocalRuntimeError);
  });

  it('refuses an explicit root with traversal, streams or a share', () => {
    for (const dataDirectory of [
      'C:\\Users\\Will\\..\\Other\\App',
      'C:\\Users\\Will\\App::$DATA',
      '\\\\srv\\share\\App',
    ]) {
      expect(() =>
        resolveLocalRuntimePaths(windowsOptions({ dataDirectory })),
      ).toThrow(LocalRuntimeError);
    }
  });

  it('keeps the conservative overlap guards on case-folded Windows paths', () => {
    expect(() =>
      resolveLocalRuntimePaths(
        windowsOptions({ dataDirectory: 'c:\\users\\will' }),
      ),
    ).toThrow('dedicated directory');
    expect(() =>
      resolveLocalRuntimePaths(
        windowsOptions({
          dataDirectory: 'c:\\WORK\\app\\data',
        }),
      ),
    ).toThrow('does not overlap the source tree');
  });
});

describe('W6 policy (WT1 other users, WT3 inherited access)', () => {
  const foreignAllow = `(A;OICIID;FA;;;${OTHER_SID})`;

  it.each([
    ['the default LOCALAPPDATA child', SDDL.userPrivate()],
    ['an Administrators-owned object', SDDL.adminOwned()],
    [
      'a deny ACE for a stranger',
      `${SDDL.userPrivate()}(D;OICI;FA;;;${OTHER_SID})`,
    ],
    [
      'an inherit-only CREATOR OWNER ACE',
      `${SDDL.userPrivate()}(A;OICIIO;FA;;;CO)`,
    ],
    ['an OWNER RIGHTS ACE', `${SDDL.userPrivate()}(A;;FA;;;OW)`],
    ['an empty DACL', `O:${USER_SID}G:${USER_SID}D:PAI`],
  ])('accepts %s as custodied', (_name, sddl) => {
    expect(policy('custodied', sddl)).not.toThrow();
  });

  it.each([
    ['a foreign owner', `O:${OTHER_SID}G:${OTHER_SID}D:PAI(A;;FA;;;SY)`],
    ['an Everyone owner', 'O:WDG:WDD:PAI(A;;FA;;;SY)'],
    ['Authenticated Users modify, inherited from C:\\', SDDL.driveRootChild()],
    ['Everyone', `${SDDL.userPrivate()}(A;;0x1200a9;;;WD)`],
    ['Users', `${SDDL.userPrivate()}(A;OICIID;FA;;;BU)`],
    ['Interactive', `${SDDL.userPrivate()}(A;;FR;;;IU)`],
    ['Authenticated Users', `${SDDL.userPrivate()}(A;;FR;;;AU)`],
    ['a domain admin', `${SDDL.userPrivate()}(A;;FA;;;S-1-5-21-9-9-9-512)`],
    ['another local user', `${SDDL.userPrivate()}${foreignAllow}`],
    [
      'an inheritable grant to Users',
      `${SDDL.userPrivate()}(A;OICIIO;GA;;;BU)`,
    ],
    ['an effective CREATOR OWNER ACE', `${SDDL.userPrivate()}(A;;FA;;;CO)`],
    ['a NULL DACL', `O:${USER_SID}G:${USER_SID}D:NO_ACCESS_CONTROL`],
    ['no DACL at all', `O:${USER_SID}G:${USER_SID}`],
    [
      'a conditional ACE',
      `${SDDL.userPrivate()}(XA;;FX;;;WD;(@User.Title==1))`,
    ],
    ['an object ACE', `${SDDL.userPrivate()}(OA;;CR;;;WD)`],
    ['a callback ACE', `${SDDL.userPrivate()}(ZA;;FA;;;WD)`],
    ['an audit ACE in the DACL', `${SDDL.userPrivate()}(AU;SA;FA;;;WD)`],
  ])('rejects %s as custodied', (_name, sddl) => {
    expect(policy('custodied', sddl)).toThrow(/lacks Windows custody/);
  });

  it.each([
    ['empty', ''],
    ['garbage', 'not sddl'],
    ['whitespace', 'O:BA G:SY'],
    ['truncated ACE', `O:${USER_SID}D:PAI(A;OICIID;FA;;;`],
    ['unknown right', `O:${USER_SID}D:PAI(A;;ZZ;;;SY)`],
    ['odd-length rights', `O:${USER_SID}D:PAI(A;;FAF;;;SY)`],
    ['unknown ACE flag', `O:${USER_SID}D:PAI(A;XX;FA;;;SY)`],
    ['malformed trustee', `O:${USER_SID}D:PAI(A;;FA;;;??)`],
    ['a malformed trustee in a deny ACE', `${SDDL.userPrivate()}(D;;FA;;;??)`],
    ['too few ACE fields', `O:${USER_SID}D:PAI(A;;FA;;SY)`],
    ['object GUID on a plain ACE', `O:${USER_SID}D:PAI(A;;FA;{x};;SY)`],
    ['repeated section', `O:BAO:BAD:PAI`],
    ['unknown section', `O:BAX:BA`],
    ['hex mask out of range', `O:${USER_SID}D:PAI(A;;0x123456789;;;SY)`],
  ])('fails closed on %s', (_name, sddl) => {
    expect(policy('custodied', sddl)).toThrow(LocalRuntimeError);
  });

  it('reports an unbalanced ACE as unparseable', () => {
    expect(policy('custodied', `O:${USER_SID}D:PAI(A;OICIID;FA;;;`)).toThrow(
      /unbalanced/,
    );
  });

  it('refuses a current-user identity that is not a SID', () => {
    expect(policy('custodied', SDDL.userPrivate(), 'will')).toThrow(
      /not a SID/,
    );
  });

  it.each([
    ['the drive root', SDDL.driveRoot],
    ['C:\\Users', SDDL.users],
    ['a user profile', SDDL.userPrivate()],
    [
      'a TrustedInstaller-owned directory',
      'O:S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464G:SYD:PAI(A;;FA;;;SY)(A;;FA;;;BA)',
    ],
    [
      'add-subdirectory for Authenticated Users (the sticky /tmp analogue)',
      `${SDDL.userPrivate()}(A;;0x4;;;AU)`,
    ],
    [
      'add-file under the SDDL alias DC for Authenticated Users',
      `${SDDL.userPrivate()}(A;;DC;;;AU)`,
    ],
    [
      'a destructive grant that is inherit-only',
      `${SDDL.userPrivate()}(A;OICIIO;0x1301bf;;;AU)`,
    ],
  ])('accepts %s as an ancestor', (_name, sddl) => {
    expect(policy('ancestor', sddl)).not.toThrow();
  });

  it.each([
    ['delete (SD)', '(A;;SD;;;BU)'],
    ['delete-child (the SDDL alias DT)', '(A;;DT;;;BU)'],
    ['delete-child as a hex mask', '(A;;0x40;;;BU)'],
    ['write-DAC (WD)', '(A;;WD;;;BU)'],
    ['write-owner (WO)', '(A;;WO;;;BU)'],
    ['generic all (GA)', '(A;;GA;;;BU)'],
    ['generic write (GW)', '(A;;GW;;;BU)'],
    ['file all (FA)', '(A;;FA;;;WD)'],
    ['modify as a hex mask', '(A;;0x1301bf;;;AU)'],
  ])('rejects an ancestor that lets a stranger use %s', (_name, ace) => {
    expect(policy('ancestor', `${SDDL.userPrivate()}${ace}`)).toThrow(
      /may delete or re-secure/,
    );
  });

  it('rejects an ancestor owned by a stranger or without a DACL', () => {
    expect(policy('ancestor', `O:${OTHER_SID}G:SYD:PAI(A;;FA;;;SY)`)).toThrow(
      /owner is not a trusted principal/,
    );
    expect(policy('ancestor', `O:${USER_SID}G:SYD:NO_ACCESS_CONTROL`)).toThrow(
      /NULL DACL/,
    );
  });
});

describe('W6 policy: the built-in Administrator is written as LA (RID 500)', () => {
  // SDDL renders the machine's RID-500 account as the alias LA, never as its
  // SID. A runner whose user is that account must still trust its own files.
  const RID_500 = 'S-1-5-21-111-222-333-500';
  const adminPrivate =
    'O:LAG:LAD:PAI(A;OICI;FA;;;LA)(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)';
  const adminOwnedByAdministrators =
    'O:BAG:BAD:PAI(A;OICIID;FA;;;LA)(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)';

  it.each([
    ['an LA owner and LA grant', adminPrivate],
    ['an LA inherited grant', adminOwnedByAdministrators],
  ])('trusts %s when the current user is RID 500', (_name, sddl) => {
    expect(policy('custodied', sddl, RID_500)).not.toThrow();
    expect(policy('ancestor', sddl, RID_500)).not.toThrow();
  });

  it('still refuses LA for an ordinary user, whose Administrator is another principal', () => {
    expect(policy('custodied', adminOwnedByAdministrators)).toThrow(
      /access is granted to ALIAS:LA/,
    );
    expect(policy('custodied', adminPrivate)).toThrow(
      /owner is not a trusted principal \(ALIAS:LA\)/,
    );
  });

  it.each([
    ['the Guest account (RID 501)', 'S-1-5-21-111-222-333-501'],
    ['a RID that merely ends in 500', 'S-1-5-21-111-222-333-1500'],
    ['a service SID', 'S-1-5-80-111-222-333-500'],
    ['a non-machine SID', 'S-1-5-32-500'],
  ])('does not extend LA to %s', (_name, user) => {
    expect(policy('custodied', adminOwnedByAdministrators, user)).toThrow(
      /access is granted to ALIAS:LA/,
    );
  });

  it('still refuses every other alias for a RID-500 user', () => {
    for (const alias of ['LG', 'DA', 'BU', 'AU', 'WD']) {
      expect(
        policy(
          'custodied',
          `O:BAG:BAD:PAI(A;OICIID;FA;;;${alias})(A;OICIID;FA;;;BA)`,
          RID_500,
        ),
      ).toThrow(/lacks Windows custody/);
    }
  });
});

describe('W3/W4/W5 chain checks (WT2, WT4, WT7)', () => {
  const prepare = (machine: FakeWindowsMachine, directory = ROOT) =>
    preparePrivateWindowsTree(machine.runtime(), { directory });

  it('creates a private root under the default LOCALAPPDATA', () => {
    const machine = FakeWindowsMachine.standard();
    expect(prepare(machine)).toEqual({
      createdDirectories: [ROOT],
      createdFile: false,
    });
    expect(machine.exists(ROOT)).toBe(true);
  });

  it('verifies an existing root without creating anything', () => {
    const machine = FakeWindowsMachine.standard();
    machine.dir(ROOT, SDDL.userPrivate());
    expect(prepare(machine).createdDirectories).toEqual([]);
    expect(machine.operations).toEqual([]);
  });

  it('refuses a symbolic link or junction at an ancestor and at the leaf (WT2)', () => {
    for (const link of ['C:\\Users\\Will\\AppData', ROOT]) {
      const machine = FakeWindowsMachine.standard();
      machine.dir(ROOT, SDDL.userPrivate());
      (machine.at(link) as { kind: string }).kind = 'symlink';
      expect(() => prepare(machine)).toThrow(/link or reparse point/);
      expect(machine.operations).toEqual([]);
    }
  });

  it('refuses a reparse point that lstat cannot see as a link (WT2, WT7)', () => {
    // Volume mount points and cloud placeholders report as plain directories.
    for (const attributes of [0x410, 0x400010]) {
      const machine = FakeWindowsMachine.standard();
      machine.dir(ROOT, SDDL.userPrivate(), { attributes });
      expect(() => prepare(machine)).toThrow(
        attributes & 0x400 ? /reparse point/ : /cloud-managed|offline/,
      );
    }
    const mount = FakeWindowsMachine.standard();
    mount.at('C:\\Users\\Will\\AppData').attributes = 0x410;
    expect(() => prepare(mount)).toThrow(/reparse point/);
  });

  it.each([
    ['an 8.3 short name', 'C:\\Users\\WILL~1\\AppData\\Local\\MyApp'],
    ['a subst drive', 'D:\\real\\Local\\MyApp'],
    ['a mapped network drive', '\\\\srv\\share\\Local\\MyApp'],
  ])('refuses a path that resolves through %s (WT7)', (_name, real) => {
    const machine = FakeWindowsMachine.standard();
    machine.dir(ROOT, SDDL.userPrivate(), { realpath: real });
    expect(() => prepare(machine)).toThrow(/must not be redirected/);
  });

  it('refuses a case variant of an existing directory (WT5, D6)', () => {
    const machine = FakeWindowsMachine.standard();
    machine.dir(ROOT, SDDL.userPrivate());
    expect(() =>
      prepare(machine, 'C:\\Users\\will\\AppData\\Local\\MyApp'),
    ).toThrow(/must not be redirected/);
  });

  it('tolerates only the drive-letter case in the real path', () => {
    const machine = FakeWindowsMachine.standard();
    machine.dir(ROOT, SDDL.userPrivate());
    machine.at('C:\\Users').realpath = 'c:\\Users';
    expect(() => prepare(machine)).not.toThrow();
  });

  it('refuses a root on FAT, exFAT, ReFS, network, removable or RAM volumes (WT7, D7)', () => {
    for (const volume of [
      { driveFormat: 'FAT32', driveType: 3 },
      { driveFormat: 'exFAT', driveType: 3 },
      { driveFormat: 'ReFS', driveType: 3 },
      { driveFormat: 'NTFS', driveType: 4 },
      { driveFormat: 'NTFS', driveType: 2 },
      { driveFormat: 'NTFS', driveType: 6 },
      { driveFormat: '', driveType: 0 },
    ]) {
      const machine = FakeWindowsMachine.standard();
      machine.volumes.set('C', volume);
      expect(() => prepare(machine)).toThrow(/local fixed NTFS volume/);
      expect(machine.operations).toEqual([]);
    }
  });

  it('refuses a path that was swapped while its ACL was being read (TOCTOU)', () => {
    const machine = FakeWindowsMachine.standard();
    machine.dir(ROOT, SDDL.userPrivate());
    machine.duringInspection = () => {
      machine.at(ROOT).ino += 1n;
    };
    expect(() => prepare(machine)).toThrow(/changed while its access controls/);
  });

  it('refuses a handle that is not the file lstat saw, even when the ids round to one number (W5)', () => {
    const lstatIno = 0x0123_4567_89ab_cdefn;
    const handleIno = 0x0123_4567_89ab_cdeen;
    // The regression this guards: as JavaScript numbers the two are equal.
    expect(Number(lstatIno)).toBe(Number(handleIno));
    const machine = FakeWindowsMachine.standard();
    machine.file(`${ROOT}\\marker`, SDDL.userPrivate(), {
      ino: lstatIno,
      handleIno,
    });
    expect(() =>
      verifyWindowsFile(machine.runtime(), `${ROOT}\\marker`),
    ).toThrow(/changed while it was being opened/);
  });

  it('refuses a file with a second hard link (WT4, W5)', () => {
    const machine = FakeWindowsMachine.standard();
    machine.file(`${ROOT}\\marker`, SDDL.userPrivate(), { nlink: 2n });
    expect(() =>
      verifyWindowsFile(machine.runtime(), `${ROOT}\\marker`),
    ).toThrow(/exactly one link/);
  });

  it('refuses a file of the wrong size', () => {
    const machine = FakeWindowsMachine.standard();
    machine.file(`${ROOT}\\marker`, SDDL.userPrivate(), { size: 3n });
    expect(() =>
      verifyWindowsFile(machine.runtime(), `${ROOT}\\marker`, { size: 0 }),
    ).toThrow(/unexpected size/);
  });

  it('resolves a drive alias to the directory it points at before keying a lock', () => {
    const machine = FakeWindowsMachine.standard();
    machine.dir(ROOT, SDDL.userPrivate());
    // `subst S: <LOCAL>`: S:\MyApp is the same directory as ROOT.
    machine.dir('S:\\', SDDL.userPrivate(), { realpath: LOCAL });
    machine.dir('S:\\MyApp', SDDL.userPrivate(), { realpath: ROOT });
    const rt = machine.runtime();
    expect(windowsCanonicalIdentity(rt, 'S:\\MyApp')).toBe(
      windowsCanonicalIdentity(rt, ROOT),
    );
  });

  it('shares one lock identity across spellings and aliases of one directory', () => {
    const machine = FakeWindowsMachine.standard();
    machine.dir(ROOT, SDDL.userPrivate());
    const rt = machine.runtime();
    const identity = windowsCanonicalIdentity(rt, ROOT);
    expect(windowsCanonicalIdentity(rt, ROOT.toUpperCase())).toBe(identity);
    expect(
      windowsCanonicalIdentity(rt, ROOT.toLowerCase().replace(/^c:/, 'C:')),
    ).toBe(identity);
    expect(windowsCanonicalIdentity(rt, `${ROOT}\\sub`)).toBe(
      `${identity}\\sub`,
    );
  });
});

describe('creation re-checks the inherited DACL (WT2, WT3)', () => {
  it('removes a root created under C:\\ whose inherited ACL admits other users', () => {
    const machine = FakeWindowsMachine.standard();
    expect(() =>
      preparePrivateWindowsTree(machine.runtime(), {
        directory: 'C:\\smrt-data',
      }),
    ).toThrow(/Authenticated Users|S-1-5-11|lacks Windows custody/);
    expect(machine.exists('C:\\smrt-data')).toBe(false);
    expect(machine.operations).toEqual([
      'mkdir C:\\smrt-data',
      'rmdir C:\\smrt-data',
    ]);
  });

  it('never removes a directory it did not create', () => {
    const machine = FakeWindowsMachine.standard();
    // `Shared` exists, and anything created under it inherits a permissive DACL.
    machine.dir(`${LOCAL}\\Shared`, SDDL.userPrivate(), {
      childSddl: SDDL.driveRootChild(),
    });
    expect(() =>
      preparePrivateWindowsTree(machine.runtime(), {
        directory: `${LOCAL}\\Shared\\Inner\\Deep`,
      }),
    ).toThrow(/lacks Windows custody/);
    expect(machine.exists(`${LOCAL}\\Shared`)).toBe(true);
    expect(machine.exists(`${LOCAL}\\Shared\\Inner`)).toBe(false);
    expect(machine.operations).not.toContain(`rmdir ${LOCAL}\\Shared`);
  });

  it('holds a directory it created to the custodied rule even above the root', () => {
    const machine = FakeWindowsMachine.standard();
    // The missing intermediate component inherits a read-only grant for
    // Authenticated Users: harmless for an existing ancestor (no replacement
    // rights), but not something the runtime may create. The root beneath it
    // is clean, so only the created-component rule can reject this.
    machine.at(LOCAL).childSddl =
      `${SDDL.userPrivate()}(A;OICIID;0x1200a9;;;AU)`;
    const rt = machine.runtime();
    const cleanBelowVendor = {
      ...rt,
      mkdir: (path: string) => {
        rt.mkdir(path);
        if (path.endsWith('\\Vendor')) {
          machine.at(path).childSddl = SDDL.userPrivate();
        }
      },
    };
    expect(() =>
      preparePrivateWindowsTree(cleanBelowVendor, {
        directory: `${LOCAL}\\Vendor\\App`,
      }),
    ).toThrow(/lacks Windows custody/);
    expect(machine.exists(`${LOCAL}\\Vendor`)).toBe(false);
    expect(machine.exists(`${LOCAL}\\Vendor\\App`)).toBe(false);
  });

  it('propagates a creation failure and rolls back what it already created', () => {
    const machine = FakeWindowsMachine.standard();
    const rt = machine.runtime();
    const denied = {
      ...rt,
      mkdir: (path: string) => {
        if (path.endsWith('\\App')) {
          throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
        }
        rt.mkdir(path);
      },
    };
    expect(() =>
      preparePrivateWindowsTree(denied, {
        directory: `${LOCAL}\\Vendor\\App`,
      }),
    ).toThrow('EACCES');
    expect(machine.exists(`${LOCAL}\\Vendor`)).toBe(false);
  });

  it('refuses a directory planted by another user at a missing component, and leaves it alone (WT2)', () => {
    const machine = FakeWindowsMachine.standard();
    const rt = machine.runtime();
    const racing = {
      ...rt,
      mkdir: (path: string) => {
        // The attacker wins the race to create the name.
        machine.dir(
          path,
          `O:${OTHER_SID}G:${OTHER_SID}D:PAI(A;;FA;;;${OTHER_SID})`,
        );
        const error: NodeJS.ErrnoException = new Error('EEXIST');
        error.code = 'EEXIST';
        throw error;
      },
    };
    expect(() =>
      preparePrivateWindowsTree(racing, { directory: ROOT }),
    ).toThrow(/owner is not a trusted principal/);
    expect(machine.exists(ROOT)).toBe(true);
  });

  it('refuses an existing root owned by another user before creating anything (WT1)', () => {
    const machine = FakeWindowsMachine.standard();
    machine.dir(
      ROOT,
      `O:${OTHER_SID}G:${OTHER_SID}D:PAI(A;;FA;;;${OTHER_SID})`,
    );
    expect(() =>
      preparePrivateWindowsTree(machine.runtime(), {
        directory: ROOT,
        file: { path: `${ROOT}\\marker`, size: 0 },
      }),
    ).toThrow(/owner is not a trusted principal/);
    expect(machine.operations).toEqual([]);
  });

  it('creates a file and removes it again when its inherited ACL is wrong', () => {
    const machine = FakeWindowsMachine.standard();
    machine.dir(ROOT, SDDL.userPrivate(), { childSddl: SDDL.driveRootChild() });
    expect(() =>
      preparePrivateWindowsTree(machine.runtime(), {
        directory: ROOT,
        file: { path: `${ROOT}\\marker`, size: 0 },
      }),
    ).toThrow(/lacks Windows custody/);
    expect(machine.exists(`${ROOT}\\marker`)).toBe(false);
    expect(machine.exists(ROOT)).toBe(true);
  });
});

describe('inspector failures (WT8)', () => {
  const stdout = (records = 1) =>
    JSON.stringify({
      user: USER_SID,
      items: Array.from({ length: records }, () => ({
        sddl: SDDL.userPrivate(),
        attributes: 16,
        driveFormat: 'NTFS',
        driveType: 3,
      })),
    });
  const inspect = (exec: InspectorExec) =>
    createPowerShellAclInspector({
      exec,
      env: { SystemRoot: 'C:\\Windows' },
    })(['C:\\a']);

  it('accepts a well-formed answer', () => {
    expect(inspect(() => stdout()).userSid).toBe(USER_SID);
  });

  it.each([
    [
      'a missing PowerShell',
      () => {
        throw Object.assign(new Error('spawn'), { code: 'ENOENT' });
      },
    ],
    [
      'a timeout',
      () => {
        throw Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });
      },
    ],
    [
      'a non-zero exit',
      () => {
        throw Object.assign(new Error('exit 1'), { status: 1 });
      },
    ],
    [
      'output over the buffer',
      () => {
        throw Object.assign(new Error('maxBuffer'), { code: 'ENOBUFS' });
      },
    ],
    [
      'an oversized answer from a lax exec',
      () => stdout() + ' '.repeat(300 * 1024),
    ],
    ['non-JSON', () => 'Access is denied.'],
    ['empty output', () => ''],
    ['a different item count', () => stdout(2)],
    ['no user', () => JSON.stringify({ items: JSON.parse(stdout()).items })],
    ['a user that is not a SID', () => stdout().replace(USER_SID, 'will')],
    ['non-ASCII output', () => stdout().replace('O:', 'O\u00e9:')],
    [
      'an item of the wrong shape',
      () => JSON.stringify({ user: USER_SID, items: [{ sddl: 1 }] }),
    ],
    [
      'a non-integer attribute set',
      () => stdout().replace('"attributes":16', '"attributes":1.5'),
    ],
  ])('refuses on %s', (_name, exec) => {
    expect(() => inspect(exec as InspectorExec)).toThrow(
      /inspector unavailable/,
    );
  });

  it('refuses without a usable SystemRoot', () => {
    for (const env of [{}, { SystemRoot: '\\\\srv\\share\\Windows' }]) {
      expect(() =>
        createPowerShellAclInspector({ exec: () => stdout(), env })(['C:\\a']),
      ).toThrow(/inspector unavailable/);
    }
  });

  it('refuses to inspect a path it cannot pass safely', () => {
    for (const path of ['relative', 'C:\\a\nb', '\\\\srv\\x']) {
      expect(() => buildInspectorEnvironment([path], {})).toThrow(
        /inspector unavailable/,
      );
    }
    expect(() => buildInspectorEnvironment([], {})).toThrow(
      /inspector unavailable/,
    );
  });

  it('creates nothing when the inspector is unavailable', () => {
    const machine = FakeWindowsMachine.standard();
    machine.inspectOverride = () => {
      throw new LocalRuntimeError(
        'invalid_configuration',
        'Windows custody inspector unavailable',
      );
    };
    expect(() =>
      preparePrivateWindowsTree(machine.runtime(), { directory: ROOT }),
    ).toThrow(/inspector unavailable/);
    expect(machine.operations).toEqual([]);
  });

  it('refuses an inspector that answers for a different number of paths', () => {
    const machine = FakeWindowsMachine.standard();
    machine.inspectOverride = () => ({ userSid: USER_SID, records: [] });
    expect(() =>
      preparePrivateWindowsTree(machine.runtime(), { directory: ROOT }),
    ).toThrow(/unexpected answer/);
  });

  it('parses the answer shape strictly', () => {
    expect(() => parseInspectorOutput('[]', 0)).toThrow(/unavailable/);
  });
});

describe('inspector invocation (WT9: no injection through the path)', () => {
  const hostile = [
    "C:\\a'; Remove-Item -Recurse C:\\ #\\b",
    'C:\\$(calc)\\x',
    'C:\\`n\\x',
    'C:\\[a]\\x',
    'C:\\caf\u00e9 \u2603\\x',
  ];

  function capture() {
    const calls: Array<{
      file: string;
      args: readonly string[];
      options: Parameters<InspectorExec>[2];
    }> = [];
    const exec: InspectorExec = (file, args, options) => {
      calls.push({ file, args, options });
      return JSON.stringify({
        user: USER_SID,
        items: options.env.SMRT_CUSTODY_PATHS.split('\n').map(() => ({
          sddl: SDDL.userPrivate(),
          attributes: 16,
          driveFormat: 'NTFS',
          driveType: 3,
        })),
      });
    };
    return { calls, exec };
  }

  it('passes the same argv for every call and never puts a path in it', () => {
    const { calls, exec } = capture();
    const inspector = createPowerShellAclInspector({
      exec,
      env: { SystemRoot: 'C:\\Windows', PATH: 'C:\\evil', SECRET: 'x' },
    });
    inspector(['C:\\unique-path-marker']);
    inspector(hostile);
    expect(calls).toHaveLength(2);
    expect(JSON.stringify(calls[0].args)).toBe(JSON.stringify(calls[1].args));
    expect([...calls[0].args]).toEqual([...POWERSHELL_INSPECTOR_ARGV]);
    for (const path of ['unique-path-marker', ...hostile]) {
      for (const arg of calls[1].args) expect(arg).not.toContain(path);
    }
  });

  it('inherits PATHEXT (without it Windows PowerShell 5.1 returns nothing from whoami.exe) but never PATH', () => {
    const { calls, exec } = capture();
    createPowerShellAclInspector({
      exec,
      env: {
        SystemRoot: 'C:\\Windows',
        PATHEXT: '.COM;.EXE',
        PATH: 'C:\\evil',
      },
    })(['C:\\x']);
    const env = calls[0].options.env as Record<string, string>;
    expect(env.PATHEXT).toBe('.COM;.EXE');
    expect(Object.keys(env).map((k) => k.toLowerCase())).not.toContain('path');
  });

  it('carries every path verbatim in one environment variable', () => {
    const { calls, exec } = capture();
    createPowerShellAclInspector({ exec, env: { SystemRoot: 'C:\\Windows' } })(
      hostile,
    );
    expect(calls[0].options.env.SMRT_CUSTODY_PATHS).toBe(hostile.join('\n'));
  });

  it('runs a fixed absolute executable with no shell and bounded resources', () => {
    const { calls, exec } = capture();
    createPowerShellAclInspector({
      exec,
      env: {
        SystemRoot: 'C:\\Windows',
        PATH: 'C:\\evil',
        PSModulePath: 'C:\\evil',
        SECRET: 'x',
        LOCALAPPDATA: LOCAL,
      },
    })(['C:\\a']);
    const [{ file, options }] = calls;
    expect(file).toBe(
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    );
    expect(options.shell).toBe(false);
    expect(options.windowsHide).toBe(true);
    expect(options.timeout).toBe(10_000);
    expect(options.maxBuffer).toBe(256 * 1024);
    expect(options.stdio).toEqual(['ignore', 'pipe', 'pipe']);
    expect(Object.keys(options.env).sort()).toEqual([
      'LOCALAPPDATA',
      'SMRT_CUSTODY_PATHS',
      'SystemRoot',
    ]);
  });

  it('encodes exactly the reviewed script, which has no dynamic evaluation', () => {
    const args = [...POWERSHELL_INSPECTOR_ARGV];
    const encoded = args[args.indexOf('-EncodedCommand') + 1];
    expect(Buffer.from(encoded, 'base64').toString('utf16le')).toBe(
      POWERSHELL_INSPECTOR_SCRIPT,
    );
    expect(args).not.toContain('-Command');
    expect(POWERSHELL_INSPECTOR_SCRIPT).not.toMatch(
      /Invoke-Expression|\biex\b|Start-Process|Invoke-Command|\bcmd\b|-Command/i,
    );
    expect(POWERSHELL_INSPECTOR_SCRIPT).not.toContain('"');
    for (const cmdlet of ['Get-Item', 'Get-Acl']) {
      const uses = POWERSHELL_INSPECTOR_SCRIPT.match(
        new RegExp(`${cmdlet}[^\\n]*`, 'g'),
      );
      expect(uses).not.toBeNull();
      for (const use of uses ?? []) expect(use).toContain('-LiteralPath');
    }
  });
});

describe('initialization lease on Windows', () => {
  it('takes exactly one beside-data lease, never a legacy /tmp lease', async () => {
    const machine = FakeWindowsMachine.standard();
    const lock = await onWindows(machine, () =>
      acquireInitializationLock(ROOT),
    );
    expect(workers.created).toHaveLength(1);
    const [worker] = workers.created;
    expect(worker.lockOnly).toBe(true);
    expect(worker.path).toMatch(
      /^C:\\Users\\Will\\AppData\\Local\\\.smrt-lease-[0-9a-f]{32}\\initialization\.sqlite$/,
    );
    expect(worker.custodyRoot).toBe(
      worker.path.replace('\\initialization.sqlite', ''),
    );
    expect(machine.operations).toEqual([
      `mkdir ${worker.custodyRoot}`,
      `create ${worker.path}`,
    ]);
    expect(machine.operations.join()).not.toMatch(/tmp/i);
    await lock.release();
  });

  it('derives one lease for every spelling of a data root', async () => {
    const paths: string[] = [];
    for (const spelling of [ROOT, ROOT.replace('C:', 'c:'), `${ROOT}\\`]) {
      const machine = FakeWindowsMachine.standard();
      machine.dir(ROOT, SDDL.userPrivate());
      const lock = await onWindows(machine, () =>
        acquireInitializationLock(spelling),
      );
      paths.push(workers.created.at(-1)?.path ?? '');
      await lock.release();
    }
    expect(new Set(paths).size).toBe(1);
  });

  it('keys the lease by the real directory, so a drive alias takes the same lease', async () => {
    const machine = FakeWindowsMachine.standard();
    machine.dir(ROOT, SDDL.userPrivate());
    machine.dir('S:\\', SDDL.userPrivate());
    machine.dir('S:\\MyApp', SDDL.userPrivate(), { realpath: ROOT });
    const keys: string[] = [];
    for (const spelling of [ROOT, 'S:\\MyApp']) {
      const lock = await onWindows(machine, () =>
        acquireInitializationLock(spelling),
      );
      keys.push(workers.created.at(-1)?.custodyRoot.split('\\').at(-1) ?? '');
      await lock.release();
    }
    expect(keys[0]).toMatch(/^\.smrt-lease-[0-9a-f]{32}$/);
    expect(keys[1]).toBe(keys[0]);
  });

  it('refuses to lease through a case variant of an existing parent (D6)', async () => {
    const machine = FakeWindowsMachine.standard();
    await expect(
      onWindows(machine, () => acquireInitializationLock(ROOT.toUpperCase())),
    ).rejects.toThrow(/must not be redirected/);
    expect(workers.created).toHaveLength(0);
  });

  it('reuses an existing, correctly secured lease', async () => {
    const machine = FakeWindowsMachine.standard();
    const first = await onWindows(machine, () =>
      acquireInitializationLock(ROOT),
    );
    await first.release();
    machine.operations.length = 0;
    const second = await onWindows(machine, () =>
      acquireInitializationLock(ROOT),
    );
    expect(machine.operations).toEqual([]);
    await second.release();
  });

  it('refuses a lease beside a root whose parent would expose it (WT3)', async () => {
    const machine = FakeWindowsMachine.standard();
    machine.at(LOCAL).childSddl = SDDL.driveRootChild();
    await expect(
      onWindows(machine, () => acquireInitializationLock(ROOT)),
    ).rejects.toThrow(/lacks Windows custody/);
    expect(workers.created).toHaveLength(0);
    expect(
      [...machine.nodes.keys()].filter((key) => key.includes('.smrt-lease')),
    ).toEqual([]);
  });

  it('refuses a lease directory planted by another user (WT1, WT2)', async () => {
    const machine = FakeWindowsMachine.standard();
    machine.dir(ROOT, SDDL.userPrivate());
    const lock = await onWindows(machine, () =>
      acquireInitializationLock(ROOT),
    );
    await lock.release();
    const lease = workers.created[0].custodyRoot;
    machine.at(lease).sddl =
      `O:${OTHER_SID}G:${OTHER_SID}D:PAI(A;;FA;;;${OTHER_SID})`;
    workers.created.length = 0;
    await expect(
      onWindows(machine, () => acquireInitializationLock(ROOT)),
    ).rejects.toThrow(/owner is not a trusted principal/);
    expect(workers.created).toHaveLength(0);
  });
});

function storedRoot(machine: FakeWindowsMachine) {
  machine.dir(ROOT, SDDL.userPrivate());
  machine.file(`${ROOT}\\.smrt-local-runtime-myapp`, SDDL.userPrivate());
  machine.file(`${ROOT}\\application.sqlite`, SDDL.userPrivate(), {
    size: 4096n,
  });
}

describe('read-only validation works on Windows', () => {
  it('accepts a correctly secured stored root with one inspection', async () => {
    const machine = FakeWindowsMachine.standard();
    storedRoot(machine);
    const paths = await onWindows(machine, () =>
      validateLocalDatabaseStorage(windowsOptions()),
    );
    expect(paths.root).toBe(ROOT);
    expect(machine.inspections).toHaveLength(1);
    expect(machine.operations).toEqual([]);
  });

  it.each([
    [
      'a database with a second hard link',
      (m: FakeWindowsMachine) => {
        m.at(`${ROOT}\\application.sqlite`).nlink = 2n;
      },
      /exactly one link/,
    ],
    [
      'a database explicitly shared with Users',
      (m: FakeWindowsMachine) => {
        m.at(`${ROOT}\\application.sqlite`).sddl =
          `${SDDL.userPrivate()}(A;;FR;;;BU)`;
      },
      /lacks Windows custody/,
    ],
    [
      'a non-empty marker',
      (m: FakeWindowsMachine) => {
        m.at(`${ROOT}\\.smrt-local-runtime-myapp`).size = 9n;
      },
      /unexpected size/,
    ],
    [
      'a database that is a symbolic link',
      (m: FakeWindowsMachine) => {
        m.at(`${ROOT}\\application.sqlite`).kind = 'symlink';
      },
      /real file/,
    ],
    [
      'a root owned by another user',
      (m: FakeWindowsMachine) => {
        m.at(ROOT).sddl = `O:${OTHER_SID}G:SYD:PAI(A;;FA;;;SY)`;
      },
      /owner is not a trusted principal/,
    ],
  ])('rejects %s', async (_name, mutate, message) => {
    const machine = FakeWindowsMachine.standard();
    storedRoot(machine);
    mutate(machine);
    await expect(
      onWindows(machine, () => validateLocalDatabaseStorage(windowsOptions())),
    ).rejects.toThrow(message);
  });

  it('reports a missing marker as a missing file', async () => {
    const machine = FakeWindowsMachine.standard();
    storedRoot(machine);
    machine.nodes.delete(`${ROOT}\\.smrt-local-runtime-myapp`.toLowerCase());
    await expect(
      onWindows(machine, () => validateLocalDatabaseStorage(windowsOptions())),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports a missing root as missing', async () => {
    const machine = FakeWindowsMachine.standard();
    await expect(
      onWindows(machine, () => validateLocalDatabaseStorage(windowsOptions())),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('preflight keeps the dedicated-root rules', () => {
  const preflight = (machine: FakeWindowsMachine) =>
    onWindows(machine, () =>
      preflightLocalApplicationRoot(ROOT, SOURCE, 'myapp'),
    );

  it('refuses a populated root without a marker', async () => {
    const machine = FakeWindowsMachine.standard();
    machine.dir(ROOT, SDDL.userPrivate());
    machine.file(`${ROOT}\\notes.txt`, SDDL.userPrivate());
    await expect(preflight(machine)).rejects.toThrow(
      /no valid ownership marker/,
    );
  });

  it('refuses a pending root with unexpected artifacts', async () => {
    const machine = FakeWindowsMachine.standard();
    machine.dir(ROOT, SDDL.userPrivate());
    machine.file(
      `${ROOT}\\.smrt-local-runtime-myapp.pending`,
      SDDL.userPrivate(),
    );
    machine.file(`${ROOT}\\notes.txt`, SDDL.userPrivate());
    await expect(preflight(machine)).rejects.toThrow(/unexpected artifacts/);
  });

  it('accepts an empty root, a marked root and an interrupted claim', async () => {
    for (const arrange of [
      (m: FakeWindowsMachine) => m.dir(ROOT, SDDL.userPrivate()),
      (m: FakeWindowsMachine) => {
        m.dir(ROOT, SDDL.userPrivate());
        m.file(`${ROOT}\\.smrt-local-runtime-myapp`, SDDL.userPrivate());
        m.file(`${ROOT}\\application.sqlite`, SDDL.userPrivate());
      },
      (m: FakeWindowsMachine) => {
        m.dir(ROOT, SDDL.userPrivate());
        m.file(
          `${ROOT}\\.smrt-local-runtime-myapp.pending`,
          SDDL.userPrivate(),
        );
        m.file(`${ROOT}\\application.sqlite-wal`, SDDL.userPrivate());
      },
    ]) {
      const machine = FakeWindowsMachine.standard();
      arrange(machine);
      await expect(preflight(machine)).resolves.toBeUndefined();
    }
  });

  it('refuses a root inside the canonical source tree', async () => {
    const machine = FakeWindowsMachine.standard();
    // The checkout is a junction into the profile the data root lives under.
    machine.at(SOURCE).realpath = LOCAL;
    await expect(preflight(machine)).rejects.toThrow(
      /outside the canonical source tree/,
    );
    expect(machine.operations).toEqual([]);
  });

  it('refuses a root inside the lexical source tree', () => {
    expect(() =>
      resolveLocalRuntimePaths(
        windowsOptions({ dataDirectory: 'C:\\work\\app\\data' }),
      ),
    ).toThrow(/does not overlap the source tree/);
  });

  it('refuses a source tree reached through a different spelling', () => {
    expect(() =>
      resolveLocalRuntimePaths(
        windowsOptions({
          dataDirectory: 'C:\\work\\app\\data',
          sourceRoot: 'c:\\WORK\\APP',
        }),
      ),
    ).toThrow(/does not overlap the source tree/);
  });
});

describe('operator state root on Windows', () => {
  const stateOptions = (extra: Record<string, unknown> = {}) => ({
    appId: 'myapp',
    dataDirectory: ROOT,
    sourceRoot: SOURCE,
    platformName: 'win32',
    homeDirectory: 'C:\\Users\\Will',
    environment: ENV,
    ...extra,
  });

  it('puts the state beside the data under LOCALAPPDATA, never the home directory', () => {
    const root = resolveApplicationStateRoot(stateOptions());
    expect(root).toMatch(
      /^C:\\Users\\Will\\AppData\\Local\\\.myapp-[0-9a-f]{12}-state$/,
    );
    expect(() =>
      resolveApplicationStateRoot(
        stateOptions({
          environment: { APPDATA: 'C:\\Users\\Will\\AppData\\Roaming' },
        }),
      ),
    ).toThrow(/LOCALAPPDATA/);
  });

  it('gives case variants of one data directory one state root (one lock domain)', () => {
    const roots = new Set(
      [
        ROOT,
        ROOT.toLowerCase(),
        ROOT.toUpperCase(),
        ROOT.replace('C:', 'c:'),
      ].map((dataDirectory) =>
        resolveApplicationStateRoot(stateOptions({ dataDirectory })),
      ),
    );
    expect(roots.size).toBe(1);
  });

  it('gives distinct data directories distinct state roots', () => {
    expect(resolveApplicationStateRoot(stateOptions())).not.toBe(
      resolveApplicationStateRoot(
        stateOptions({ dataDirectory: `${LOCAL}\\Other` }),
      ),
    );
  });

  it('creates the private state root and marker under the W6 rule', () => {
    const machine = FakeWindowsMachine.standard();
    const stateRoot = onWindows(machine, () =>
      prepareApplicationStateRoot(stateOptions()),
    );
    expect(machine.exists(stateRoot)).toBe(true);
    expect(machine.exists(`${stateRoot}\\.smrt-state-myapp`)).toBe(true);
    // Idempotent and verifying on the second call.
    machine.operations.length = 0;
    expect(
      onWindows(machine, () => prepareApplicationStateRoot(stateOptions())),
    ).toBe(stateRoot);
    expect(machine.operations).toEqual([]);
  });

  it('refuses a state base whose inherited ACL admits other users (WT3)', () => {
    const machine = FakeWindowsMachine.standard();
    machine.at(LOCAL).childSddl = SDDL.driveRootChild();
    expect(() =>
      onWindows(machine, () => prepareApplicationStateRoot(stateOptions())),
    ).toThrow(/lacks Windows custody/);
    expect(
      [...machine.nodes.keys()].filter((key) => key.includes('-state')),
    ).toEqual([]);
  });

  it('refuses a state marker with a second hard link', () => {
    const machine = FakeWindowsMachine.standard();
    const stateRoot = onWindows(machine, () =>
      prepareApplicationStateRoot(stateOptions()),
    );
    machine.at(`${stateRoot}\\.smrt-state-myapp`).nlink = 2n;
    expect(() =>
      onWindows(machine, () => prepareApplicationStateRoot(stateOptions())),
    ).toThrow(/exactly one link/);
  });

  it('refuses a state marker that is not empty', () => {
    const machine = FakeWindowsMachine.standard();
    const stateRoot = onWindows(machine, () =>
      prepareApplicationStateRoot(stateOptions()),
    );
    machine.at(`${stateRoot}\\.smrt-state-myapp`).size = 3n;
    expect(() =>
      onWindows(machine, () => prepareApplicationStateRoot(stateOptions())),
    ).toThrow(/unexpected size/);
  });

  it('refuses state inside the source tree', () => {
    const machine = FakeWindowsMachine.standard();
    machine.env = { ...ENV, LOCALAPPDATA: 'C:\\work\\app\\local' };
    machine.dir('C:\\work\\app\\local', SDDL.readable);
    expect(() =>
      onWindows(machine, () =>
        prepareApplicationStateRoot(stateOptions({ environment: machine.env })),
      ),
    ).toThrow(/outside the source tree/);
  });

  describe('identity is never skipped (every platform)', () => {
    const original = Object.getOwnPropertyDescriptor(process, 'getuid');
    const restore = () => {
      if (original) Object.defineProperty(process, 'getuid', original);
    };

    it('throws instead of skipping the owner checks when no uid is known', () => {
      const base = mkdtempSync(join(tmpdir(), 'smrt-state-identity-'));
      mkdirSync(join(base, 'src'));
      Object.defineProperty(process, 'getuid', {
        value: undefined,
        configurable: true,
      });
      try {
        expect(() =>
          prepareApplicationStateRoot({
            appId: 'myapp',
            dataDirectory: join(base, 'data'),
            sourceRoot: join(base, 'src'),
            platformName: 'linux',
            environment: { XDG_STATE_HOME: join(base, 'state') },
            homeDirectory: base,
          }),
        ).toThrow(/numeric current-user identity/);
      } finally {
        restore();
        rmSync(base, { recursive: true, force: true });
      }
    });
  });
});

const DATABASE = `${ROOT}\\application.sqlite`;
const FINAL_MARKER = `${ROOT}\\.smrt-local-runtime-myapp`;
const PENDING_MARKER = `${FINAL_MARKER}.pending`;

type SecureFileArgument = {
  secureFile: {
    driver: string;
    custody: string;
    root: string;
    windowsCustody?: { verify: (paths: readonly string[]) => Promise<void> };
  };
  cache?: boolean;
};

/**
 * Stand in for `@happyvertical/sql`'s secure SQLite open on win32: run the
 * caller's `verify` over the root-to-parent chain, create the database file
 * the way the SDK does (exclusive create, inheriting the parent's DACL), then
 * run `verify` again with the leaf appended. Records what it was given.
 */
function fakeSdkOpen(
  machine: FakeWindowsMachine,
  hooks: { beforeVerify?: () => void } = {},
) {
  const opened: SecureFileArgument[] = [];
  const close = vi.fn(async () => undefined);
  sqlMock.getDatabase.mockImplementation(async (config: SecureFileArgument) => {
    opened.push(config);
    const verify = config.secureFile.windowsCustody?.verify;
    if (!verify) throw new Error('windowsCustody.verify was not passed.');
    const chain = windowsPathComponents(ROOT);
    hooks.beforeVerify?.();
    await verify(chain);
    if (!machine.node(DATABASE)) {
      machine.runtime().openFile(DATABASE, 'create').close();
    }
    await verify([...chain, DATABASE]);
    return { close };
  });
  return { opened, close };
}

describe('database acquisition works through windowsCustody.verify', () => {
  it('passes the verifier to the SDK and promotes the markers', async () => {
    const machine = FakeWindowsMachine.standard();
    const { opened, close } = fakeSdkOpen(machine);
    const paths = await onWindows(machine, () =>
      prepareLocalDatabaseStorage(windowsOptions()),
    );
    expect(paths.database).toBe(DATABASE);
    expect(opened).toHaveLength(1);
    expect(opened[0]?.secureFile).toMatchObject({
      driver: 'node:sqlite',
      custody: 'trusted-parent',
      root: ROOT,
    });
    expect(typeof opened[0]?.secureFile.windowsCustody?.verify).toBe(
      'function',
    );
    expect(close).toHaveBeenCalledTimes(1);
    // The data root was created private, the pending marker promoted.
    expect(machine.exists(ROOT)).toBe(true);
    expect(machine.exists(FINAL_MARKER)).toBe(true);
    expect(machine.exists(PENDING_MARKER)).toBe(false);
    expect(machine.locks.map((lock) => lock.path)).toContain(ROOT);
    // The rule saw the database file itself (the second verify pass).
    expect(machine.inspections.some((paths) => paths.includes(DATABASE))).toBe(
      true,
    );
  });

  it('applies the unchanged custodied rule to the chain and the file', async () => {
    const machine = FakeWindowsMachine.standard();
    const verify = createWindowsDatabaseVerifier(machine.runtime(), {
      custodyRoot: ROOT,
      database: DATABASE,
    });
    const rt = machine.runtime();
    preparePrivateWindowsTree(rt, { directory: ROOT });
    const chain = windowsPathComponents(ROOT);
    expect(() => verify(chain)).not.toThrow();
    rt.openFile(DATABASE, 'create').close();
    expect(() => verify([...chain, DATABASE])).not.toThrow();
    // A second hard link on the database is refused, not reported false.
    machine.at(DATABASE).nlink = 2n;
    expect(() => verify([...chain, DATABASE])).toThrow(/exactly one link/);
    machine.at(DATABASE).nlink = 1n;
    // Another principal's access on the database is refused.
    machine.at(DATABASE).sddl = SDDL.readable;
    expect(() => verify([...chain, DATABASE])).toThrow(LocalRuntimeError);
    machine.at(DATABASE).sddl = SDDL.userPrivate();
    // A reparse point on the root is refused.
    machine.at(ROOT).attributes = 0x10 | 0x400;
    expect(() => verify(chain)).toThrow(/reparse point/);
  });

  it('refuses a chain that is not the database chain', () => {
    const machine = FakeWindowsMachine.standard();
    const rt = machine.runtime();
    preparePrivateWindowsTree(rt, { directory: ROOT });
    const verify = createWindowsDatabaseVerifier(rt, {
      custodyRoot: ROOT,
      database: DATABASE,
    });
    const chain = windowsPathComponents(ROOT);
    const message = /unexpected path chain/;
    expect(() => verify([])).toThrow(message);
    expect(() => verify(chain.slice(0, -1))).toThrow(message);
    expect(() => verify([...chain.slice(0, -1), `${LOCAL}\\Other`])).toThrow(
      message,
    );
    expect(() => verify([...chain, `${ROOT}\\other.sqlite`])).toThrow(message);
    expect(() => verify([...chain, DATABASE, DATABASE])).toThrow(message);
    // Case differences are the same NTFS path.
    expect(() => verify(chain.map((p) => p.toUpperCase()))).not.toThrow();
  });

  it('throws before data is read when the rule fails, and cleans up', async () => {
    const machine = FakeWindowsMachine.standard();
    const { opened, close } = fakeSdkOpen(machine, {
      // Access is widened between the data root's creation and the open.
      beforeVerify: () => {
        machine.at(ROOT).sddl = SDDL.readable;
      },
    });
    await expect(
      onWindows(machine, () => prepareLocalDatabaseStorage(windowsOptions())),
    ).rejects.toBeInstanceOf(LocalRuntimeError);
    expect(opened).toHaveLength(1);
    // No database was handed back, so nothing could be read or closed.
    expect(close).not.toHaveBeenCalled();
    expect(machine.exists(DATABASE)).toBe(false);
    // The directory and marker this attempt created are removed again.
    expect(machine.exists(PENDING_MARKER)).toBe(false);
    expect(machine.exists(ROOT)).toBe(false);
  });

  it('refuses an unsafe existing data root before the SDK is called', async () => {
    const machine = FakeWindowsMachine.standard();
    machine.dir(ROOT, SDDL.readable);
    const { opened } = fakeSdkOpen(machine);
    await expect(
      onWindows(machine, () => prepareLocalDatabaseStorage(windowsOptions())),
    ).rejects.toBeInstanceOf(LocalRuntimeError);
    expect(opened).toHaveLength(0);
  });

  it('opens the token store with the verifier after validating the root', async () => {
    const machine = FakeWindowsMachine.standard();
    storedRoot(machine);
    sqlMock.getDatabase.mockRejectedValue(new Error('stop after the call'));
    await expect(
      onWindows(machine, () => openLocalMcpTokenStore(windowsOptions())),
    ).rejects.toThrow('stop after the call');
    expect(machine.inspections).toHaveLength(1);
    const config = sqlMock.getDatabase.mock.calls[0]?.[0] as SecureFileArgument;
    expect(config.cache).toBe(false);
    expect(config.secureFile.root).toBe(ROOT);
    expect(typeof config.secureFile.windowsCustody?.verify).toBe('function');
  });

  it('wires the verifier into the SvelteKit runtime database config only on win32', () => {
    const machine = FakeWindowsMachine.standard();
    const paths = { root: ROOT, database: DATABASE };
    const onWin = runWithCustodyContext(
      { platform: 'win32', windows: machine.runtime() },
      () => windowsSecureFileCustody(paths),
    );
    expect(typeof onWin.windowsCustody?.verify).toBe('function');
    for (const name of ['linux', 'darwin'] as const) {
      const other = runWithCustodyContext(
        { platform: name, windows: machine.runtime() },
        () => windowsSecureFileCustody(paths),
      );
      expect(other).toEqual({});
      expect('windowsCustody' in other).toBe(false);
    }
  });

  it('no longer refuses initializeLocalApplicationRuntime or localRuntime()', async () => {
    const machine = FakeWindowsMachine.standard();
    const { opened } = fakeSdkOpen(machine);
    // The pipeline runs past acquisition (the first thing it does that the
    // old refusal blocked); what follows needs the real installation files.
    await onWindows(machine, () =>
      initializeLocalApplicationRuntime(windowsOptions()),
    ).catch(() => undefined);
    expect(opened).toHaveLength(1);

    const machine2 = FakeWindowsMachine.standard();
    const acquireWriterLease = vi.fn();
    const initializeLocal = vi.fn().mockRejectedValue(new Error('stop'));
    const runtime = composeSmrtSvelteKitRuntime(
      {
        appId: 'myapp',
        dataDirectory: ROOT,
        sourceRoot: SOURCE,
        runtime: resolveApplicationRuntime({ profile: 'local' }),
        env: { ...ENV, NODE_ENV: 'development' },
        acquireWriterLease,
      },
      { initializeLocal: initializeLocal as never },
    );
    await expect(
      onWindows(machine2, () => runtime.localRuntime()),
    ).rejects.toThrow('stop');
    expect(acquireWriterLease).toHaveBeenCalledTimes(1);
    expect(initializeLocal).toHaveBeenCalledTimes(1);
  });
});

describe('application secret and filesystem preparation on Windows', () => {
  const SECRETS = `${ROOT}\\secrets`;
  const SECRET = `${SECRETS}\\application.secret`;

  function preparedRoot() {
    const machine = FakeWindowsMachine.standard();
    preparePrivateWindowsTree(machine.runtime(), { directory: SECRETS });
    return machine;
  }

  it('creates the secret through a temporary file and a hard link', async () => {
    const machine = preparedRoot();
    const created = await onWindows(machine, () =>
      ensureApplicationSecret(SECRET, SOURCE),
    );
    expect(created).toBe(true);
    const secret = await onWindows(machine, () =>
      validateApplicationSecret(SECRET, SOURCE),
    );
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}\n$/);
    // One name left: the temporary file is gone and the link count is back.
    expect(machine.at(SECRET).nlink).toBe(1n);
    expect(
      machine.operations.filter((op) => op.startsWith('unlink')),
    ).toHaveLength(1);
    // A second call keeps the existing secret and reports it was not new.
    const again = await onWindows(machine, () =>
      ensureApplicationSecret(SECRET, SOURCE),
    );
    expect(again).toBe(false);
    expect(
      await onWindows(machine, () => validateApplicationSecret(SECRET, SOURCE)),
    ).toBe(secret);
  });

  it.each([
    [
      'a second hard link',
      (m: FakeWindowsMachine) => (m.at(SECRET).nlink = 2n),
    ],
    [
      'another principal with access',
      (m: FakeWindowsMachine) => (m.at(SECRET).sddl = SDDL.readable),
    ],
    [
      'a truncated value',
      (m: FakeWindowsMachine) => {
        m.at(SECRET).content = 'short\n';
        m.at(SECRET).size = 44n;
      },
    ],
  ])('refuses a secret with %s', async (_name, damage) => {
    const machine = preparedRoot();
    await onWindows(machine, () => ensureApplicationSecret(SECRET, SOURCE));
    damage(machine);
    await expect(
      onWindows(machine, () => validateApplicationSecret(SECRET, SOURCE)),
    ).rejects.toBeInstanceOf(LocalRuntimeError);
  });

  it('refuses a missing secret as missing', async () => {
    const machine = preparedRoot();
    await expect(
      onWindows(machine, () => validateApplicationSecret(SECRET, SOURCE)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('prepares the assets and secrets directories privately', async () => {
    const machine = FakeWindowsMachine.standard();
    preparePrivateWindowsTree(machine.runtime(), { directory: ROOT });
    const paths = resolveLocalRuntimePaths(windowsOptions());
    // The directories are made before anything touches the real filesystem.
    await onWindows(machine, () =>
      prepareLocalFilesystem(paths, SOURCE, {} as never, windowsOptions()),
    ).catch(() => undefined);
    expect(machine.exists(paths.assets)).toBe(true);
    expect(machine.exists(paths.secrets)).toBe(true);
    expect(machine.locks.map((lock) => lock.path)).toEqual(
      expect.arrayContaining([paths.assets, paths.secrets]),
    );
  });
});
