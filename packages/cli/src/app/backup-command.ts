/**
 * `smrt app backup --encrypted --target <name>` and `smrt app backups …`
 * (#4804): target configuration, the upload orchestration around
 * `writeEncryptedSnapshot`, listing and per-target retention.
 *
 * Target configuration lives in `<state root>/backup-targets.json` (0600) and
 * holds no secrets: a directory path, a Drive folder name and a credential
 * *reference*, or a relay URL. The strict parser rejects every other key, so a
 * token or key can never be persisted by this file. Secrets come from the
 * injected {@link BackupTargetDependencies.credentials} custody seam.
 */

import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { withOperationLock } from '@happyvertical/smrt-app-runtime';
import { FileBackupTarget } from './backup-target-file.js';
import {
  assertDriveFolderName,
  type DriveCredentials,
  type DriveFilesystem,
  GoogleDriveBackupTarget,
} from './backup-target-gdrive.js';
import {
  normalizeRelayUrl,
  type VaultDeviceSigner,
  type VaultEntitlementSource,
  VaultRelayBackupTarget,
  type VaultRelayBackupTargetOptions,
} from './backup-target-vault.js';
import {
  assertRetention,
  type BackupObject,
  type BackupRetention,
  type BackupTarget,
  BackupTargetError,
  type BackupTargetKind,
  digestFile,
  planRetention,
  readFileChunks,
} from './backup-targets.js';
import { assertExternalArtifactPath } from './identity.js';
import { type AppContext, preparedStateRoot } from './runtime.js';
import { planDataRootArchive } from './snapshot-archive.js';
import {
  ENCRYPTED_SNAPSHOT_EXTENSION,
  type EncryptedSnapshotSummary,
  type SnapshotKeyProvider,
  writeEncryptedSnapshot,
} from './snapshot-framing.js';

/** Collaborators for backup targets. All optional; absent means fail closed. */
export interface BackupTargetDependencies {
  /**
   * The user's own credential store (custody seam). Returns `undefined` when
   * nothing is stored; must never log or return secrets through errors.
   */
  credentials?: {
    /** Drive OAuth material stored under a reference name. */
    driveCredentials(reference: string): Promise<DriveCredentials | undefined>;
    /** This device's vault identity and signer. */
    vaultSigner(): Promise<VaultDeviceSigner | undefined>;
  };
  /** Cached device entitlement (`DeviceEntitlementCache` satisfies it). */
  entitlements?: VaultEntitlementSource;
  /** Transport for the vault relay. Defaults to the command's fetch. */
  fetch?: typeof fetch;
  /** Replaces the SDK Google Drive filesystem (tests, embedding). */
  createDriveFilesystem?: (
    credentials: DriveCredentials,
  ) => Promise<DriveFilesystem>;
  /** Tuning for the vault client (chunk size, attempts, clock). */
  vault?: Partial<
    Pick<
      VaultRelayBackupTargetOptions,
      | 'chunkBytes'
      | 'attempts'
      | 'retryDelayMs'
      | 'requestTimeoutMs'
      | 'now'
      | 'sleep'
    >
  >;
}

// Configuration -----------------------------------------------------------------

/** File name of the target configuration inside the state root. */
export const BACKUP_TARGETS_FILE = 'backup-targets.json';
const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_TARGETS = 32;
const TARGET_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const CREDENTIAL_REF = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Default Drive folder, one per application: every SMRT app shares the OAuth
 * client, so a common folder would let one app's retention remove another's.
 */
function defaultDriveFolder(appId: string): string {
  return `smrt-backups-${createHash('sha256').update(appId).digest('hex').slice(0, 12)}`;
}

/** A configured target. Contains no secret. */
export type BackupTargetConfig = { retention?: BackupRetention } & (
  | { kind: 'file'; path: string }
  | { kind: 'gdrive'; credentialRef: string; folder: string }
  | { kind: 'vault'; url: string }
);

interface BackupConfigFile {
  schemaVersion: 1;
  targets: Record<string, BackupTargetConfig>;
}

