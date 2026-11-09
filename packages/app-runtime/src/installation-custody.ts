/**
 * Installation custody: restore/move versus copy of a local installation's
 * identity seed (#4704, part of #4668).
 *
 * A local installation is its seed (`secrets/application.secret`): device,
 * tenant, owner, profile and membership IDs, bootstrap tokens and local MCP
 * tokens all derive from it. The seed lives in the data root, so anything that
 * copies the data root (`smrt app backup`, a file-sync folder, a manual `cp`)
 * copies the identity too. Offline, a restored move and a duplicate copy are
 * byte-identical, so the runtime never guesses: it records which *location*
 * (the machine-local state root, which is derived from the data-root path and
 * is never part of a data-root copy) last took custody of the seed, and fails
 * closed on any arrival it cannot attribute. The operator then declares what
 * the arrival is:
 *
 * - `restore`: the same installation moved; the seed and every identity are
 *   preserved, and the operator asserts the origin is no longer active.
 * - `reseed`: this is (or must become) an independent installation; a new seed
 *   is generated, identities change and seed-keyed tokens stop working.
 * - `recover-seed`: put a backed-up seed back after loss; nothing is
 *   regenerated and identities are preserved.
 * - `retire`: mark this location's installation as moved away so it can no
 *   longer start.
 *
 * Two records carry the evidence (neither holds secret material):
 * `<data root>/secrets/installation.json` travels with every copy and
 * `<state root>/installation.json` stays at the location. Their shared
 * `activationId` proves the data root was last activated by this location.
 * `epoch` orders custody transfers of one installation for the future
 * primary-writer relay: a transfer bumps it, so a stale origin is
 * distinguishable from its successor.
 *
 * Limits: this is a local, cooperative control. A byte-identical clone of the
 * data root *and* state root (a VM or home-directory image) and a copy made
 * before this record existed are indistinguishable from the original until a
 * relay compares epochs. There is no server escrow: a lost seed with no backup
 * is lost.
 */

import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
} from 'node:fs';
import { join } from 'node:path';
import { errorCode } from './error-code.js';
import {
  openLocalMcpTokenStore,
  type ResolveLocalRuntimePathsOptions,
  type resolveLocalRuntimePaths,
  validateLocalDatabaseStorage,
  withLocalInitializationLock,
} from './index.js';
import { deriveLocalInstallationIdentity } from './local-installation-identity.js';
import {
  assertPrivateDirectorySync,
  isPrivateFileStat,
  writePrivateFileAtomicSync,
} from './private-files.js';
import {
  type ApplicationStateRootOptions,
  type ApplicationStateRootSource,
  prepareApplicationStateRoot,
} from './state-root.js';
import { acquireWriterLease } from './writer-lease.js';

/** File name of the custody record in both the data root and the state root. */
export const INSTALLATION_CUSTODY_FILE = 'installation.json';

const SEED_FILE_NAME = 'application.secret';
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ACTIVATION_PATTERN = /^[a-f0-9]{32}$/;
const SEED_PATTERN = /^[A-Za-z0-9_-]{43}\n$/;
const MAX_RECORD_BYTES = 2048;
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;

/** Persisted custody record. Holds no secret material. */
export interface InstallationCustodyRecord {
  readonly schemaVersion: 1;
  /** Public installation ID derived from the seed (the local device ID). */
  readonly installationId: string;
  /** Custody-transfer counter of this installation; starts at 1. */
  readonly epoch: number;
  /** Random per-activation nonce; matches in both records when in custody. */
  readonly activationId: string;
  /** Installation this one was re-seeded from, if any. */
  readonly previousInstallationId: string | null;
  /** `retired` records that this location was moved away and must not start. */
  readonly status: 'active' | 'retired';
}

/** Why a data root is, or is not, in this location's custody. */
export type InstallationCustodyStatus =
  /** Both records agree and match the seed. */
  | 'in-custody'
  /** No record anywhere: an installation older than custody records. */
  | 'unrecorded'
  /** Records travel with the data root but this location never activated it. */
  | 'arrived'
  /** The data root was activated by another location or at another time. */
  | 'diverged'
  /** This location knows the installation but the data root lost its record. */
  | 'data-record-missing'
  /** This location was retired by `retire`. */
  | 'retired'
  /** The seed's identity differs from the recorded installation. */
  | 'seed-mismatch'
  /** The seed file is gone from an initialized data root. */
  | 'seed-missing'
  /** A record is malformed, oversized, a link, or not private. */
  | 'record-invalid';

