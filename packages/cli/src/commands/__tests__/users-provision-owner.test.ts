import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { requireCommandHandler } from '../../__tests__/command-handler.js';
import {
  readOperatorPassword,
  usersProvisionOwnerCommand,
} from '../users-provision-owner.js';

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe('operator password input', () => {
  it('reads a bounded single UTF-8 password without logging it', async () => {
    expect(
      await readOperatorPassword(Readable.from(['a private ', 'password\r\n'])),
    ).toBe('a private password');
    for (const bytes of [
      '',
      'one\ntwo',
      'a'.repeat(4097),
      Buffer.from([0xff]),
    ]) {
      await expect(
        readOperatorPassword(Readable.from([bytes])),
      ).rejects.toThrow();
    }
  });

  it('has no password argv option and rejects unknown options with fixed diagnostics', async () => {
    expect(usersProvisionOwnerCommand.options).not.toHaveProperty('password');
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await requireCommandHandler(usersProvisionOwnerCommand)([], {
      password: 'do-not-log-this',
    });
    expect(process.exitCode).toBe(1);
    expect(error.mock.calls.flat().join(' ')).not.toContain('do-not-log-this');
    expect(error).toHaveBeenCalledWith(
      'Owner provisioning refused. Check the operator input and private database configuration.',
    );
  });
});
