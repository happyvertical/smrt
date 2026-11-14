import { randomBytes } from 'node:crypto';
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createKeychainVaultKeyStore,
  createLinuxSecretServiceKeychain,
  createMacOsKeychain,
  createPlatformKeychain,
  createWindowsCredentialKeychain,
  defaultKeychainCommandRunner,
  type KeychainCommand,
  type KeychainCommandRunner,
  KeychainOperationError,
  KeychainUnavailableError,
  type OsKeychain,
} from './keychain-vault-key-store.js';
import { createFileVaultKeyStore } from './vault-key-store.js';

// Nothing here touches a real keychain: every keychain is an in-memory fake
// or a fake command runner holding throwaway random values.

function fakeKeychain() {
  const items = new Map<string, Uint8Array>();
  const calls = { get: 0, set: 0, delete: 0 };
  const keychain: OsKeychain = {
    async get(service, account) {
      calls.get += 1;
      const value = items.get(`${service}|${account}`);
      return value ? new Uint8Array(value) : null;
    },
    async set(service, account, secret) {
      calls.set += 1;
      items.set(`${service}|${account}`, new Uint8Array(secret));
    },
    async delete(service, account) {
      calls.delete += 1;
      items.delete(`${service}|${account}`);
    },
  };
  return { items, calls, keychain };
}