/** Operator declarations that can resolve a status. */
export type InstallationCustodyResolution =
  | 'restore'
  | 'reseed'
  | 'recover-seed';

/** Pure inputs to {@link assessInstallationCustody}. */
export interface InstallationCustodyEvidence {
  readonly data: InstallationCustodyRecord | null | 'invalid';
  readonly state: InstallationCustodyRecord | null | 'invalid';
  /** Installation ID derived from the present seed, or `null` when absent. */
  readonly installationId: string | null;
}

/** Classify the evidence. Pure; performs no I/O. */
export function assessInstallationCustody(
  evidence: InstallationCustodyEvidence,
): InstallationCustodyStatus {
  const { data, state, installationId } = evidence;
  if (installationId === null) return 'seed-missing';
  const dataRecord = data !== null && data !== 'invalid' ? data : null;
  const stateRecord = state !== null && state !== 'invalid' ? state : null;
  const dataMatches = dataRecord?.installationId === installationId;
  // The data record is bound to the data root, so it is the authority on which
  // installation this seed belongs to; a record that disagrees with the seed
  // means the seed was substituted, whatever else is damaged. This runs before
  // record-invalid so a corrupted record cannot launder a different seed.
  if (dataRecord && !dataMatches) return 'seed-mismatch';
  // Without a corroborating data record the location's own memory is all
  // there is, and it must agree with the seed.
  if (stateRecord && stateRecord.installationId !== installationId) {
    if (!dataMatches) return 'seed-mismatch';
  }
  if (data === 'invalid' || state === 'invalid') return 'record-invalid';
  if (!dataRecord && !stateRecord) return 'unrecorded';
  // This location last hosted a different installation than the one that
  // arrived (the data root was deleted and another installation's backup put
  // at the same path). Only the operator can say it is the same one.
  if (stateRecord && stateRecord.installationId !== installationId) {
    return 'diverged';
  }
  if (stateRecord?.status === 'retired') return 'retired';
  if (dataRecord && stateRecord) {
    return dataRecord.activationId === stateRecord.activationId
      ? 'in-custody'
      : 'diverged';
  }
  return dataRecord ? 'arrived' : 'data-record-missing';
}

/** Where this location's custody record lives, for operator messages. */
export interface InstallationStateRootNote {
  readonly stateRoot: string;
  readonly source: ApplicationStateRootSource;
  /** Testable platform override. */
  readonly platformName?: NodeJS.Platform | string;
}

/**
 * Sentence telling the operator which state root holds this location's
 * custody record and what must persist. The record is what makes a restart of
 * a persisted data root attributable: when the state root lives under a home
 * directory that is recreated on every start (a container with an ephemeral
 * filesystem and a persistent data volume), the first start after the
 * environment is rebuilt looks like an unverified arrival and the process
 * cannot start without an operator declaration.
 */
export function describeInstallationStateRoot(
  note: InstallationStateRootNote,
): string {
  const where = `This location's custody record is in the state root ${note.stateRoot}`;
  const platformName = note.platformName ?? process.platform;
  if (note.source === 'xdg-state-home') {
    return `${where} (from XDG_STATE_HOME); it must persist as long as the data root does.`;
  }
  const home =
    platformName === 'darwin' || platformName === 'win32'
      ? 'a persistent user profile'
      : 'a persistent XDG_STATE_HOME outside the data root';
  return `${where}, which is derived from ${note.source === 'local-app-data' ? 'LOCALAPPDATA' : 'the home directory'}. If this process runs where that directory is recreated on restart (for example a container with a persistent data volume but an ephemeral home), the record is lost and every restart looks like an unverified arrival; run it with ${home}.`;
}

/** Declarations that resolve `status` (empty when none is needed). */
export function installationCustodyResolutions(
  status: InstallationCustodyStatus,
): readonly InstallationCustodyResolution[] {
  switch (status) {
    case 'in-custody':
    case 'unrecorded':
      return [];
    case 'seed-missing':
    case 'seed-mismatch':
      return ['recover-seed', 'reseed'];
    default:
      return ['restore', 'reseed'];
  }
}

