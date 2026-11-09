/**
 * Locking a directory the runtime itself just created (smrt#4843).
 *
 * A directory created under `%LOCALAPPDATA%` inherits whatever the profile
 * grants, and another tool may have added a group there. The runtime therefore
 * does not depend on inheritance for the directories it owns: right after it
 * creates one it disables inheritance and replaces the DACL with exactly three
 * allow entries (current user, SYSTEM, Administrators), each with full control
 * and object plus container inheritance. The custody rule itself is unchanged;
 * the new directory is still verified by the inspector afterwards.
 *
 * `icacls.exe` is used rather than PowerShell `Set-Acl`: it is a single small
 * binary, its argv is a fixed array (the path is exactly one element, so there
 * is no parser and no string-built command), and `/inheritance:r` plus
 * `/grant:r` with `*<SID>` trustees expresses the whole DACL without any
 * account-name lookup (names are localised and may be ambiguous). The same
 * discipline as the inspector applies: absolute executable under `SystemRoot`,
 * `shell: false`, hidden window, allow-listed environment without `PATH`,
 * bounded time and output, and every failure is a refusal.
 */

import { execFileSync } from 'node:child_process';
import { win32 } from 'node:path';
import { unsafeFilesystemEntry } from './local-runtime-error.js';
import {
  buildAllowListedEnvironment,
  type InspectorExec,
  lookupWindowsEnvironment,
} from './windows-acl-inspector.js';
import { validateWindowsPath } from './windows-paths.js';
import { SID_ADMINISTRATORS, SID_SYSTEM } from './windows-sddl.js';

/** Replace the DACL of a freshly created directory. Synchronous, throws. */
export type WindowsDirectoryLocker = (path: string, userSid: string) => void;

const LOCK_TIMEOUT_MS = 10_000;
const LOCK_MAX_BUFFER = 64 * 1024;
const SID_TEXT = /^S-1-\d+(?:-\d+){1,15}$/;
/** Full control, inherited by files (OI) and subdirectories (CI). */
const FULL_CONTROL_INHERITED = '(OI)(CI)F';

/**
 * The fixed argv. Only `path` and `userSid` vary, each as one whole element:
 * `icacls <path> /inheritance:r /grant:r *<user>:(OI)(CI)F
 * *S-1-5-18:(OI)(CI)F *S-1-5-32-544:(OI)(CI)F`.
 */
export function buildIcaclsLockArgv(path: string, userSid: string): string[] {
  // icacls expands `*` and `?` in the file name; W1 already forbids both in a
  // path and `validateWindowsPath` below re-checks, so a path reaching here is
  // a literal name that starts with a drive letter (never an option).
  if (path.includes('*') || path.includes('?')) {
    throw unsafeFilesystemEntry(
      `Cannot lock a directory whose name contains a wildcard: ${path}`,
    );
  }
  if (validateWindowsPath(path, 'Local runtime directory') !== path) {
    throw unsafeFilesystemEntry(
      `Local runtime directory is not in canonical Windows form: ${path}`,
    );
  }
  if (!SID_TEXT.test(userSid)) {
    throw unsafeFilesystemEntry('Current-user identity is not a SID.');
  }
  return [
    path,
    '/inheritance:r',
    '/grant:r',
    `*${userSid}:${FULL_CONTROL_INHERITED}`,
    `*${SID_SYSTEM}:${FULL_CONTROL_INHERITED}`,
    `*${SID_ADMINISTRATORS}:${FULL_CONTROL_INHERITED}`,
  ];
}

/** `<SystemRoot>\System32\icacls.exe`, by absolute path. */
export function icaclsExecutable(env: NodeJS.ProcessEnv): string {
  const root = lookupWindowsEnvironment(env, 'SystemRoot');
  if (root === undefined) {
    throw unsafeFilesystemEntry(
      'SystemRoot is not set, so icacls.exe cannot be located to lock the new directory.',
    );
  }
  return win32.join(
    validateWindowsPath(root, 'SystemRoot'),
    'System32',
    'icacls.exe',
  );
}

export interface IcaclsLockerOptions {
  exec?: InspectorExec;
  env?: NodeJS.ProcessEnv;
}

/** The production locker. Any failure, including a timeout, throws. */
export function createIcaclsDirectoryLocker(
  options: IcaclsLockerOptions = {},
): WindowsDirectoryLocker {
  const exec: InspectorExec =
    options.exec ??
    ((file, args, execOptions) =>
      execFileSync(file, [...args], execOptions) as unknown as string);
  return (path, userSid) => {
    const parent = options.env ?? process.env;
    const file = icaclsExecutable(parent);
    const args = buildIcaclsLockArgv(path, userSid);
    try {
      exec(file, args, {
        env: buildAllowListedEnvironment(parent),
        encoding: 'utf8',
        timeout: LOCK_TIMEOUT_MS,
        maxBuffer: LOCK_MAX_BUFFER,
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      // A non-zero exit, a timeout, an output overflow or a missing or blocked
      // icacls.exe all land here. The directory stays inheritance-controlled,
      // so the caller removes it.
      throw unsafeFilesystemEntry(
        `Could not restrict the new directory to the current user, SYSTEM and Administrators with icacls.exe: ${path}`,
        error,
      );
    }
  };
}
