import { spawn } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { lstat, mkdir, open, readdir, readFile, rm } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { errorCode } from './error-code.js';
import {
  assertVaultKeyStoreItemName,
  createFileVaultKeyStore,
  type FileVaultKeyStoreOptions,
  type VaultKeyStore,
} from './file-vault-key-store.js';
import {
  isStaleOperationLock,
  lockOwnerPid,
  processExists,
} from './operation-lock.js';
import { reclaimStaleRecord } from './stale-reclaim.js';

/**
 * One secret held by the operating system's credential store, addressed by a
 * service and an account name. The three real implementations drive the OS
 * tools with the secret on stdin or stdout only, never in argv, environment,
 * logs or URLs. Tests inject a fake and never touch a real keychain.
 */
export interface OsKeychain {
  get(service: string, account: string): Promise<Uint8Array | null>;
  set(service: string, account: string, secret: Uint8Array): Promise<void>;
  delete(service: string, account: string): Promise<void>;
}

/** The keychain, or the tool that fronts it, cannot be reached at all. */
export class KeychainUnavailableError extends Error {
  readonly code = 'keychain_unavailable';
  constructor() {
    super('The OS keychain is not available');
    this.name = 'KeychainUnavailableError';
  }
}

/** The keychain was reached but the operation failed. Fixed text, no output. */
export class KeychainOperationError extends Error {
  readonly code = 'keychain_operation_failed';
  constructor() {
    super('The OS keychain operation failed');
    this.name = 'KeychainOperationError';
  }
}

/** A command to run: an executable, argv with no secret, and optional stdin. */
export interface KeychainCommand {
  readonly file: string;
  readonly args: readonly string[];
  /** Secret-bearing input goes here and only here. */
  readonly input?: string;
}

export interface KeychainCommandResult {
  readonly code: number;
  readonly stdout: string;
  /** Only ever tested for emptiness; never surfaced or logged. */
  readonly stderr: string;
}

/**
 * Seam over `child_process`. It rejects with an error whose `code` is
 * `ENOENT` when the executable does not exist.
 */
export type KeychainCommandRunner = (
  command: KeychainCommand,
) => Promise<KeychainCommandResult>;

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SECRET_HEX = /^(?:[0-9a-f]{2})+$/;
const COMMAND_TIMEOUT_MS = 20_000;
const OUTPUT_LIMIT = 64 * 1024;
const ENVIRONMENT_ALLOWLIST = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'LANG',
  'DBUS_SESSION_BUS_ADDRESS',
  'XDG_RUNTIME_DIR',
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'SECURITYSESSIONID',
  'SystemRoot',
  'windir',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'TEMP',
  'TMP',
] as const;

function assertKeychainName(value: string): void {
  if (typeof value !== 'string' || !NAME.test(value)) {
    throw new KeychainOperationError();
  }
}

function toHex(secret: Uint8Array): string {
  return Buffer.from(secret).toString('hex');
}

function fromHex(text: string): Uint8Array {
  const trimmed = text.trim();
  if (!SECRET_HEX.test(trimmed)) throw new KeychainOperationError();
  return new Uint8Array(Buffer.from(trimmed, 'hex'));
}

/** Default runner: no shell, an allow-listed environment, bounded time and output. */
export const defaultKeychainCommandRunner: KeychainCommandRunner = (command) =>
  new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {};
    for (const key of ENVIRONMENT_ALLOWLIST) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
    const child = spawn(command.file, [...command.args], {
      env,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      settle();
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(() => reject(new KeychainOperationError()));
    }, COMMAND_TIMEOUT_MS);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (stdout.length < OUTPUT_LIMIT) stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < OUTPUT_LIMIT) stderr += chunk;
    });
    child.stdin.on('error', () => {
      // A tool that exits before reading its input is reported by its status.
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      finish(() =>
        reject(
          error.code === 'ENOENT' || error.code === 'EACCES'
            ? Object.assign(new Error('missing'), { code: 'ENOENT' })
            : new KeychainOperationError(),
        ),
      );
    });
    child.on('close', (code) => {
      finish(() => resolve({ code: code ?? -1, stdout, stderr }));
    });
    child.stdin.end(command.input ?? '');
  });