function configError(message: string): BackupTargetError {
  return new BackupTargetError('invalid_config', message);
}

function assertKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw configError(`${label} has an unsupported field.`);
    }
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

/** Parse one stored target; rejects unknown fields and invalid values. */
export function parseTargetConfig(raw: unknown): BackupTargetConfig {
  if (!isPlainRecord(raw))
    throw configError('A backup target must be an object.');
  let retention: BackupRetention | undefined;
  if (raw.retention !== undefined) {
    if (!isPlainRecord(raw.retention)) {
      throw configError('Target retention must be an object.');
    }
    assertKeys(raw.retention, ['keepLast', 'keepWithinDays'], 'Retention');
    retention = {
      keepLast: raw.retention.keepLast as number,
      ...(raw.retention.keepWithinDays === undefined
        ? {}
        : { keepWithinDays: raw.retention.keepWithinDays as number }),
    };
    assertRetention(retention);
  }
  const base = retention ? { retention } : {};
  switch (raw.kind) {
    case 'file': {
      assertKeys(raw, ['kind', 'path', 'retention'], 'A file target');
      if (typeof raw.path !== 'string' || !isAbsolute(raw.path)) {
        throw configError('A file target needs an absolute path.');
      }
      return { kind: 'file', path: raw.path, ...base };
    }
    case 'gdrive': {
      assertKeys(
        raw,
        ['kind', 'credentialRef', 'folder', 'retention'],
        'A Google Drive target',
      );
      if (
        typeof raw.credentialRef !== 'string' ||
        !CREDENTIAL_REF.test(raw.credentialRef)
      ) {
        throw configError(
          'A Google Drive target needs a credential reference name.',
        );
      }
      return {
        kind: 'gdrive',
        credentialRef: raw.credentialRef,
        folder: assertDriveFolderName(raw.folder),
        ...base,
      };
    }
    case 'vault': {
      assertKeys(raw, ['kind', 'url', 'retention'], 'A vault target');
      return { kind: 'vault', url: normalizeRelayUrl(raw.url), ...base };
    }
    default:
      throw configError('A backup target needs kind file, gdrive or vault.');
  }
}

function assertTargetName(name: unknown): string {
  if (typeof name !== 'string' || !TARGET_NAME.test(name)) {
    throw configError(
      'A target name uses lowercase letters, digits and dashes, up to 40 characters.',
    );
  }
  return name;
}

function configPath(stateRoot: string): string {
  return join(stateRoot, BACKUP_TARGETS_FILE);
}

/** Read the configuration; a missing file is an empty configuration. */
export function readBackupConfig(stateRoot: string): BackupConfigFile {
  const path = configPath(stateRoot);
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { schemaVersion: 1, targets: {} };
    }
    throw configError('The backup target configuration cannot be read.');
  }
  let text: string;
  try {
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.size > MAX_CONFIG_BYTES) {
      throw configError(
        'The backup target configuration is not a small regular file.',
      );
    }
    text = readFileSync(descriptor, 'utf8');
  } finally {
    closeSync(descriptor);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw configError('The backup target configuration is not valid JSON.');
  }
  if (!isPlainRecord(parsed) || parsed.schemaVersion !== 1) {
    throw configError(
      'The backup target configuration has an unsupported version.',
    );
  }
  assertKeys(parsed, ['schemaVersion', 'targets'], 'The configuration');
  if (!isPlainRecord(parsed.targets)) {
    throw configError(
      'The backup target configuration needs a targets object.',
    );
  }
  const names = Object.keys(parsed.targets);
  if (names.length > MAX_TARGETS) {
    throw configError('Too many backup targets are configured.');
  }
  const targets: Record<string, BackupTargetConfig> = Object.create(null);
  for (const name of names) {
    targets[assertTargetName(name)] = parseTargetConfig(parsed.targets[name]);
  }
  return { schemaVersion: 1, targets: { ...targets } };
}

