import { describe, expect, it } from 'vitest';
import {
  CLIENT_FAILURE_CODES,
  failureCodeFromSupervisorMessage,
  isRendezvousFailureCode,
  isShellFailureCode,
  SHELL_FAILURE_CODES,
} from './failure-code.js';

describe('failure codes', () => {
  it('keeps shell and client codes disjoint and closed', () => {
    for (const code of SHELL_FAILURE_CODES) {
      expect(CLIENT_FAILURE_CODES).not.toContain(code);
      expect(isShellFailureCode(code)).toBe(true);
      expect(isRendezvousFailureCode(code)).toBe(true);
    }
    for (const code of CLIENT_FAILURE_CODES) {
      expect(isShellFailureCode(code)).toBe(false);
      expect(isRendezvousFailureCode(code)).toBe(true);
    }
    expect(isRendezvousFailureCode('nope')).toBe(false);
    expect(isRendezvousFailureCode(undefined)).toBe(false);
  });

  // The supervisor texts are produced by `FailureKind::describe` and the
  // `Failed(...)` call sites in shell/src/supervisor.rs.
  it.each([
    [
      'another process holds the data directory writer lease or operation lock',
      'lease_held',
    ],
    [
      'another process holds the data directory writer lease or operation lock; gave up after 3 restarts',
      'lease_held',
    ],
    [
      'the selected port was taken; gave up after 3 restarts',
      'port_unavailable',
    ],
    ['could not select a loopback port (AddrNotAvailable)', 'port_unavailable'],
    ['could not start the sidecar (NotFound)', 'sidecar_missing'],
    [
      'the sidecar did not become healthy (timed out); gave up after 3 restarts',
      'health_failed',
    ],
    [
      'the health route redirects (HTTP 302), which is not allowed',
      'health_failed',
    ],
    [
      'the sidecar exited (code 1); gave up after 3 restarts',
      'restart_exhausted',
    ],
    [
      'the sidecar could not be stopped (timed out); quit and relaunch the app',
      'stop_unconfirmed',
    ],
    ['internal supervisor error; quit and relaunch the app', 'internal_error'],
    ['the data directory path is not valid Unicode', 'unknown'],
    ['', 'unknown'],
  ])('maps %j to %s', (message, code) => {
    expect(failureCodeFromSupervisorMessage(message)).toBe(code);
  });
});