async function run(
  runner: KeychainCommandRunner,
  command: KeychainCommand,
): Promise<KeychainCommandResult> {
  try {
    return await runner(command);
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      (error as { code?: unknown }).code === 'ENOENT'
    ) {
      throw new KeychainUnavailableError();
    }
    throw new KeychainOperationError();
  }
}

const MACOS_SECURITY = '/usr/bin/security';
/** `security` exit status for errSecItemNotFound. */
const MACOS_NOT_FOUND = 44;

/**
 * macOS Keychain through `security`. The secret is written with
 * `security -i`, which reads the command from stdin, so it never reaches argv;
 * it is read back through stdout with `-w`. The stored value is the secret
 * hex-encoded.
 */
export function createMacOsKeychain(
  runner: KeychainCommandRunner = defaultKeychainCommandRunner,
): OsKeychain {
  return {
    async get(service, account) {
      assertKeychainName(service);
      assertKeychainName(account);
      const result = await run(runner, {
        file: MACOS_SECURITY,
        args: ['find-generic-password', '-s', service, '-a', account, '-w'],
      });
      if (result.code === MACOS_NOT_FOUND) return null;
      if (result.code !== 0) throw new KeychainOperationError();
      return fromHex(result.stdout);
    },
    async set(service, account, secret) {
      assertKeychainName(service);
      assertKeychainName(account);
      const result = await run(runner, {
        file: MACOS_SECURITY,
        args: ['-i'],
        input: `add-generic-password -U -s ${service} -a ${account} -w ${toHex(secret)}\n`,
      });
      if (result.code !== 0) throw new KeychainOperationError();
    },
    async delete(service, account) {
      assertKeychainName(service);
      assertKeychainName(account);
      const result = await run(runner, {
        file: MACOS_SECURITY,
        args: ['delete-generic-password', '-s', service, '-a', account],
      });
      if (result.code !== 0 && result.code !== MACOS_NOT_FOUND) {
        throw new KeychainOperationError();
      }
    },
  };
}

/**
 * Linux Secret Service (GNOME Keyring, KWallet) through `secret-tool`. `store`
 * reads the secret from stdin and `lookup` writes it to stdout. Without a
 * Secret Service on the session bus the tool exits non-zero with a message,
 * which is reported as unavailable so a headless host can fall back.
 */
export function createLinuxSecretServiceKeychain(
  runner: KeychainCommandRunner = defaultKeychainCommandRunner,
): OsKeychain {
  const attributes = (service: string, account: string) => [
    'service',
    service,
    'account',
    account,
  ];
  return {
    async get(service, account) {
      assertKeychainName(service);
      assertKeychainName(account);
      const result = await run(runner, {
        file: 'secret-tool',
        args: ['lookup', ...attributes(service, account)],
      });
      if (result.code === 0 && result.stdout.trim() !== '') {
        return fromHex(result.stdout);
      }
      if (result.stderr.trim() !== '') throw new KeychainUnavailableError();
      if (result.code === 0 || result.code === 1) return null;
      throw new KeychainOperationError();
    },
    async set(service, account, secret) {
      assertKeychainName(service);
      assertKeychainName(account);
      const result = await run(runner, {
        file: 'secret-tool',
        args: ['store', `--label=${service}`, ...attributes(service, account)],
        input: toHex(secret),
      });
      if (result.code !== 0) throw new KeychainUnavailableError();
    },
    async delete(service, account) {
      assertKeychainName(service);
      assertKeychainName(account);
      const result = await run(runner, {
        file: 'secret-tool',
        args: ['clear', ...attributes(service, account)],
      });
      if (result.code !== 0 && result.stderr.trim() !== '') {
        throw new KeychainUnavailableError();
      }
    },
  };
}

const WINDOWS_NOT_FOUND = 3;