describe('keychain-wrapped vault key store', () => {
  let root: string;
  let sealed: string;
  let plain: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'smrt-keychain-store-'));
    sealed = join(root, 'sealed');
    plain = join(root, 'plain');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function store(
    keychain: OsKeychain | null,
    productId = 'lolaus',
  ): ReturnType<typeof createKeychainVaultKeyStore> {
    return createKeychainVaultKeyStore({
      productId,
      directory: sealed,
      fallbackDirectory: plain,
      keychain,
    });
  }

  it('seals items under a keychain key that is created once and reused', async () => {
    const fake = fakeKeychain();
    const first = store(fake.keychain);
    const value = new Uint8Array(randomBytes(40));
    expect(await first.get('device-secret')).toBeNull();
    await first.set('device-secret', value);
    expect(await first.get('device-secret')).toEqual(value);
    expect(await first.custody()).toEqual({ kind: 'os-keychain' });

    expect([...fake.items.keys()]).toEqual([
      'smrt-vault.lolaus|vault-key-encryption-key',
    ]);
    expect(fake.calls.set).toBe(1);
    const onDisk = readFileSync(join(sealed, 'device-secret'));
    expect(onDisk.includes(Buffer.from(value))).toBe(false);
    expect(onDisk.length).toBe(1 + 12 + value.length + 16);

    // A restart (new instance, same keychain) reads the same items.
    const second = store(fake.keychain);
    expect(await second.get('device-secret')).toEqual(value);
    expect(fake.calls.set).toBe(1);

    // Sealing is randomized per write.
    await first.set('device-secret', value);
    expect(readFileSync(join(sealed, 'device-secret')).equals(onDisk)).toBe(
      false,
    );
    expect(readdirSync(sealed)).toEqual(['device-secret']);

    await first.delete('device-secret');
    expect(await first.get('device-secret')).toBeNull();
  });

  it('rejects tampering, version changes, truncation and moved items', async () => {
    const fake = fakeKeychain();
    const keys = store(fake.keychain);
    await keys.set('alpha', new Uint8Array(randomBytes(32)));
    await keys.set('beta', new Uint8Array(randomBytes(32)));
    const original = readFileSync(join(sealed, 'alpha'));

    for (const index of [0, 5, 20, original.length - 1]) {
      const bad = Buffer.from(original);
      bad[index] ^= 0x01;
      writeFileSync(join(sealed, 'alpha'), bad, { mode: 0o600 });
      await expect(keys.get('alpha')).rejects.toThrow('integrity');
    }
    writeFileSync(join(sealed, 'alpha'), original.subarray(0, 20), {
      mode: 0o600,
    });
    await expect(keys.get('alpha')).rejects.toThrow('integrity');

    // An item copied under another name no longer authenticates.
    writeFileSync(join(sealed, 'alpha'), original, { mode: 0o600 });
    expect(await keys.get('alpha')).not.toBeNull();
    writeFileSync(join(sealed, 'beta'), original, { mode: 0o600 });
    await expect(keys.get('beta')).rejects.toThrow('integrity');
  });

  it('binds items to the product id even under a shared key', async () => {
    const shared = new Uint8Array(randomBytes(32));
    const sameKey: OsKeychain = {
      get: async () => new Uint8Array(shared),
      set: async () => undefined,
      delete: async () => undefined,
    };
    const a = store(sameKey, 'product-a');
    const b = store(sameKey, 'product-b');
    await a.set('item', new Uint8Array([1, 2, 3]));
    await expect(b.get('item')).rejects.toThrow('integrity');
  });

  it('validates item names and values', async () => {
    const keys = store(fakeKeychain().keychain);
    for (const name of ['', '../x', 'A', 'a/b', '.hidden', 'a'.repeat(129)]) {
      await expect(keys.get(name)).rejects.toThrow('Invalid vault key store');
      await expect(keys.set(name, new Uint8Array(1))).rejects.toThrow(
        'Invalid vault key store',
      );
      await expect(keys.delete(name)).rejects.toThrow(
        'Invalid vault key store',
      );
    }
    await expect(keys.set('ok', 'text' as never)).rejects.toThrow('Invalid');
    await expect(keys.set('big', new Uint8Array(1024 * 1024))).rejects.toThrow(
      'Invalid',
    );
    expect(() => store(fakeKeychain().keychain, 'Bad Id')).toThrow(
      'product id',
    );
  });

  it('keeps sealed items in an owner-only directory', async () => {
    const keys = store(fakeKeychain().keychain);
    await keys.set('item', new Uint8Array([9]));
    const { statSync } = await import('node:fs');
    expect(statSync(sealed).mode & 0o777).toBe(0o700);
    expect(statSync(join(sealed, 'item')).mode & 0o777).toBe(0o600);
  });

  it('falls back to the file store, observably, when there is no keychain', async () => {
    for (const keychain of [
      null,
      {
        get: async () => {
          throw new KeychainUnavailableError();
        },
        set: async () => undefined,
        delete: async () => undefined,
      } satisfies OsKeychain,
    ]) {
      rmSync(plain, { recursive: true, force: true });
      const keys = store(keychain);
      await keys.set('device-secret', new Uint8Array([7, 7]));
      expect(await keys.custody()).toEqual({
        kind: 'file-fallback',
        reason: 'keychain-unavailable',
      });
      // Exactly the plain file store's bytes, outside the sealed directory.
      expect(await createFileVaultKeyStore(plain).get('device-secret')).toEqual(
        new Uint8Array([7, 7]),
      );
    }
    expect(() => readdirSync(sealed)).toThrow();
  });

  it('keeps an existing file store rather than orphaning it', async () => {
    const fileStore = createFileVaultKeyStore(plain);
    await fileStore.set('device-secret', new Uint8Array([4]));
    const fake = fakeKeychain();
    const keys = store(fake.keychain);
    expect(await keys.get('device-secret')).toEqual(new Uint8Array([4]));
    expect(await keys.custody()).toEqual({
      kind: 'file-fallback',
      reason: 'existing-file-items',
    });
    expect(fake.calls.set).toBe(0);
  });

  it('fails closed when sealed items exist without a usable key', async () => {
    const fake = fakeKeychain();
    await store(fake.keychain).set('device-secret', new Uint8Array([1]));
    fake.items.clear();
    const setBefore = fake.calls.set;

    // Key missing: never create a replacement.
    const missing = store(fake.keychain);
    await expect(missing.get('device-secret')).rejects.toThrow('missing');
    await expect(missing.set('x', new Uint8Array(1))).rejects.toThrow();
    expect(fake.calls.set).toBe(setBefore);

    // Keychain unreachable: never fall back to a file store.
    await expect(store(null).get('device-secret')).rejects.toThrow(
      'sealed vault items exist',
    );
    expect(() => readdirSync(plain)).toThrow();
  });

  it('fails closed on an unreadable or malformed key instead of falling back', async () => {
    const failing = store({
      get: async () => {
        throw new KeychainOperationError();
      },
      set: async () => undefined,
      delete: async () => undefined,
    });
    await expect(failing.set('item', new Uint8Array(1))).rejects.toThrow(
      'could not be read',
    );
    expect(() => readdirSync(plain)).toThrow();

    const short = fakeKeychain();
    short.items.set(
      'smrt-vault.lolaus|vault-key-encryption-key',
      new Uint8Array(5),
    );
    await expect(store(short.keychain).get('item')).rejects.toThrow(
      'malformed',
    );
  });

  it('refuses a key the keychain did not retain', async () => {
    const forgetful: OsKeychain = {
      get: async () => null,
      set: async () => undefined,
      delete: async () => undefined,
    };
    await expect(store(forgetful).get('item')).rejects.toThrow('retain');
  });

  it('retries resolution after a failure', async () => {
    const fake = fakeKeychain();
    let broken = true;
    const flaky: OsKeychain = {
      get: async (s, a) => {
        if (broken) throw new KeychainOperationError();
        return fake.keychain.get(s, a);
      },
      set: fake.keychain.set,
      delete: fake.keychain.delete,
    };
    const keys = store(flaky);
    await expect(keys.get('item')).rejects.toThrow();
    broken = false;
    await keys.set('item', new Uint8Array([3]));
    expect(await keys.get('item')).toEqual(new Uint8Array([3]));
  });
});