function writeBackupConfig(stateRoot: string, config: BackupConfigFile): void {
  const path = configPath(stateRoot);
  const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function describeTarget(name: string, config: BackupTargetConfig) {
  return { name, ...config };
}

// Construction ------------------------------------------------------------------

/** Build the target object for a configuration entry. */
export function createBackupTarget(
  context: AppContext,
  name: string,
  config: BackupTargetConfig,
): BackupTarget {
  const deps = context.deps.backup ?? {};
  switch (config.kind) {
    case 'file':
      return new FileBackupTarget({ name, directory: config.path });
    case 'gdrive':
      return new GoogleDriveBackupTarget({
        name,
        folder: config.folder,
        credentials: async () =>
          deps.credentials?.driveCredentials(config.credentialRef),
        createFilesystem: deps.createDriveFilesystem,
      });
    case 'vault':
      return new VaultRelayBackupTarget({
        name,
        url: config.url,
        signer: async () => deps.credentials?.vaultSigner(),
        stateRoot: preparedStateRoot(context),
        entitlements: deps.entitlements,
        fetch: deps.fetch ?? context.deps.fetch,
        ...deps.vault,
      });
  }
}

function openTarget(
  context: AppContext,
  stateRoot: string,
  name: string,
): { target: BackupTarget; config: BackupTargetConfig } {
  const config = readBackupConfig(stateRoot).targets[assertTargetName(name)];
  if (!config) {
    throw configError(`No backup target is configured with the name ${name}.`);
  }
  return { target: createBackupTarget(context, name, config), config };
}

// Backup ------------------------------------------------------------------------

/** Result of removing old snapshots after a successful upload. */
interface RetentionOutcome {
  applied: boolean;
  removed: string[];
  error?: { code: string; message: string };
}

function failureOf(error: unknown): { code: string; message: string } {
  return error instanceof BackupTargetError
    ? { code: error.code, message: error.message }
    : {
        code: 'unavailable',
        message: 'The backup target could not complete the request.',
      };
}

/** Apply a target's retention; never throws (the backup already succeeded). */
export async function applyRetention(
  target: BackupTarget,
  retention: BackupRetention | undefined,
  options: {
    dryRun?: boolean;
    now?: number;
    /** Target object ids retention must keep (the snapshot just stored). */
    protectIds?: readonly string[];
    /** A listing already taken after the upload, to avoid listing twice. */
    listing?: readonly BackupObject[];
  } = {},
): Promise<RetentionOutcome & { wouldRemove?: string[] }> {
  if (!retention) return { applied: false, removed: [] };
  try {
    const plan = planRetention(
      options.listing ?? (await target.list()),
      retention,
      options.now,
      options.protectIds,
    );
    const ids = plan.remove.map((object) => object.id);
    if (options.dryRun)
      return { applied: false, removed: [], wouldRemove: ids };
    const removed: string[] = [];
    for (const id of ids) {
      await target.delete(id);
      removed.push(id);
    }
    return { applied: true, removed };
  } catch (error) {
    return { applied: false, removed: [], error: failureOf(error) };
  }
}

function snapshotReport(snapshot: EncryptedSnapshotSummary) {
  const { digest: _digest, ...report } = snapshot;
  return report;
}

function objectReport(object: BackupObject) {
  return {
    id: object.id,
    sequence: object.sequence.toString(10),
    byteSize: object.byteSize,
    createdAt: object.createdAt.toISOString(),
  };
}

/**
 * Seal the quiescent data root into a private staging file and store it on a
 * configured target. The caller holds the operation lock and writer lease.
 * The staged file is ciphertext only and is removed on success or failure.
 */
export async function backupToTarget(
  context: AppContext,
  options: {
    targetName: string;
    dataRoot: string;
    snapshotKeys: SnapshotKeyProvider;
  },
): Promise<Record<string, unknown>> {
  const stateRoot = preparedStateRoot(context);
  const { target, config } = openTarget(context, stateRoot, options.targetName);
  try {
    return await backupToOpenTarget(stateRoot, target, config, options);
  } finally {
    // Releases the vault writer lease taken by the preflight, if any.
    await target.close?.().catch(() => undefined);
  }
}

async function backupToOpenTarget(
  stateRoot: string,
  target: BackupTarget,
  config: BackupTargetConfig,
  options: { dataRoot: string; snapshotKeys: SnapshotKeyProvider },
): Promise<Record<string, unknown>> {
  // Entitlement, credentials, scope and the vault writer lease fail here,
  // before a sequence is spent.
  await target.preflight();

  const stagingDirectory = join(stateRoot, 'backup-staging');
  mkdirSync(stagingDirectory, { recursive: true, mode: 0o700 });
  // Leftovers of a crashed run (this process holds the operation lock). Only
  // our own ciphertext files are touched, never directories or other names.
  for (const leftover of readdirSync(stagingDirectory, {
    withFileTypes: true,
  })) {
    if (
      leftover.isFile() &&
      leftover.name.endsWith(ENCRYPTED_SNAPSHOT_EXTENSION)
    ) {
      rmSync(join(stagingDirectory, leftover.name), { force: true });
    }
  }
  const staged = join(
    stagingDirectory,
    `${randomBytes(8).toString('hex')}${ENCRYPTED_SNAPSHOT_EXTENSION}`,
  );
  try {
    const archive = planDataRootArchive(options.dataRoot);
    const snapshot = await writeEncryptedSnapshot({
      destination: staged,
      kind: 'data-root',
      totalLength: archive.totalLength,
      source: archive.chunks(),
      sealing: await options.snapshotKeys.sealingKey(),
      label: 'Backup staging file',
    });
    const { sha256, byteSize } = await digestFile(staged);
    const stored = await target.put({
      sequence: BigInt(snapshot.sequence),
      byteSize,
      sha256,
      source: readFileChunks(staged),
    });
    // One listing serves the ordering check and retention. A listing failure
    // must not fail a finished upload; retention reports it the same way.
    let listing: BackupObject[] | undefined;
    let listError: { code: string; message: string } | undefined;
    try {
      listing = await target.list();
    } catch (error) {
      listError = failureOf(error);
    }
    const warnings: Array<{ code: string; message: string }> = [];
    const highest = listing
      ?.filter((object) => object.id !== stored.id)
      .reduce<bigint | undefined>(
        (max, object) =>
          max === undefined || object.sequence > max ? object.sequence : max,
        undefined,
      );
    if (highest !== undefined && stored.sequence <= highest) {
      warnings.push({
        code: 'sequence_not_above_target_maximum',
        message:
          `The snapshot just stored has sequence ${stored.sequence} but the ` +
          `target already holds sequence ${highest}. This device's snapshot ` +
          'counter restarted (reinstall or restore). Retention and "latest" ' +
          'ordering rank by sequence, so this snapshot is ranked older than ' +
          'those on the target: it was kept this time, but a later prune can ' +
          'remove it. Restore the latest snapshot before backing up again.',
      });
    }
    const retention =
      listError && config.retention
        ? { applied: false, removed: [], error: listError }
        : await applyRetention(target, config.retention, {
            protectIds: [stored.id],
            listing,
          });
    return {
      schemaVersion: 1,
      status: 'backed-up',
      target: { name: target.name, kind: target.kind },
      encrypted: true,
      snapshot: snapshotReport(snapshot),
      object: objectReport(stored),
      retention,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  } finally {
    rmSync(staged, { force: true });
  }
}

// Commands ----------------------------------------------------------------------

/** Usage text for `smrt app backups`. */
export const BACKUPS_USAGE = `Usage: smrt app backups <command>

Commands:
  targets                         List configured backup targets
  targets add <name> --kind file --path <directory> [retention]
  targets add <name> --kind gdrive --credential <reference> [--folder <name>] [retention]
  targets add <name> --kind vault --url <https url> [retention]
  targets remove <name>           Forget a target (stored snapshots are kept)
  list [--target <name>]          List snapshots on one or every target
  prune [--target <name>] [--dry-run]
                                  Apply each target's retention

Retention options: --keep-last <n> (1 or more), --keep-within-days <n>.
Back up with: smrt app backup --encrypted --target <name>
`;

interface ParsedFlags {
  positional: string[];
  values: Map<string, string>;
  switches: Set<string>;
}

/** Parse `--name value`, `--name=value` and boolean switches. */
function parseFlags(
  args: readonly string[],
  valued: readonly string[],
  switches: readonly string[] = [],
): ParsedFlags {
  const parsed: ParsedFlags = {
    positional: [],
    values: new Map(),
    switches: new Set(),
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (!arg.startsWith('--')) {
      parsed.positional.push(arg);
      continue;
    }
    const equals = arg.indexOf('=');
    const flag = equals === -1 ? arg : arg.slice(0, equals);
    if (switches.includes(flag)) {
      if (equals !== -1 || parsed.switches.has(flag)) {
        throw configError(`Invalid use of ${flag}.`);
      }
      parsed.switches.add(flag);
      continue;
    }
    if (!valued.includes(flag)) throw configError(`Unknown option ${flag}.`);
    let value: string | undefined;
    if (equals !== -1) value = arg.slice(equals + 1);
    else {
      index += 1;
      value = args[index];
    }
    if (value === undefined || value === '' || parsed.values.has(flag)) {
      throw configError(`Option ${flag} needs exactly one value.`);
    }
    parsed.values.set(flag, value);
  }
  return parsed;
}

/** Split one `--name value` option out of an argument list. */
export function extractOption(
  args: readonly string[],
  flag: string,
): { value?: string; rest: string[] } {
  const rest: string[] = [];
  let value: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    let found: string | undefined;
    if (arg === flag) {
      index += 1;
      found = args[index];
      if (found === undefined || found === '' || found.startsWith('--')) {
        throw configError(`Option ${flag} needs a value.`);
      }
    } else if (arg.startsWith(`${flag}=`)) {
      found = arg.slice(flag.length + 1);
      if (found === '') throw configError(`Option ${flag} needs a value.`);
    } else {
      rest.push(arg);
      continue;
    }
    if (value !== undefined)
      throw configError(`Option ${flag} was given twice.`);
    value = found;
  }
  return { value, rest };
}

function wholeNumber(value: string, flag: string): number {
  if (!/^\d{1,6}$/.test(value)) {
    throw configError(`Option ${flag} needs a whole number.`);
  }
  return Number(value);
}

function retentionFromFlags(flags: ParsedFlags): BackupRetention | undefined {
  const keepLast = flags.values.get('--keep-last');
  const days = flags.values.get('--keep-within-days');
  if (keepLast === undefined) {
    if (days !== undefined) {
      throw configError('--keep-within-days needs --keep-last.');
    }
    return undefined;
  }
  const retention: BackupRetention = {
    keepLast: wholeNumber(keepLast, '--keep-last'),
    ...(days === undefined
      ? {}
      : { keepWithinDays: wholeNumber(days, '--keep-within-days') }),
  };
  assertRetention(retention);
  return retention;
}

function printJson(context: AppContext, value: unknown): void {
  context.io.stdout(`${JSON.stringify(value, null, 2)}\n`);
}

async function assertLocalProfile(context: AppContext): Promise<void> {
  const runtime = await context.deps.resolveRuntime(context.sourceRoot);
  if (runtime.profile !== 'local') {
    throw new Error(
      'Backup targets are configured for local installations; deployed backups belong to the selected operator or managed provider.',
    );
  }
}

function addTarget(
  context: AppContext,
  stateRoot: string,
  dataRoot: string,
  args: string[],
): void {
  const flags = parseFlags(args, [
    '--kind',
    '--path',
    '--credential',
    '--folder',
    '--url',
    '--keep-last',
    '--keep-within-days',
  ]);
  if (flags.positional.length !== 1) {
    throw configError('Usage: backups targets add <name> --kind <kind> …');
  }
  const name = assertTargetName(flags.positional[0]);
  const kind = flags.values.get('--kind') as BackupTargetKind | undefined;
  const retention = retentionFromFlags(flags);
  const allowedFor: Record<BackupTargetKind, string[]> = {
    file: ['--kind', '--path', '--keep-last', '--keep-within-days'],
    gdrive: [
      '--kind',
      '--credential',
      '--folder',
      '--keep-last',
      '--keep-within-days',
    ],
    vault: ['--kind', '--url', '--keep-last', '--keep-within-days'],
  };
  if (!kind || !(kind in allowedFor)) {
    throw configError('Choose --kind file, gdrive or vault.');
  }
  for (const flag of flags.values.keys()) {
    if (!allowedFor[kind].includes(flag)) {
      throw configError(`Option ${flag} does not apply to a ${kind} target.`);
    }
  }
  let candidate: unknown;
  if (kind === 'file') {
    const path = flags.values.get('--path');
    if (!path) throw configError('A file target needs --path.');
    const absolute = assertExternalArtifactPath({
      sourceRoot: context.sourceRoot,
      path: resolve(path),
      label: 'Backup target directory',
    });
    const fromData = relative(dataRoot, absolute);
    if (
      fromData === '' ||
      (!isAbsolute(fromData) &&
        fromData !== '..' &&
        !fromData.startsWith(`..${sep}`))
    ) {
      throw configError(
        'A backup target directory must be outside local storage.',
      );
    }
    const insideState = relative(stateRoot, absolute);
    const stateInside = relative(absolute, stateRoot);
    const within = (path: string) =>
      path === '' ||
      (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
    if (within(insideState) || within(stateInside)) {
      throw configError(
        'A backup target directory must not overlap the application state directory.',
      );
    }
    candidate = { kind, path: absolute };
  } else if (kind === 'gdrive') {
    candidate = {
      kind,
      credentialRef: flags.values.get('--credential'),
      folder: flags.values.get('--folder') ?? defaultDriveFolder(context.appId),
    };
  } else {
    candidate = { kind, url: flags.values.get('--url') };
  }
  const config = parseTargetConfig({
    ...(candidate as object),
    ...(retention ? { retention } : {}),
  });
  const stored = readBackupConfig(stateRoot);
  if (stored.targets[name]) {
    throw configError(
      `A backup target named ${name} already exists; remove it first.`,
    );
  }
  if (Object.keys(stored.targets).length >= MAX_TARGETS) {
    throw configError('Too many backup targets are configured.');
  }
  stored.targets[name] = config;
  writeBackupConfig(stateRoot, stored);
  printJson(context, {
    schemaVersion: 1,
    status: 'target-added',
    target: describeTarget(name, config),
    secretValuesIncluded: false,
  });
}

async function listSnapshots(
  context: AppContext,
  stateRoot: string,
  args: string[],
): Promise<number> {
  const { value: only, rest } = extractOption(args, '--target');
  if (rest.length) throw configError('Unexpected argument to backups list.');
  const config = readBackupConfig(stateRoot);
  const names = only ? [assertTargetName(only)] : Object.keys(config.targets);
  if (only && !config.targets[only]) {
    throw configError(`No backup target is configured with the name ${only}.`);
  }
  const targets: unknown[] = [];
  let failed = false;
  for (const name of names) {
    const entry = config.targets[name] as BackupTargetConfig;
    try {
      const objects = await createBackupTarget(context, name, entry).list();
      targets.push({
        name,
        kind: entry.kind,
        snapshots: objects.map(objectReport),
      });
    } catch (error) {
      failed = true;
      targets.push({ name, kind: entry.kind, error: failureOf(error) });
    }
  }
  printJson(context, {
    schemaVersion: 1,
    status: failed ? 'partial' : 'listed',
    targets,
    secretValuesIncluded: false,
  });
  return failed ? 1 : 0;
}

async function pruneSnapshots(
  context: AppContext,
  stateRoot: string,
  args: string[],
): Promise<number> {
  const { value: only, rest } = extractOption(args, '--target');
  const flags = parseFlags(rest, [], ['--dry-run']);
  if (flags.positional.length)
    throw configError('Unexpected argument to backups prune.');
  const dryRun = flags.switches.has('--dry-run');
  const config = readBackupConfig(stateRoot);
  if (only && !config.targets[assertTargetName(only)]) {
    throw configError(`No backup target is configured with the name ${only}.`);
  }
  const names = only ? [only] : Object.keys(config.targets);
  const results: unknown[] = [];
  let failed = false;
  for (const name of names) {
    const entry = config.targets[name] as BackupTargetConfig;
    const target = createBackupTarget(context, name, entry);
    if (!entry.retention) {
      results.push({
        name,
        kind: entry.kind,
        retention: null,
        note:
          entry.kind === 'vault'
            ? 'The relay enforces its own retention after each upload.'
            : 'No retention is configured for this target; nothing was removed.',
      });
      continue;
    }
    if (target instanceof FileBackupTarget && !dryRun) {
      await target.removeStalePartials(24 * 60 * 60 * 1000).catch(() => 0);
    }
    const outcome = await applyRetention(target, entry.retention, { dryRun });
    if (outcome.error) failed = true;
    results.push({
      name,
      kind: entry.kind,
      retention: entry.retention,
      ...outcome,
    });
  }
  printJson(context, {
    schemaVersion: 1,
    status: failed ? 'partial' : dryRun ? 'dry-run' : 'pruned',
    targets: results,
    secretValuesIncluded: false,
  });
  return failed ? 1 : 0;
}

/** Entry point for `smrt app backups …`. Resolves to the exit code. */
export async function runBackupsCommand(
  context: AppContext,
  args: string[],
): Promise<number> {
  const [command, ...rest] = args;
  if (
    !command ||
    command === '--help' ||
    command === '-h' ||
    command === 'help'
  ) {
    context.io.stdout(BACKUPS_USAGE);
    return 0;
  }
  await assertLocalProfile(context);
  const stateRoot = preparedStateRoot(context);

  if (command === 'targets') {
    const [action, ...actionArgs] = rest;
    if (action === undefined) {
      const config = readBackupConfig(stateRoot);
      printJson(context, {
        schemaVersion: 1,
        status: 'targets',
        targets: Object.entries(config.targets).map(([name, entry]) =>
          describeTarget(name, entry),
        ),
        secretValuesIncluded: false,
      });
      return 0;
    }
    if (action === 'add') {
      const paths = await context.deps.runtime.validateLocalDatabaseStorage({
        appId: context.appId,
        dataDirectory: process.env.SMRT_DATA_DIR,
        sourceRoot: context.sourceRoot,
      });
      await withOperationLock(stateRoot, 'backups', () =>
        addTarget(context, stateRoot, paths.root, actionArgs),
      );
      return 0;
    }
    if (action === 'remove') {
      if (actionArgs.length !== 1) {
        throw configError('Usage: backups targets remove <name>');
      }
      const name = assertTargetName(actionArgs[0]);
      await withOperationLock(stateRoot, 'backups', () => {
        const stored = readBackupConfig(stateRoot);
        if (!stored.targets[name]) {
          throw configError(
            `No backup target is configured with the name ${name}.`,
          );
        }
        delete stored.targets[name];
        writeBackupConfig(stateRoot, stored);
        printJson(context, {
          schemaVersion: 1,
          status: 'target-removed',
          name,
          secretValuesIncluded: false,
        });
      });
      return 0;
    }
    throw configError('Usage: backups targets [add|remove] …');
  }
  if (command === 'list') return listSnapshots(context, stateRoot, rest);
  if (command === 'prune') {
    return withOperationLock(stateRoot, 'backups', () =>
      pruneSnapshots(context, stateRoot, rest),
    );
  }
  throw configError(`Unknown backups command: ${command}`);
}