const WINDOWS_CREDENTIAL_SOURCE = `
using System;
using System.Runtime.InteropServices;
public static class SmrtCredential {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct CREDENTIAL {
    public uint Flags; public uint Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize; public IntPtr CredentialBlob; public uint Persist;
    public uint AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredReadW(string target, uint type, uint flags, out IntPtr credential);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredWriteW(ref CREDENTIAL credential, uint flags);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredDeleteW(string target, uint type, uint flags);
  [DllImport("advapi32.dll")]
  static extern void CredFree(IntPtr buffer);
  public static string Read(string target) {
    IntPtr pointer;
    if (!CredReadW(target, 1, 0, out pointer)) {
      if (Marshal.GetLastWin32Error() == 1168) return null;
      throw new Exception("read");
    }
    try {
      CREDENTIAL credential = (CREDENTIAL)Marshal.PtrToStructure(pointer, typeof(CREDENTIAL));
      byte[] bytes = new byte[credential.CredentialBlobSize];
      Marshal.Copy(credential.CredentialBlob, bytes, 0, bytes.Length);
      return System.Text.Encoding.UTF8.GetString(bytes);
    } finally { CredFree(pointer); }
  }
  public static void Write(string target, string value) {
    byte[] bytes = System.Text.Encoding.UTF8.GetBytes(value);
    IntPtr memory = Marshal.AllocHGlobal(bytes.Length);
    try {
      Marshal.Copy(bytes, 0, memory, bytes.Length);
      CREDENTIAL credential = new CREDENTIAL();
      credential.Type = 1; credential.TargetName = target;
      credential.CredentialBlobSize = (uint)bytes.Length; credential.CredentialBlob = memory;
      credential.Persist = 2; credential.UserName = "smrt";
      if (!CredWriteW(ref credential, 0)) throw new Exception("write");
    } finally { Marshal.FreeHGlobal(memory); }
  }
  public static void Delete(string target) {
    if (!CredDeleteW(target, 1, 0) && Marshal.GetLastWin32Error() != 1168) throw new Exception("delete");
  }
}
`;

function windowsScript(
  operation: 'read' | 'write' | 'delete',
  target: string,
): string {
  // The target holds only validated name characters; the secret is read from
  // stdin by the script and never appears in it.
  const action =
    operation === 'read'
      ? `$v = [SmrtCredential]::Read('${target}'); if ($v -eq $null) { exit ${WINDOWS_NOT_FOUND} }; [Console]::Out.Write($v)`
      : operation === 'write'
        ? `$v = [Console]::In.ReadToEnd().Trim(); [SmrtCredential]::Write('${target}', $v)`
        : `[SmrtCredential]::Delete('${target}')`;
  return `$ErrorActionPreference = 'Stop'
$source = @'${WINDOWS_CREDENTIAL_SOURCE}'@
try { Add-Type -TypeDefinition $source; ${action} } catch { exit 1 }
`;
}

/**
 * Windows Credential Manager through PowerShell and the `advapi32`
 * `CredRead`/`CredWrite`/`CredDelete` calls. The script is passed as an
 * encoded command (it holds no secret); the secret goes in on stdin and out on
 * stdout. Credentials are generic and persisted for this machine.
 */