const RESTORE_COMMAND = '"smrt app installation restore --origin-retired"';
const RESEED_COMMAND = '"smrt app installation reseed --confirm-destroy-seed"';
const RECOVER_COMMAND = '"smrt app installation recover-seed <seed-file>"';

/**
 * What the operator can do about a refused `status`, naming only commands that
 * will actually accept it (see {@link installationCustodyResolutions}): a
 * substituted seed is not something `restore` resolves, so it points at
 * `recover-seed` or `reseed` instead.
 */
export function installationCustodyHint(
  status: InstallationCustodyStatus,
): string {
  switch (status) {
    case 'in-custody':
    case 'unrecorded':
      return '';
    case 'seed-mismatch':
      return `The seed in this data root is not the one this installation was recorded with, and "restore" refuses a substituted seed. Put the original seed back with ${RECOVER_COMMAND} (the backup must derive the recorded installation), or accept a new independent installation with ${RESEED_COMMAND}.`;
    case 'seed-missing':
      return `The seed is gone. Restore it from a backup with ${RECOVER_COMMAND}, or accept a new independent installation with ${RESEED_COMMAND}.`;
    case 'retired':
      return `This location was retired. Bring it back with ${RESTORE_COMMAND} once no other location runs this installation, or make it an independent installation with ${RESEED_COMMAND}.`;
    case 'record-invalid':
      return `A custody record is malformed, a link or not private. If this is the same installation, moved or restored with its origin stopped or deleted, rewrite the records with ${RESTORE_COMMAND}; for an independent copy use ${RESEED_COMMAND}.`;
    default:
      return `If this is the same installation, moved or restored with its origin stopped or deleted, declare it with ${RESTORE_COMMAND}; for an independent copy whose origin stays active use ${RESEED_COMMAND}.`;
  }
}

/** Secret-free report of one installation's custody. */
export interface InstallationCustodyReport {
  readonly schemaVersion: 1;
  readonly status: InstallationCustodyStatus;
  /** Derived from the present seed; `null` when the seed is missing. */
  readonly installationId: string | null;
  /** Installation named by the records, when they agree on one. */
  readonly recordedInstallationId: string | null;
  readonly epoch: number | null;
  readonly resolutions: readonly InstallationCustodyResolution[];
  readonly secretValuesIncluded: false;
}

/** Explicit consequences of a declaration. */
export interface InstallationCustodyEffects {
  /** Device, tenant, owner, profile and membership derivations changed. */
  readonly identityChanged: boolean;
  /** Seed-keyed bootstrap and local MCP tokens no longer verify. */
  readonly seedKeyedTokensInvalidated: boolean;
  /** Active local MCP tokens revoked by this declaration. */
  readonly mcpTokensRevoked: number;
}

/** Result of a declaration. */
export interface InstallationCustodyOutcome {
  readonly schemaVersion: 1;
  readonly declaration: InstallationCustodyResolution | 'retire';
  readonly installationId: string | null;
  readonly previousInstallationId: string | null;
  readonly epoch: number | null;
  readonly effects: InstallationCustodyEffects;
  /** Custody status after the declaration. */
  readonly status: InstallationCustodyStatus;
  readonly secretValuesIncluded: false;
}

/** Options shared by the operator-facing custody functions. */
export interface InstallationCustodyOptions
  extends ResolveLocalRuntimePathsOptions {
  /** Operation-lock instance when the caller already holds `operation.lock`. */
  operationInstance?: string;
}

/** Options for {@link restoreInstallation}. */
export interface RestoreInstallationOptions extends InstallationCustodyOptions {
  /**
   * Must be `true`: the operator asserts the origin of this move is no longer
   * active (stopped, deleted, or retired). The runtime cannot verify this
   * across machines; two active origins are exactly what `reseed` is for.
   */
  originRetired: boolean;
}

/** Refusal text of {@link reseedInstallation} without confirmation. */
export const RESEED_CONFIRMATION_MESSAGE =
  'Re-seeding permanently destroys this installation seed (it is not kept), changes the device, tenant, owner, profile and membership identities and revokes every active local MCP token. Nothing was changed. Back up secrets/application.secret first if you may need the old identity, then confirm with --confirm-destroy-seed.';