/** A fake OS tool behind a fake runner; records what it was given. */
function toolHarness(
  behaviour: (command: KeychainCommand) => {
    code: number;
    stdout?: string;
    stderr?: string;
  },
) {
  const commands: KeychainCommand[] = [];
  const runner: KeychainCommandRunner = async (command) => {
    commands.push(command);
    const result = behaviour(command);
    return {
      code: result.code,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    };
  };
  return { commands, runner };
}

function secret(): { bytes: Uint8Array; hex: string } {
  const bytes = new Uint8Array(randomBytes(32));
  return { bytes, hex: Buffer.from(bytes).toString('hex') };
}

function expectNoSecretInArgv(commands: KeychainCommand[], hex: string): void {
  for (const command of commands) {
    expect(command.file).not.toContain(hex);
    for (const argument of command.args) expect(argument).not.toContain(hex);
  }
}

describe('macOS keychain primitive', () => {
  it('writes through `security -i` stdin and reads through stdout', async () => {
    const { bytes, hex } = secret();
    let held: string | null = null;
    const { commands, runner } = toolHarness((command) => {
      if (command.args[0] === '-i') {
        held = /-w (\S+)\n$/.exec(command.input ?? '')?.[1] ?? null;
        return { code: 0 };
      }
      if (command.args[0] === 'find-generic-password') {
        return held === null ? { code: 44 } : { code: 0, stdout: `${held}\n` };
      }
      return { code: 0 };
    });
    const keychain = createMacOsKeychain(runner);
    expect(await keychain.get('smrt-vault.app', 'kek')).toBeNull();
    await keychain.set('smrt-vault.app', 'kek', bytes);
    expect(await keychain.get('smrt-vault.app', 'kek')).toEqual(bytes);
    await keychain.delete('smrt-vault.app', 'kek');

    expect(commands.map((c) => c.file)).toEqual(
      Array(4).fill('/usr/bin/security'),
    );
    expect(commands[0].args).toEqual([
      'find-generic-password',
      '-s',
      'smrt-vault.app',
      '-a',
      'kek',
      '-w',
    ]);
    expect(commands[1].args).toEqual(['-i']);
    expect(commands[1].input).toBe(
      `add-generic-password -U -s smrt-vault.app -a kek -w ${hex}\n`,
    );
    expect(commands[3].args.slice(0, 1)).toEqual(['delete-generic-password']);
    expectNoSecretInArgv(commands, hex);
  });

  it('reports fixed errors and tolerates deleting a missing item', async () => {
    const failing = createMacOsKeychain(
      toolHarness(() => ({ code: 1, stderr: 'secret-path /x' })).runner,
    );
    for (const call of [
      () => failing.get('s', 'a'),
      () => failing.set('s', 'a', new Uint8Array(32)),
      () => failing.delete('s', 'a'),
    ]) {
      const error = await call().then(
        () => null,
        (e: Error) => e,
      );
      expect(error).toBeInstanceOf(KeychainOperationError);
      expect(error?.message).toBe('The OS keychain operation failed');
    }
    const absent = createMacOsKeychain(
      toolHarness(() => ({ code: 44 })).runner,
    );
    await expect(absent.delete('s', 'a')).resolves.toBeUndefined();
    const garbage = createMacOsKeychain(
      toolHarness(() => ({ code: 0, stdout: 'not hex!' })).runner,
    );
    await expect(garbage.get('s', 'a')).rejects.toBeInstanceOf(
      KeychainOperationError,
    );
    await expect(failing.get('bad name', 'a')).rejects.toBeInstanceOf(
      KeychainOperationError,
    );
  });

  it('reports a missing tool as unavailable', async () => {
    const keychain = createMacOsKeychain(async () => {
      throw Object.assign(new Error('x'), { code: 'ENOENT' });
    });
    await expect(keychain.get('s', 'a')).rejects.toBeInstanceOf(
      KeychainUnavailableError,
    );
  });
});