export function createWindowsCredentialKeychain(
  runner: KeychainCommandRunner = defaultKeychainCommandRunner,
  systemRoot: string | undefined = process.env.SystemRoot,
): OsKeychain {
  const file = systemRoot
    ? `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
    : 'powershell.exe';
  const invoke = (
    operation: 'read' | 'write' | 'delete',
    service: string,
    account: string,
    input?: string,
  ) => {
    assertKeychainName(service);
    assertKeychainName(account);
    return run(runner, {
      file,
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(
          windowsScript(operation, `${service}/${account}`),
          'utf16le',
        ).toString('base64'),
      ],
      input,
    });
  };
  return {
    async get(service, account) {
      const result = await invoke('read', service, account);
      if (result.code === WINDOWS_NOT_FOUND) return null;
      if (result.code !== 0) throw new KeychainOperationError();
      return fromHex(result.stdout);
    },
    async set(service, account, secret) {
      const result = await invoke('write', service, account, toHex(secret));
      if (result.code !== 0) throw new KeychainOperationError();
    },
    async delete(service, account) {
      const result = await invoke('delete', service, account);
      if (result.code !== 0) throw new KeychainOperationError();
    },
  };
}

/** The real keychain for a platform, or `null` where none is supported. */
export function createPlatformKeychain(
  platform: NodeJS.Platform = process.platform,
  runner?: KeychainCommandRunner,
): OsKeychain | null {
  switch (platform) {
    case 'darwin':
      return createMacOsKeychain(runner);
    case 'linux':
      return createLinuxSecretServiceKeychain(runner);
    case 'win32':
      return createWindowsCredentialKeychain(runner);
    default:
      return null;
  }
}

const PRODUCT_ID = /^[a-z0-9][a-z0-9.-]{0,62}$/;
const KEK_ACCOUNT = 'vault-key-encryption-key';
const KEK_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const SEAL_VERSION = 1;
const MAX_PLAINTEXT_BYTES = 1024 * 1024 - 1 - NONCE_BYTES - TAG_BYTES;

function additionalData(productId: string, name: string): Buffer {
  return Buffer.from(`smrt-vault-key-store/v1\0${productId}\0${name}`, 'utf8');
}

function seal(
  key: Uint8Array,
  productId: string,
  name: string,
  plaintext: Uint8Array,
): Uint8Array {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(additionalData(productId, name));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([SEAL_VERSION]),
      nonce,
      body,
      cipher.getAuthTag(),
    ]),
  );
}

function unseal(
  key: Uint8Array,
  productId: string,
  name: string,
  sealed: Uint8Array,
): Uint8Array {
  if (
    sealed.length < 1 + NONCE_BYTES + TAG_BYTES ||
    sealed[0] !== SEAL_VERSION
  ) {
    throw new Error('Vault key store item failed its integrity check');
  }
  const buffer = Buffer.from(sealed);
  const nonce = buffer.subarray(1, 1 + NONCE_BYTES);
  const tag = buffer.subarray(buffer.length - TAG_BYTES);
  const body = buffer.subarray(1 + NONCE_BYTES, buffer.length - TAG_BYTES);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAAD(additionalData(productId, name));
    decipher.setAuthTag(tag);
    return new Uint8Array(
      Buffer.concat([decipher.update(body), decipher.final()]),
    );
  } catch {
    throw new Error('Vault key store item failed its integrity check');
  }
}

/** Where a {@link KeychainVaultKeyStore} keeps its items. */
export type VaultKeyCustody =
  | { readonly kind: 'os-keychain' }
  | {
      readonly kind: 'file-fallback';
      /**
       * `keychain-unavailable`: no usable OS keychain on this host.
       * `existing-file-items`: items from an earlier file store are present,
       * and switching to a new key-encryption key would orphan them.
       */
      readonly reason: 'keychain-unavailable' | 'existing-file-items';
    };

export interface KeychainVaultKeyStore extends VaultKeyStore {
  /**
   * Which custody this store resolved to. Resolves (and may create the
   * key-encryption key) on first use; carries no secret or path.
   */
  custody(): Promise<VaultKeyCustody>;
}

export interface KeychainVaultKeyStoreOptions {
  /** Application identity; namespaces the keychain service and binds each sealed item. */
  productId: string;
  /** Absolute directory for sealed items; keep it outside the state root. */
  directory: string;
  /**
   * Absolute directory of the plain file store used when no keychain is
   * usable. Keep it outside the state root.
   */
  fallbackDirectory: string;
  /**
   * The OS keychain. Defaults to the real one for this platform; `null` means
   * none is available. Tests pass a fake.
   */
  keychain?: OsKeychain | null;
  /** Testable file-store overrides, applied to both directories. */
  fileStoreOptions?: FileVaultKeyStoreOptions;
  /**
   * Private directory for the product-wide lock that serializes creating the
   * key-encryption key. Defaults to {@link defaultKeychainLockDirectory}
   * (`<account home>/.smrt/locks`), outside any data root and independent of
   * the environment, so every root of one product shares it.
   */
  lockDirectory?: string | (() => string);
}

const LOCK_WAIT_MS = 30_000;
const LOCK_POLL_MS = 25;
const LOCK_UNAVAILABLE = 'The vault key creation lock is unavailable';

/**
 * The product lock directory: `<account home>/.smrt/locks`. The home comes
 * from the OS account record, never from `HOME`, `USERPROFILE` or `TMPDIR`,
 * which a launcher or smoke harness may replace, so every process of one OS
 * user agrees on one lock and no other user can pre-create it.
 */
export function defaultKeychainLockDirectory(
  home: string = userInfo().homedir,
): string {
  return join(home, '.smrt', 'locks');
}

/**
 * Hold an exclusive, product-wide lock while `callback` runs. It is a
 * `wx`-created record naming this process, reclaimed through the shared
 * stale-reclaim mutex when its owner is gone, and waited for (never stolen)
 * while the owner lives. Limits: it serializes processes of one OS user on
 * one machine; it does not protect two machines or two users, and a lock file
 * left empty by a crash between create and write blocks creation until it is
 * removed by hand (acquisition then fails with fixed text after 30 seconds).
 */
async function withProductLock<T>(
  directoryOrResolver: string | (() => string),
  productId: string,
  callback: () => Promise<T>,
): Promise<T> {
  let directory: string;
  try {
    directory =
      typeof directoryOrResolver === 'function'
        ? directoryOrResolver()
        : directoryOrResolver;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const details = await lstat(directory);
    const uid = process.getuid?.();
    if (
      details.isSymbolicLink() ||
      !details.isDirectory() ||
      (uid !== undefined &&
        (details.uid !== uid || (details.mode & 0o077) !== 0))
    ) {
      throw new Error('custody');
    }
  } catch {
    // Fail closed with fixed text: never create the key without the lock, and
    // never surface a path or system error.
    throw failure(LOCK_UNAVAILABLE);
  }
  const path = join(directory, `${productId}.lock`);
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const handle = await open(path, 'wx', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify({ pid: process.pid })}\n`);
      } catch (error) {
        await handle.close();
        await rm(path, { force: true });
        throw failure(LOCK_UNAVAILABLE);
      }
      await handle.close();
      break;
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw failure(LOCK_UNAVAILABLE);
      let observed: string | null = null;
      try {
        observed = await readFile(path, 'utf8');
      } catch {
        // Removed between the create attempt and the read: retry.
      }
      const owner = observed === null ? null : lockOwnerPid(observed);
      if (observed !== null && owner !== null && !processExists(owner)) {
        try {
          reclaimStaleRecord(path, observed, isStaleOperationLock);
        } catch {
          throw failure(LOCK_UNAVAILABLE);
        }
        continue;
      }
      if (Date.now() >= deadline) {
        throw failure('The vault key creation lock could not be acquired');
      }
      await new Promise((done) => setTimeout(done, LOCK_POLL_MS));
    }
  }
  try {
    return await callback();
  } finally {
    // Best effort: a failed release must neither replace the callback's result
    // or error nor leak a path. A leftover lock is reclaimed once its owner
    // process is gone.
    await rm(path, { force: true }).catch(() => undefined);
  }
}