/** Options for {@link reseedInstallation}. */
export interface ReseedInstallationOptions extends InstallationCustodyOptions {
  /**
   * Must be `true`: the operator confirms the current seed is destroyed (it
   * is not kept), every derived identity changes, and active local MCP tokens
   * are revoked. Re-seeding is irreversible without a backup of the seed, so
   * it never runs on a default.
   */
  confirmDestroySeed: boolean;
}

/** Options for {@link recoverInstallationSeed}. */
export interface RecoverInstallationSeedOptions
  extends InstallationCustodyOptions {
  /** Path to a backed-up copy of `application.secret`. */
  seedFile: string;
  /**
   * Accept a seed when no record names the installation, so it cannot be
   * checked. A wrong seed silently changes every identity; use with care.
   */
  allowUnverified?: boolean;
}

function stateRootFor(options: InstallationCustodyOptions): string {
  return prepareApplicationStateRoot(stateRootOptions(options));
}

/**
 * State-root options for an init/custody call. Exactly the inputs the web
 * writer lease and `smrt app` use (`defaultWriterLease`, `preparedStateRoot`):
 * the state root is a lock domain, so custody must live in the same one.
 */
export function stateRootOptions(
  options: ResolveLocalRuntimePathsOptions,
): ApplicationStateRootOptions {
  return {
    appId: options.appId,
    dataDirectory: options.dataDirectory,
    sourceRoot: options.sourceRoot,
  };
}

function parseRecord(contents: string): InstallationCustodyRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort().join(',');
  if (
    keys !==
    'activationId,epoch,installationId,previousInstallationId,schemaVersion,status'
  ) {
    return null;
  }
  const {
    installationId,
    epoch,
    activationId,
    previousInstallationId,
    status,
  } = record;
  if (
    record.schemaVersion !== 1 ||
    typeof installationId !== 'string' ||
    !UUID_PATTERN.test(installationId) ||
    typeof epoch !== 'number' ||
    !Number.isSafeInteger(epoch) ||
    epoch < 1 ||
    typeof activationId !== 'string' ||
    !ACTIVATION_PATTERN.test(activationId) ||
    (previousInstallationId !== null &&
      (typeof previousInstallationId !== 'string' ||
        !UUID_PATTERN.test(previousInstallationId))) ||
    (status !== 'active' && status !== 'retired')
  ) {
    return null;
  }
  return Object.freeze({
    schemaVersion: 1,
    installationId,
    epoch,
    activationId,
    previousInstallationId: previousInstallationId as string | null,
    status,
  });
}