describe('Linux Secret Service primitive', () => {
  it('stores through stdin and looks up through stdout', async () => {
    const { bytes, hex } = secret();
    let held: string | undefined;
    const { commands, runner } = toolHarness((command) => {
      if (command.args[0] === 'store') {
        held = command.input;
        return { code: 0 };
      }
      if (command.args[0] === 'lookup') {
        return held === undefined ? { code: 1 } : { code: 0, stdout: held };
      }
      held = undefined;
      return { code: 0 };
    });
    const keychain = createLinuxSecretServiceKeychain(runner);
    expect(await keychain.get('smrt-vault.app', 'kek')).toBeNull();
    await keychain.set('smrt-vault.app', 'kek', bytes);
    expect(await keychain.get('smrt-vault.app', 'kek')).toEqual(bytes);
    await keychain.delete('smrt-vault.app', 'kek');
    expect(await keychain.get('smrt-vault.app', 'kek')).toBeNull();

    expect(commands[0]).toMatchObject({
      file: 'secret-tool',
      args: ['lookup', 'service', 'smrt-vault.app', 'account', 'kek'],
    });
    expect(commands[1].args).toEqual([
      'store',
      '--label=smrt-vault.app',
      'service',
      'smrt-vault.app',
      'account',
      'kek',
    ]);
    expect(commands[1].input).toBe(hex);
    expectNoSecretInArgv(commands, hex);
  });

  it('treats a bus or daemon failure as unavailable, never as not found', async () => {
    const noBus = createLinuxSecretServiceKeychain(
      toolHarness(() => ({ code: 1, stderr: 'Cannot autolaunch D-Bus' }))
        .runner,
    );
    await expect(noBus.get('s', 'a')).rejects.toBeInstanceOf(
      KeychainUnavailableError,
    );
    await expect(
      noBus.set('s', 'a', new Uint8Array(32)),
    ).rejects.toBeInstanceOf(KeychainUnavailableError);
    await expect(noBus.delete('s', 'a')).rejects.toBeInstanceOf(
      KeychainUnavailableError,
    );
    const missingTool = createLinuxSecretServiceKeychain(async () => {
      throw Object.assign(new Error('x'), { code: 'ENOENT' });
    });
    await expect(missingTool.get('s', 'a')).rejects.toBeInstanceOf(
      KeychainUnavailableError,
    );
  });
});

describe('Windows Credential Manager primitive', () => {
  it('passes a secret-free script and the secret only on stdin and stdout', async () => {
    const { bytes, hex } = secret();
    let held: string | undefined;
    const { commands, runner } = toolHarness((command) => {
      const script = Buffer.from(command.args[3], 'base64').toString('utf16le');
      if (script.includes('::Write(')) {
        held = command.input;
        return { code: 0 };
      }
      if (script.includes('::Read(')) {
        return held === undefined ? { code: 3 } : { code: 0, stdout: held };
      }
      held = undefined;
      return { code: 0 };
    });
    const keychain = createWindowsCredentialKeychain(runner, 'C:\\Windows');
    expect(await keychain.get('smrt-vault.app', 'kek')).toBeNull();
    await keychain.set('smrt-vault.app', 'kek', bytes);
    expect(await keychain.get('smrt-vault.app', 'kek')).toEqual(bytes);
    await keychain.delete('smrt-vault.app', 'kek');

    for (const command of commands) {
      expect(command.file).toBe(
        'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      );
      expect(command.args.slice(0, 3)).toEqual([
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
      ]);
      const script = Buffer.from(command.args[3], 'base64').toString('utf16le');
      expect(script).toContain("'smrt-vault.app/kek'");
      expect(script).toContain('CredReadW');
      expect(script).toContain('CredWriteW');
      expect(script).not.toContain(hex);
    }
    expect(commands[1].input).toBe(hex);
    expectNoSecretInArgv(commands, hex);
  });

  it('reports script failure with a fixed error', async () => {
    const keychain = createWindowsCredentialKeychain(
      toolHarness(() => ({ code: 1, stderr: 'C:\\secret\\path' })).runner,
    );
    const error = await keychain.get('s', 'a').then(
      () => null,
      (e: Error) => e,
    );
    expect(error).toBeInstanceOf(KeychainOperationError);
    expect(error?.message).not.toContain('secret');
  });
});

describe('platform selection and the default runner', () => {
  it('selects a primitive per platform', () => {
    expect(createPlatformKeychain('darwin')).not.toBeNull();
    expect(createPlatformKeychain('linux')).not.toBeNull();
    expect(createPlatformKeychain('win32')).not.toBeNull();
    expect(createPlatformKeychain('freebsd')).toBeNull();
  });

  it('feeds input on stdin, withholds the environment and never uses a shell', async () => {
    process.env.SMRT_TEST_PRIVATE_VALUE = 'throwaway-not-a-secret';
    try {
      const result = await defaultKeychainCommandRunner({
        file: process.execPath,
        args: [
          '-e',
          "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>process.stdout.write(JSON.stringify({d,e:Object.keys(process.env).includes('SMRT_TEST_PRIVATE_VALUE')})))",
          '$(echo shell)',
        ],
        input: 'from-stdin',
      });
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ d: 'from-stdin', e: false });
    } finally {
      delete process.env.SMRT_TEST_PRIVATE_VALUE;
    }
    await expect(
      defaultKeychainCommandRunner({
        file: join(tmpdir(), 'no-such-tool'),
        args: [],
      }),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