function failure(message: string): Error {
  return new Error(message);
}

async function hasItems(directory: string): Promise<boolean> {
  try {
    return (await readdir(directory)).some((name) => !name.startsWith('.'));
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ENOENT') return false;
    throw failure('Vault key store directory could not be inspected');
  }
}

/**
 * A key-wrapped file vault key store. A random 32-byte key-encryption key
 * lives in the OS keychain under the service `smrt-vault.<productId>`. Items
 * are sealed with AES-256-GCM (random nonce; the product id and item name are
 * authenticated, so an item cannot be moved between names or products) and
 * written through the owner-only atomic file store, so the keychain's own
 * item size limits do not matter and a copy of the files alone is useless.
 *
 * If no keychain is usable the store falls back to
 * {@link createFileVaultKeyStore} on `fallbackDirectory`; {@link
 * KeychainVaultKeyStore.custody} reports it. It never falls back, and never
 * creates a replacement key, when sealed items exist without a readable key,
 * because a new key would orphan them: it fails closed instead.
 */
export function createKeychainVaultKeyStore(
  options: KeychainVaultKeyStoreOptions,
): KeychainVaultKeyStore {
  if (
    typeof options.productId !== 'string' ||
    !PRODUCT_ID.test(options.productId)
  ) {
    throw new Error('Invalid vault key store product id');
  }
  // Key creation is serialized across every root of this product by a lock
  // outside the data roots (see withProductLock for its limits).
  const productId = options.productId;
  const service = `smrt-vault.${productId}`;
  const sealedFiles = createFileVaultKeyStore(
    options.directory,
    options.fileStoreOptions,
  );
  const plainFiles = createFileVaultKeyStore(
    options.fallbackDirectory,
    options.fileStoreOptions,
  );

  type Resolved =
    | { custody: VaultKeyCustody; key: Uint8Array }
    | { custody: VaultKeyCustody; key?: undefined };
  let resolved: Promise<Resolved> | undefined;

  async function resolve(): Promise<Resolved> {
    const keychain =
      options.keychain === undefined
        ? createPlatformKeychain()
        : options.keychain;
    const sealedPresent = await hasItems(options.directory);
    // Existing file custody always wins over a keychain key, whoever made the
    // key (another root of this product, a smoke run, a reinstall): sealed
    // reads would miss the old items and the caller would mint a new key over
    // them, orphaning everything the old key sealed.
    if (!sealedPresent && (await hasItems(options.fallbackDirectory))) {
      return {
        custody: { kind: 'file-fallback', reason: 'existing-file-items' },
      };
    }
    const unavailable = (): Resolved => {
      if (sealedPresent) {
        throw failure(
          'The OS keychain is unavailable and sealed vault items exist',
        );
      }
      return {
        custody: { kind: 'file-fallback', reason: 'keychain-unavailable' },
      };
    };
    if (keychain === null) return unavailable();
    let stored: Uint8Array | null;
    try {
      stored = await keychain.get(service, KEK_ACCOUNT);
    } catch (error) {
      if (error instanceof KeychainUnavailableError) return unavailable();
      throw failure('The OS keychain could not be read');
    }
    if (stored !== null) {
      if (stored.length !== KEK_BYTES) {
        throw failure('The vault key-encryption key is malformed');
      }
      return { custody: { kind: 'os-keychain' }, key: stored };
    }
    if (sealedPresent) {
      throw failure(
        'The vault key-encryption key is missing and sealed vault items exist',
      );
    }
    // Create under the product-wide lock, re-reading first: another root of
    // this product may have created the key since the read above, and a second
    // writer would overwrite it and orphan whatever the first already sealed.
    return withProductLock(
      options.lockDirectory ?? (() => defaultKeychainLockDirectory()),
      productId,
      async (): Promise<Resolved> => {
        let current: Uint8Array | null;
        try {
          current = await keychain.get(service, KEK_ACCOUNT);
        } catch (error) {
          if (error instanceof KeychainUnavailableError) return unavailable();
          throw failure('The OS keychain could not be read');
        }
        if (current !== null) {
          if (current.length !== KEK_BYTES) {
            throw failure('The vault key-encryption key is malformed');
          }
          return { custody: { kind: 'os-keychain' }, key: current };
        }
        const created = new Uint8Array(randomBytes(KEK_BYTES));
        try {
          await keychain.set(service, KEK_ACCOUNT, created);
        } catch (error) {
          created.fill(0);
          if (error instanceof KeychainUnavailableError) return unavailable();
          throw failure('The OS keychain could not be written');
        }
        let confirmed: Uint8Array | null;
        try {
          confirmed = await keychain.get(service, KEK_ACCOUNT);
        } catch {
          confirmed = null;
        }
        created.fill(0);
        if (confirmed === null || confirmed.length !== KEK_BYTES) {
          throw failure(
            'The OS keychain did not retain the key-encryption key',
          );
        }
        return { custody: { kind: 'os-keychain' }, key: confirmed };
      },
    );
  }

  function ready(): Promise<Resolved> {
    resolved ??= resolve().catch((error) => {
      resolved = undefined;
      throw error;
    });
    return resolved;
  }

  return {
    custody: async () => (await ready()).custody,

    async get(name) {
      assertVaultKeyStoreItemName(name);
      const { key } = await ready();
      if (!key) return plainFiles.get(name);
      const sealed = await sealedFiles.get(name);
      return sealed === null ? null : unseal(key, productId, name, sealed);
    },

    async set(name, value) {
      assertVaultKeyStoreItemName(name);
      if (!(value instanceof Uint8Array)) {
        throw new Error('Invalid vault key store item value');
      }
      const { key } = await ready();
      if (!key) return plainFiles.set(name, value);
      if (value.length > MAX_PLAINTEXT_BYTES) {
        throw new Error('Invalid vault key store item value');
      }
      await sealedFiles.set(name, seal(key, productId, name, value));
    },

    async delete(name) {
      assertVaultKeyStoreItemName(name);
      const { key } = await ready();
      if (!key) return plainFiles.delete(name);
      await sealedFiles.delete(name);
    },
  };
}