/** Read a record: `null` when absent, `'invalid'` when present but unsafe. */
function readRecord(
  path: string,
): InstallationCustodyRecord | null | 'invalid' {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | NO_FOLLOW);
    const details = fstatSync(descriptor);
    if (!isPrivateFileStat(details, MAX_RECORD_BYTES)) return 'invalid';
    return parseRecord(readFileSync(descriptor, 'utf8')) ?? 'invalid';
  } catch (error) {
    // A missing record is absence; a link (ELOOP) or anything else is not.
    return errorCode(error) === 'ENOENT' ? null : 'invalid';
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function writeRecord(path: string, record: InstallationCustodyRecord): void {
  writePrivateFileAtomicSync(path, `${JSON.stringify(record)}\n`);
}

/**
 * Read a seed file. `null` when absent. The live seed must be exactly
 * current-user mode 0600; `lenientMode` accepts any owner-only mode for a
 * backup being restored.
 */
function readSeed(path: string, lenientMode = false): string | null {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | NO_FOLLOW);
    const details = fstatSync(descriptor);
    const modeOk = lenientMode
      ? (details.mode & 0o077) === 0
      : (details.mode & 0o777) === 0o600;
    if (!isPrivateFileStat(details, 64) || !modeOk || details.size !== 44) {
      throw new Error(
        'The installation seed must be a complete current-user-owned private file; for a backup copy, chmod 600 it first.',
      );
    }
    const buffer = Buffer.alloc(44);
    if (readSync(descriptor, buffer, 0, 44, 0) !== 44) {
      throw new Error('The installation seed is incomplete.');
    }
    const seed = buffer.toString('utf8');
    if (!SEED_PATTERN.test(seed)) {
      throw new Error('The installation seed is not in the expected format.');
    }
    return seed;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    if (
      error instanceof Error &&
      error.message.startsWith('The installation')
    ) {
      throw error;
    }
    throw new Error(
      'The installation seed cannot be read safely (it may be a link or not private).',
    );
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

/**
 * The secrets directory must be a real current-user directory. Like runtime
 * initialization, repair its mode to 0700: a copy made with the default umask
 * (`smrt app backup` uses one) arrives with group/other access.
 */
function assertPrivateDirectory(path: string): void {
  try {
    assertPrivateDirectorySync(path);
  } catch {
    throw new Error(
      'The installation secrets directory must be a real current-user directory.',
    );
  }
}

function seedPath(secretsDirectory: string): string {
  return join(secretsDirectory, SEED_FILE_NAME);
}

function installationIdOf(seed: string | null): string | null {
  return seed === null ? null : deriveLocalInstallationIdentity(seed).deviceId;
}

interface Evidence extends InstallationCustodyEvidence {
  readonly dataPath: string;
  readonly statePath: string;
}

function gatherEvidence(
  secretsDirectory: string,
  stateRoot: string,
  /**
   * The caller's already-validated installation ID, or `null` to treat the
   * seed as unavailable; the seed is read when omitted.
   */
  knownInstallationId?: string | null,
): Evidence {
  const dataPath = join(secretsDirectory, INSTALLATION_CUSTODY_FILE);
  const statePath = join(stateRoot, INSTALLATION_CUSTODY_FILE);
  return {
    data: readRecord(dataPath),
    state: readRecord(statePath),
    installationId:
      knownInstallationId !== undefined
        ? knownInstallationId
        : installationIdOf(readSeed(seedPath(secretsDirectory))),
    dataPath,
    statePath,
  };
}

function validRecords(
  evidence: InstallationCustodyEvidence,
): InstallationCustodyRecord[] {
  return [evidence.data, evidence.state].filter(
    (record): record is InstallationCustodyRecord =>
      record !== null && record !== 'invalid',
  );
}

/** The installation the records name; the data record is the authority. */
function recordedId(evidence: InstallationCustodyEvidence): string | null {
  const [first] = [evidence.data, evidence.state].filter(
    (record): record is InstallationCustodyRecord =>
      record !== null && record !== 'invalid',
  );
  return first?.installationId ?? null;
}

function reportFor(
  evidence: InstallationCustodyEvidence,
): InstallationCustodyReport {
  const status = assessInstallationCustody(evidence);
  const records = validRecords(evidence).filter(
    (record) =>
      evidence.installationId === null ||
      record.installationId === evidence.installationId,
  );
  return Object.freeze({
    schemaVersion: 1,
    status,
    installationId: evidence.installationId,
    recordedInstallationId: recordedId(evidence),
    epoch: records.length ? Math.max(...records.map((r) => r.epoch)) : null,
    resolutions: installationCustodyResolutions(status),
    secretValuesIncluded: false,
  });
}

function newRecord(
  installationId: string,
  epoch: number,
  previousInstallationId: string | null,
): InstallationCustodyRecord {
  return Object.freeze({
    schemaVersion: 1,
    installationId,
    epoch,
    activationId: randomBytes(16).toString('hex'),
    previousInstallationId,
    status: 'active',
  });
}

/** Write the state record first so a crash leaves a recoverable status. */
function activate(evidence: Evidence, record: InstallationCustodyRecord): void {
  writeRecord(evidence.statePath, record);
  writeRecord(evidence.dataPath, record);
}

/** Result of {@link enforceInstallationCustody}. */
export type InstallationCustodyEnforcement =
  | { readonly kind: 'established'; readonly epoch: number }
  | { readonly kind: 'in-custody'; readonly epoch: number }
  | { readonly kind: 'refused'; readonly report: InstallationCustodyReport };

/**
 * Startup check used by the local runtime, under the initialization lock.
 *
 * `seedIsNew` is true only when this very run created the seed: nothing can
 * predate it, so custody is established and any stale record for a deleted
 * data root at this location is replaced. A seed that already existed (even
 * beside an empty database, as when the database file was dropped from a copy)
 * is judged like any other arrival: a legacy installation with no records at
 * all is adopted at epoch 1 (trust on first use); everything else must already
 * be in custody or is refused without changing anything.
 *
 * `initialized` is whether the runtime ever finished first-run setup in this
 * data root. A first run that stopped between its two record writes leaves
 * only the location's record; since nothing was initialized, finishing that
 * activation is safe (a copy always carries the data record).
 */
export function enforceInstallationCustody(input: {
  secretsDirectory: string;
  stateRoot: string;
  installationId: string;
  seedIsNew: boolean;
  initialized: boolean;
}): InstallationCustodyEnforcement {
  const evidence = gatherEvidence(
    input.secretsDirectory,
    input.stateRoot,
    input.installationId,
  );
  if (input.seedIsNew) {
    activate(evidence, newRecord(input.installationId, 1, null));
    return { kind: 'established', epoch: 1 };
  }
  const report = reportFor(evidence);
  if (report.status === 'unrecorded') {
    activate(evidence, newRecord(input.installationId, 1, null));
    return { kind: 'established', epoch: 1 };
  }
  if (report.status === 'in-custody') {
    return { kind: 'in-custody', epoch: report.epoch ?? 1 };
  }
  if (
    report.status === 'data-record-missing' &&
    !input.initialized &&
    evidence.state &&
    evidence.state !== 'invalid' &&
    evidence.state.epoch === 1 &&
    evidence.state.status === 'active'
  ) {
    writeRecord(evidence.dataPath, evidence.state);
    return { kind: 'established', epoch: 1 };
  }
  return { kind: 'refused', report };
}

async function withInstallationExclusive<T>(
  options: InstallationCustodyOptions,
  callback: (context: {
    paths: ReturnType<typeof resolveLocalRuntimePaths>;
    stateRoot: string;
  }) => Promise<T> | T,
): Promise<T> {
  const paths = await validateLocalDatabaseStorage(options);
  assertPrivateDirectory(paths.secrets);
  const stateRoot = stateRootFor(options);
  // Order matches the runtime: writer lease, then the initialization lock.
  const lease = acquireWriterLease(stateRoot, {
    operationInstance: options.operationInstance,
  });
  try {
    return await withLocalInitializationLock(paths.root, () =>
      callback({ paths, stateRoot }),
    );
  } finally {
    lease.release();
  }
}

/** Installation carried by one data root, judged from that root alone. */
export interface DataRootInstallation {
  /** Derived from the root's seed; `null` when the seed is absent. */
  readonly installationId: string | null;
  /**
   * `consistent`: seed and data custody record agree. `unrecorded`: a seed
   * without a record (an installation older than custody records). `empty`:
   * neither exists. Anything else must not be restored into place.
   */
  readonly status:
    | 'consistent'
    | 'unrecorded'
    | 'empty'
    | 'seed-missing'
    | 'seed-mismatch'
    | 'record-invalid';
}

/**
 * Read-only check of a data root's own seed and custody record, without any
 * state root (#4805: verifying a restore candidate before it is swapped in).
 * Throws when the seed exists but cannot be read safely.
 */
export function inspectDataRootInstallation(
  secretsDirectory: string,
): DataRootInstallation {
  const record = readRecord(join(secretsDirectory, INSTALLATION_CUSTODY_FILE));
  const installationId = installationIdOf(readSeed(seedPath(secretsDirectory)));
  if (installationId === null) {
    return {
      installationId,
      status: record === null ? 'empty' : 'seed-missing',
    };
  }
  if (record === 'invalid') return { installationId, status: 'record-invalid' };
  if (record === null) return { installationId, status: 'unrecorded' };
  return {
    installationId,
    status:
      record.installationId === installationId ? 'consistent' : 'seed-mismatch',
  };
}

/**
 * What this location's own record (state root only) says about custody.
 * `retired`: the installation was moved away from this location (a move, or a
 * migration to the cloud, #4806). `invalid`: the record cannot be trusted.
 * Read-only; needs no data root, so a restore can check it before touching one.
 */
export function inspectLocationCustodyRecord(
  stateRoot: string,
): 'none' | 'active' | 'retired' | 'invalid' {
  const record = readRecord(join(stateRoot, INSTALLATION_CUSTODY_FILE));
  if (record === null) return 'none';
  if (record === 'invalid') return 'invalid';
  return record.status;
}

/** Report the custody status of an initialized local installation. Read-only. */
export async function inspectInstallationCustody(
  options: InstallationCustodyOptions,
): Promise<InstallationCustodyReport> {
  const paths = await validateLocalDatabaseStorage(options);
  assertPrivateDirectory(paths.secrets);
  return reportFor(gatherEvidence(paths.secrets, stateRootFor(options)));
}

function effects(
  partial: Partial<InstallationCustodyEffects> = {},
): InstallationCustodyEffects {
  return Object.freeze({
    identityChanged: false,
    seedKeyedTokensInvalidated: false,
    mcpTokensRevoked: 0,
    ...partial,
  });
}

/**
 * Declare an arrival to be the same installation, moved or restored.
 *
 * The seed must be present and match the recorded installation, so identities
 * and tokens are unchanged. Custody moves here: `epoch` is bumped and a new
 * activation is written to both records. Refuses a seed mismatch or missing
 * seed (use `recover-seed` or `reseed`).
 */
export async function restoreInstallation(
  options: RestoreInstallationOptions,
): Promise<InstallationCustodyOutcome> {
  if (options.originRetired !== true) {
    throw new Error(
      'Restoring an installation requires asserting that its origin is no longer active (--origin-retired). If the origin stays active, re-seed this copy instead.',
    );
  }
  return withInstallationExclusive(options, ({ paths, stateRoot }) => {
    const evidence = gatherEvidence(paths.secrets, stateRoot);
    const report = reportFor(evidence);
    if (report.status === 'in-custody') {
      return outcome('restore', report, report, effects());
    }
    if (!report.resolutions.includes('restore') || !evidence.installationId) {
      throw new Error(
        `Installation custody status "${report.status}" cannot be resolved by restore; run "smrt app installation status".`,
      );
    }
    // A stale record of another installation never inflates this epoch.
    const known = validRecords(evidence).filter(
      (record) => record.installationId === evidence.installationId,
    );
    const epoch = Math.max(0, ...known.map((record) => record.epoch)) + 1;
    const previous =
      known.find((record) => record.previousInstallationId)
        ?.previousInstallationId ?? null;
    activate(evidence, newRecord(evidence.installationId, epoch, previous));
    return outcome(
      'restore',
      report,
      reportFor(gatherEvidence(paths.secrets, stateRoot)),
      effects(),
    );
  });
}

/**
 * Give this data root a new seed: an independent installation.
 *
 * Use for a copy whose origin stays active, for a lost seed with no backup,
 * and for planned rotation. Effects, all explicit in the outcome: the device,
 * tenant, owner, profile and membership derivations change (existing rows keep
 * the IDs they were created with; only new derivations differ); every
 * seed-keyed bootstrap and local MCP token stops verifying, and active local
 * MCP tokens are revoked so `smrt app token list` stays truthful; sessions and
 * all application data are untouched. The previous seed is not retained.
 * Re-running after an interruption simply generates another seed.
 *
 * Irreversible, so it needs `confirmDestroySeed: true` (the CLI's
 * `--confirm-destroy-seed`), the counterpart of `restore`'s `originRetired`.
 */
export async function reseedInstallation(
  options: ReseedInstallationOptions,
): Promise<InstallationCustodyOutcome> {
  // Checked before the lock, the state root or any file is touched.
  if (options.confirmDestroySeed !== true) {
    throw new Error(RESEED_CONFIRMATION_MESSAGE);
  }
  return withInstallationExclusive(options, async ({ paths, stateRoot }) => {
    // A seed that is unreadable (lax mode, a link) is exactly what reseed is
    // for: treat it as unavailable rather than failing.
    let before: Evidence;
    try {
      before = gatherEvidence(paths.secrets, stateRoot);
    } catch {
      before = gatherEvidence(paths.secrets, stateRoot, null);
    }
    const reportBefore = reportFor(before);
    const previousInstallationId =
      before.installationId ?? recordedId(before) ?? null;
    let revoked = 0;
    const store = await openLocalMcpTokenStore(options);
    try {
      for (const token of await store.list()) {
        if (token.status !== 'active') continue;
        if ((await store.revoke(token.id)) === 'revoked') revoked += 1;
      }
    } finally {
      await store.close();
    }
    const seed = `${randomBytes(32).toString('base64url')}\n`;
    writePrivateFileAtomicSync(seedPath(paths.secrets), seed);
    const installationId = installationIdOf(seed) as string;
    activate(before, newRecord(installationId, 1, previousInstallationId));
    return outcome(
      'reseed',
      reportBefore,
      reportFor(gatherEvidence(paths.secrets, stateRoot)),
      effects({
        identityChanged: true,
        seedKeyedTokensInvalidated: true,
        mcpTokensRevoked: revoked,
      }),
    );
  });
}

/**
 * Put a backed-up seed back after loss or replacement.
 *
 * The backup must derive the installation the records name, so identities and
 * tokens come back exactly as they were. Nothing is regenerated, and there is
 * no escrow: without a backup, use {@link reseedInstallation}. The seed value
 * is never returned or logged.
 */
export async function recoverInstallationSeed(
  options: RecoverInstallationSeedOptions,
): Promise<InstallationCustodyOutcome> {
  return withInstallationExclusive(options, ({ paths, stateRoot }) => {
    const evidence = gatherEvidence(paths.secrets, stateRoot);
    const reportBefore = reportFor(evidence);
    if (!reportBefore.resolutions.includes('recover-seed')) {
      throw new Error(
        `Installation custody status "${reportBefore.status}" has no seed to recover; run "smrt app installation status".`,
      );
    }
    const backup = readSeed(options.seedFile, true);
    if (backup === null) {
      throw new Error('The backup seed file does not exist.');
    }
    const recovered = installationIdOf(backup) as string;
    const expected = recordedId(evidence);
    if (expected === null && options.allowUnverified !== true) {
      throw new Error(
        'No record names this installation, so the backup seed cannot be verified; re-run with --unverified only if you are certain it belongs to this data root.',
      );
    }
    if (expected !== null && recovered !== expected) {
      throw new Error(
        'The backup seed does not belong to this installation; nothing was changed.',
      );
    }
    writePrivateFileAtomicSync(seedPath(paths.secrets), backup);
    return outcome(
      'recover-seed',
      reportBefore,
      reportFor(gatherEvidence(paths.secrets, stateRoot)),
      effects(),
    );
  });
}

/**
 * Mark this location's installation as moved away. After `retire` the runtime
 * refuses to start here until `restore` re-activates it. Use on the origin of
 * a move before (or after) restoring the destination.
 */
export async function retireInstallation(
  options: InstallationCustodyOptions,
): Promise<InstallationCustodyOutcome> {
  return withInstallationExclusive(options, ({ paths, stateRoot }) => {
    const evidence = gatherEvidence(paths.secrets, stateRoot);
    const reportBefore = reportFor(evidence);
    if (evidence.installationId === null) {
      throw new Error(
        'A retired installation needs its seed; recover or re-seed first.',
      );
    }
    const existing =
      evidence.state && evidence.state !== 'invalid'
        ? evidence.state
        : evidence.data && evidence.data !== 'invalid'
          ? evidence.data
          : newRecord(evidence.installationId, 1, null);
    if (existing.installationId !== evidence.installationId) {
      throw new Error(
        'The recorded installation does not match the seed; resolve that before retiring.',
      );
    }
    writeRecord(evidence.statePath, { ...existing, status: 'retired' });
    return outcome(
      'retire',
      reportBefore,
      reportFor(gatherEvidence(paths.secrets, stateRoot)),
      effects(),
    );
  });
}

function outcome(
  declaration: InstallationCustodyOutcome['declaration'],
  before: InstallationCustodyReport,
  after: InstallationCustodyReport,
  declared: InstallationCustodyEffects,
): InstallationCustodyOutcome {
  return Object.freeze({
    schemaVersion: 1,
    declaration,
    installationId: after.installationId,
    previousInstallationId:
      before.installationId ?? before.recordedInstallationId,
    epoch: after.epoch,
    effects: declared,
    status: after.status,
    secretValuesIncluded: false,
  });
}
