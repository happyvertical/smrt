/**
 * Filesystem asset portability for logical export/import bundles.
 *
 * Ported unchanged from the template's `scripts/smrt-portability-assets.mjs`:
 * the bundle format, limits, sanitized failure codes, staging journal, and
 * crash-recovery rules are a persisted contract.
 */

import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ASSET_MANIFEST_SCHEMA_VERSION = 1;
export const MAX_ASSET_COUNT = 1_000;
export const MAX_ASSET_BYTES = 64 * 1024 * 1024;
export const MAX_TOTAL_ASSET_BYTES = 256 * 1024 * 1024;
export const MAX_BUNDLE_BYTES = 512 * 1024 * 1024;

const ASSET_URI_PREFIX = 'smrt-bundle://asset/';
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const MAX_BASE64_ASSET_LENGTH = Math.ceil(MAX_ASSET_BYTES / 3) * 4;

/** Row shape of an exported table. */
export type PortableRow = Record<string, unknown>;

/** Exported table as it appears in a bundle. */
export interface PortableTable {
  name: string;
  columns: string[];
  rows: PortableRow[];
}

/** One asset entry of the bundle manifest. */
export interface AssetManifestEntry {
  key: string;
  byteLength: number;
  contentDigest: string;
  payloadPath: string;
}

/** One embedded asset payload. */
export interface AssetPayload {
  path: string;
  encoding: 'base64';
  data: string;
}

/** Asset section of a bundle. */
export interface AssetBundle {
  schemaVersion: number;
  adapter: 'filesystem';
  entries: AssetManifestEntry[];
  payloads: AssetPayload[];
}

/** Verified asset ready to stage. */
export interface VerifiedAsset {
  key: string;
  bytes: Buffer;
  contentDigest: string;
  relativePath: string;
}

/** Result of {@link verifyFilesystemAssets}. */
export interface VerifiedAssets {
  root: string | null;
  entries: VerifiedAsset[];
}

/** Persisted asset-import journal. */
export interface AssetImportJournal {
  schemaVersion: 1;
  application: string;
  bundleDigest: string;
  assetRoot: string;
  stageRoot: string;
  phase: 'staging' | 'publishing' | 'published';
  rootExisted: boolean;
  entries: Array<{ relativePath: string; contentDigest: string }>;
}

/** A staged import: journal path plus its in-memory journal. */
export interface StagedAssets {
  path: string;
  journal: AssetImportJournal;
}

/** Sanitized asset-portability failure with a stable kebab-case `code`. */
export class AssetPortabilityError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`Asset portability validation failed (${code}).`);
    this.name = 'AssetPortabilityError';
    this.code = code;
  }
}

function fail(code: string): AssetPortabilityError {
  return new AssetPortabilityError(code);
}

function isSanitizedFailure(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    typeof (error as { code?: unknown }).code === 'string' &&
    /^[a-z][a-z0-9-]*$/.test((error as { code: string }).code)
  );
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

/** `sha256:<hex>` digest of bytes. */
export function digestBytes(value: string | Buffer): string {
  return `sha256:${sha256(value)}`;
}

function isInside(parent: string, child: string): boolean {
  const nested = relative(parent, child);
  return nested !== '' && nested !== '..' && !nested.startsWith(`..${sep}`);
}

function assertOutsideSource(
  sourceRoot: string,
  candidate: string,
  code: string,
): string {
  const source = realpathSync(sourceRoot);
  const resolved = resolve(candidate);
  if (
    resolved === source ||
    isInside(source, resolved) ||
    isInside(resolved, source)
  ) {
    throw fail(code);
  }
  return resolved;
}

function assertRealDirectory(path: string, code: string): string {
  try {
    const details = lstatSync(path);
    if (details.isSymbolicLink() || !details.isDirectory()) throw fail(code);
    if (realpathSync(path) !== resolve(path)) throw fail(code);
    return resolve(path);
  } catch (error) {
    if (isSanitizedFailure(error)) throw error;
    throw fail(code);
  }
}

/** Validate an asset root: absolute, outside the source tree, real directory. */
export function assertAssetRoot({
  sourceRoot,
  assetRoot,
  allowMissing = false,
}: {
  sourceRoot: string;
  assetRoot: unknown;
  allowMissing?: boolean;
}): string {
  if (typeof assetRoot !== 'string' || !isAbsolute(assetRoot)) {
    throw fail('asset-root-required');
  }
  const root = assertOutsideSource(sourceRoot, assetRoot, 'unsafe-asset-root');
  const parent = dirname(root);
  assertRealDirectory(parent, 'unsafe-asset-root');
  if (existsSync(root)) {
    assertRealDirectory(root, 'unsafe-asset-root');
  } else if (!allowMissing) {
    throw fail('asset-root-missing');
  }
  return root;
}

function normalizePayloadPath(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 512 ||
    value.includes('\\') ||
    value.includes('\0') ||
    value.startsWith('/') ||
    value
      .split('/')
      .some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw fail('unsafe-payload-path');
  }
  return value;
}

function normalizeDestinationPath(value: unknown): string {
  const normalized = normalizePayloadPath(value);
  if (!/^portable\/[a-f0-9]{64}$/.test(normalized)) {
    throw fail('unsafe-destination-path');
  }
  return normalized;
}

function portableUri(key: string): string {
  return `${ASSET_URI_PREFIX}${encodeURIComponent(key)}`;
}

function payloadPathForKey(key: string): string {
  return `payloads/${sha256(key)}`;
}

function destinationPathForKey(key: string): string {
  return `portable/${sha256(key)}`;
}

function readBoundedDescriptor(
  descriptor: number,
  expectedSize: number,
  changedCode: string,
): Buffer {
  const bytes = Buffer.alloc(expectedSize);
  let offset = 0;
  while (offset < expectedSize) {
    const count = readSync(
      descriptor,
      bytes,
      offset,
      expectedSize - offset,
      null,
    );
    if (count === 0) throw fail(changedCode);
    offset += count;
  }
  const overflowProbe = Buffer.allocUnsafe(1);
  if (readSync(descriptor, overflowProbe, 0, 1, null) !== 0) {
    throw fail(changedCode);
  }
  return bytes;
}

function readRegularFileUnchecked(
  path: string,
  approvedRoot: string,
  onOpened?: () => void,
): Buffer {
  const lexicalPath = resolve(path);
  if (!isInside(approvedRoot, lexicalPath)) throw fail('asset-outside-root');
  const before = lstatSync(lexicalPath);
  if (before.isSymbolicLink() || !before.isFile()) {
    throw fail('asset-not-regular');
  }
  if (before.size > MAX_ASSET_BYTES) throw fail('asset-too-large');
  if (!isInside(approvedRoot, realpathSync(lexicalPath))) {
    throw fail('asset-outside-root');
  }
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const descriptor = openSync(lexicalPath, constants.O_RDONLY | noFollow);
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.size !== before.size) {
      throw fail('asset-changed-during-read');
    }
    onOpened?.();
    const openedPath = statSync(lexicalPath);
    if (
      !isInside(approvedRoot, realpathSync(lexicalPath)) ||
      openedPath.dev !== opened.dev ||
      openedPath.ino !== opened.ino
    ) {
      throw fail('asset-changed-during-read');
    }
    const bytes = readBoundedDescriptor(
      descriptor,
      opened.size,
      'asset-changed-during-read',
    );
    const after = fstatSync(descriptor);
    const afterPath = statSync(lexicalPath);
    if (
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      bytes.byteLength !== opened.size ||
      !isInside(approvedRoot, realpathSync(lexicalPath)) ||
      afterPath.dev !== opened.dev ||
      afterPath.ino !== opened.ino
    ) {
      throw fail('asset-changed-during-read');
    }
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

function readRegularFile(
  path: string,
  approvedRoot: string,
  onOpened?: () => void,
): Buffer {
  try {
    return readRegularFileUnchecked(path, approvedRoot, onOpened);
  } catch (error) {
    if (isSanitizedFailure(error)) throw error;
    throw fail('asset-changed-during-read');
  }
}

function pathFromSourceUri(sourceUri: unknown): string {
  if (typeof sourceUri !== 'string' || !sourceUri.startsWith('file://')) {
    throw fail('unsupported-asset-source');
  }
  try {
    return fileURLToPath(sourceUri);
  } catch {
    throw fail('unsupported-asset-source');
  }
}

function assetRows(tables: unknown[]): PortableRow[] {
  const table = tables.find(
    (candidate) => (candidate as { name?: unknown } | null)?.name === 'assets',
  ) as Partial<PortableTable> | undefined;
  if (!table) return [];
  if (
    !Array.isArray(table.rows) ||
    !table.columns?.includes('id') ||
    !table.columns?.includes('source_uri')
  ) {
    throw fail('invalid-asset-table');
  }
  return table.rows;
}

/** Replace provider paths with logical keys while collecting verified payloads. */
export function collectFilesystemAssets({
  tables,
  sourceRoot,
  assetRoot,
  onSourceOpened,
}: {
  tables: PortableTable[];
  sourceRoot: string;
  assetRoot: string | null | undefined;
  onSourceOpened?: () => void;
}): AssetBundle {
  const rows = assetRows(tables);
  if (rows.length === 0) {
    return {
      schemaVersion: ASSET_MANIFEST_SCHEMA_VERSION,
      adapter: 'filesystem',
      entries: [],
      payloads: [],
    };
  }
  if (rows.length > MAX_ASSET_COUNT) throw fail('too-many-assets');
  const root = assertAssetRoot({ sourceRoot, assetRoot });
  const keys = new Set<string>();
  const payloadPaths = new Set<string>();
  const entries: AssetManifestEntry[] = [];
  const payloads: AssetPayload[] = [];
  let totalBytes = 0;
  for (const row of rows) {
    if (!row?.source_uri) continue;
    const key = String(row.id || '');
    if (!key || key.length > 512 || keys.has(key)) {
      throw fail('duplicate-asset-key');
    }
    keys.add(key);
    const payloadPath = payloadPathForKey(key);
    if (payloadPaths.has(payloadPath)) throw fail('duplicate-payload-path');
    payloadPaths.add(payloadPath);
    const bytes = readRegularFile(
      pathFromSourceUri(row.source_uri),
      root,
      onSourceOpened,
    );
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_TOTAL_ASSET_BYTES) throw fail('asset-total-too-large');
    const contentDigest = digestBytes(bytes);
    entries.push({
      key,
      byteLength: bytes.byteLength,
      contentDigest,
      payloadPath,
    });
    payloads.push({
      path: payloadPath,
      encoding: 'base64',
      data: bytes.toString('base64'),
    });
    row.source_uri = portableUri(key);
  }
  return {
    schemaVersion: ASSET_MANIFEST_SCHEMA_VERSION,
    adapter: 'filesystem',
    entries,
    payloads,
  };
}

function decodePayload(payload: unknown, expectedByteLength: number): Buffer {
  const candidate = payload as Partial<AssetPayload> | null;
  if (
    candidate?.encoding !== 'base64' ||
    typeof candidate.data !== 'string' ||
    candidate.data.length > MAX_BASE64_ASSET_LENGTH ||
    !BASE64_PATTERN.test(candidate.data)
  ) {
    throw fail('invalid-asset-payload');
  }
  const data = candidate.data;
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  const decodedLength = (data.length / 4) * 3 - padding;
  if (decodedLength !== expectedByteLength) throw fail('asset-size-mismatch');
  const bytes = Buffer.from(data, 'base64');
  if (bytes.toString('base64') !== data) {
    throw fail('invalid-asset-payload');
  }
  return bytes;
}

/** Validate every manifest/payload relationship and hydrate destination URIs. */
export function verifyFilesystemAssets({
  assetBundle,
  tables,
  sourceRoot,
  assetRoot,
}: {
  assetBundle: unknown;
  tables: PortableTable[];
  sourceRoot: string;
  assetRoot: string | null | undefined;
}): VerifiedAssets {
  const bundle = assetBundle as Partial<AssetBundle> | null;
  if (
    bundle?.schemaVersion !== ASSET_MANIFEST_SCHEMA_VERSION ||
    bundle?.adapter !== 'filesystem' ||
    !Array.isArray(bundle.entries) ||
    !Array.isArray(bundle.payloads)
  ) {
    throw fail('unsupported-asset-manifest');
  }
  if (bundle.entries.length > MAX_ASSET_COUNT) throw fail('too-many-assets');
  if (bundle.entries.length !== bundle.payloads.length) {
    throw fail('asset-payload-count-mismatch');
  }
  const rows = assetRows(tables);
  const rowByKey = new Map<string, PortableRow>();
  for (const row of rows) {
    if (!row?.source_uri) continue;
    const key = String(row.id || '');
    if (!key || rowByKey.has(key) || row.source_uri !== portableUri(key)) {
      throw fail('invalid-asset-reference');
    }
    rowByKey.set(key, row);
  }
  const payloadByPath = new Map<string, unknown>();
  for (const payload of bundle.payloads) {
    const path = normalizePayloadPath(
      (payload as { path?: unknown } | null)?.path,
    );
    if (payloadByPath.has(path)) throw fail('duplicate-payload-path');
    payloadByPath.set(path, payload);
  }
  const keys = new Set<string>();
  const paths = new Set<string>();
  const verified: VerifiedAsset[] = [];
  let totalBytes = 0;
  for (const rawEntry of bundle.entries) {
    const entry = rawEntry as Partial<AssetManifestEntry> | null;
    const key = typeof entry?.key === 'string' ? entry.key : '';
    const payloadPath = normalizePayloadPath(entry?.payloadPath);
    if (!key || key.length > 512 || keys.has(key)) {
      throw fail('duplicate-asset-key');
    }
    if (paths.has(payloadPath)) throw fail('duplicate-payload-path');
    keys.add(key);
    paths.add(payloadPath);
    const byteLength = entry?.byteLength;
    if (
      !Number.isSafeInteger(byteLength) ||
      (byteLength as number) < 0 ||
      (byteLength as number) > MAX_ASSET_BYTES
    ) {
      throw fail('invalid-asset-size');
    }
    if (!DIGEST_PATTERN.test(entry?.contentDigest || '')) {
      throw fail('invalid-asset-digest');
    }
    totalBytes += byteLength as number;
    if (totalBytes > MAX_TOTAL_ASSET_BYTES) throw fail('asset-total-too-large');
    const payload = payloadByPath.get(payloadPath);
    if (!payload) throw fail('missing-asset-payload');
    const bytes = decodePayload(payload, byteLength as number);
    if (bytes.byteLength !== byteLength) throw fail('asset-size-mismatch');
    if (digestBytes(bytes) !== entry?.contentDigest) {
      throw fail('asset-digest-mismatch');
    }
    if (!rowByKey.has(key)) throw fail('unreferenced-asset-payload');
    verified.push({
      key,
      bytes,
      contentDigest: entry.contentDigest as string,
      relativePath: destinationPathForKey(key),
    });
  }
  if (keys.size !== rowByKey.size) throw fail('missing-asset-entry');
  if (payloadByPath.size !== paths.size) {
    throw fail('unreferenced-asset-payload');
  }
  if (verified.length === 0) return { root: null, entries: [] };
  const root = assertAssetRoot({ sourceRoot, assetRoot, allowMissing: true });
  for (const entry of verified) {
    (rowByKey.get(entry.key) as PortableRow).source_uri = pathToFileURL(
      join(root, entry.relativePath),
    ).href;
  }
  return { root, entries: verified };
}

function journalPath(stateRoot: string, appId: string): string {
  return join(
    stateRoot,
    `.smrt-asset-import-${sha256(appId).slice(0, 16)}.json`,
  );
}

function writeJournal(path: string, journal: AssetImportJournal): void {
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(journal)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function assertEmptyAssetRoot(root: string): void {
  if (!existsSync(root)) return;
  assertRealDirectory(root, 'unsafe-asset-root');
  if (readdirSync(root).length !== 0) throw fail('non-empty-asset-target');
}

/** Stage verified bytes without publishing anything into the destination root. */
export function stageFilesystemAssets({
  verified,
  stateRoot,
  appId,
  bundleDigest,
}: {
  verified: VerifiedAssets;
  stateRoot: string;
  appId: string;
  bundleDigest: string;
}): StagedAssets | null {
  if (verified.entries.length === 0 || !verified.root) return null;
  assertEmptyAssetRoot(verified.root);
  const stageRoot = join(
    dirname(verified.root),
    `.smrt-asset-stage-${process.pid}-${randomBytes(8).toString('hex')}`,
  );
  const path = journalPath(stateRoot, appId);
  if (existsSync(path)) throw fail('asset-recovery-required');
  const journal: AssetImportJournal = {
    schemaVersion: 1,
    application: appId,
    bundleDigest,
    assetRoot: verified.root,
    stageRoot,
    phase: 'staging',
    rootExisted: existsSync(verified.root),
    entries: verified.entries.map(({ relativePath, contentDigest }) => ({
      relativePath,
      contentDigest,
    })),
  };
  writeJournal(path, journal);
  try {
    mkdirSync(stageRoot, { mode: 0o700 });
    for (const entry of verified.entries) {
      const destination = join(stageRoot, entry.relativePath);
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      writeFileSync(destination, entry.bytes, { flag: 'wx', mode: 0o600 });
      if (digestBytes(readFileSync(destination)) !== entry.contentDigest) {
        throw fail('staged-asset-digest-mismatch');
      }
    }
    return { path, journal };
  } catch (error) {
    rmSync(stageRoot, { recursive: true, force: true });
    rmSync(path, { force: true });
    throw error;
  }
}

/** Publish the complete verified tree with one rename that never follows the target. */
export function publishFilesystemAssets(
  staged: StagedAssets | null,
  options: { beforeRename?: () => void } = {},
): void {
  if (!staged) return;
  const { journal, path } = staged;
  assertEmptyAssetRoot(journal.assetRoot);
  journal.phase = 'publishing';
  writeJournal(path, journal);
  if (existsSync(journal.assetRoot)) rmdirSync(journal.assetRoot);
  try {
    options.beforeRename?.();
    renameSync(journal.stageRoot, journal.assetRoot);
  } catch (error) {
    if (journal.rootExisted && !existsSync(journal.assetRoot)) {
      mkdirSync(journal.assetRoot, { mode: 0o700 });
    }
    throw error;
  }
  journal.phase = 'published';
  writeJournal(path, journal);
  verifyPublishedTree(journal);
}

function verifyPublishedEntry(
  journal: AssetImportJournal,
  entry: { relativePath: string; contentDigest: string },
  approvedRoot: string,
  {
    allowMissing = false,
    verifyDigest = true,
  }: { allowMissing?: boolean; verifyDigest?: boolean } = {},
): boolean {
  const destination = join(
    journal.assetRoot,
    normalizeDestinationPath(entry.relativePath),
  );
  if (!existsSync(destination)) {
    if (allowMissing) return false;
    throw fail('missing-published-asset');
  }
  const bytes = readRegularFile(destination, approvedRoot);
  if (verifyDigest && digestBytes(bytes) !== entry.contentDigest) {
    throw fail('published-asset-digest-mismatch');
  }
  return true;
}

function verifyPublishedTree(
  journal: AssetImportJournal,
  { verifyDigest = true }: { verifyDigest?: boolean } = {},
): void {
  try {
    const approvedRoot = assertRealDirectory(
      journal.assetRoot,
      'unsafe-published-asset',
    );
    const rootEntries = readdirSync(approvedRoot);
    if (rootEntries.length !== 1 || rootEntries[0] !== 'portable') {
      throw fail('unexpected-published-asset');
    }
    const portableDirectory = join(approvedRoot, 'portable');
    assertRealDirectory(portableDirectory, 'unsafe-published-asset');
    const expected = new Set(
      journal.entries.map((entry) =>
        normalizeDestinationPath(entry.relativePath).slice('portable/'.length),
      ),
    );
    const actual = readdirSync(portableDirectory);
    if (
      actual.length !== expected.size ||
      actual.some((name) => !expected.has(name))
    ) {
      throw fail('unexpected-published-asset');
    }
    for (const entry of journal.entries) {
      verifyPublishedEntry(journal, entry, approvedRoot, { verifyDigest });
    }
  } catch (error) {
    if (isSanitizedFailure(error)) throw error;
    throw fail('unsafe-published-asset');
  }
}

/** Re-verify the published tree against the staged journal. */
export function verifyPublishedFilesystemAssets(
  staged: StagedAssets | null,
): void {
  if (staged) verifyPublishedTree(staged.journal);
}

function removePublishedTree(journal: AssetImportJournal): {
  quarantined: boolean;
  path?: string;
} {
  const quarantine = `${journal.stageRoot}.rollback-${randomBytes(6).toString('hex')}`;
  renameSync(journal.assetRoot, quarantine);
  const quarantinedJournal = { ...journal, assetRoot: quarantine };
  try {
    verifyPublishedTree(quarantinedJournal, { verifyDigest: false });
  } catch {
    // Never follow or recursively delete a tree that no longer matches the
    // journal. Atomic detachment leaves the actual target retryable while the
    // untrusted replacement remains quarantined for operator inspection.
    if (journal.rootExisted) mkdirSync(journal.assetRoot, { mode: 0o700 });
    return { quarantined: true, path: quarantine };
  }
  rmSync(quarantine, { recursive: true });
  if (journal.rootExisted) mkdirSync(journal.assetRoot, { mode: 0o700 });
  return { quarantined: false };
}

/** Verify the published tree and drop the journal. */
export function finishFilesystemAssets(staged: StagedAssets | null): void {
  if (!staged) return;
  verifyPublishedTree(staged.journal);
  rmSync(staged.path, { force: true });
}

/** Undo a staged or published import, restoring an empty target. */
export function rollbackFilesystemAssets(staged: StagedAssets | null): void {
  if (!staged) return;
  if (existsSync(staged.journal.stageRoot)) {
    rmSync(staged.journal.stageRoot, { recursive: true });
  } else if (existsSync(staged.journal.assetRoot)) {
    removePublishedTree(staged.journal);
  }
  if (staged.journal.rootExisted && !existsSync(staged.journal.assetRoot)) {
    mkdirSync(staged.journal.assetRoot, { mode: 0o700 });
  }
  rmSync(staged.path, { force: true });
}

/** Recover a prior crash only when the same bundle and exact target state prove ownership. */
export function recoverFilesystemAssets({
  stateRoot,
  appId,
  bundleDigest,
  assetRoot,
  targetState,
}: {
  stateRoot: string;
  appId: string;
  bundleDigest: string;
  assetRoot: string | null;
  targetState: 'empty' | 'complete' | 'dirty';
}): 'none' | 'complete' | 'retry' {
  const path = journalPath(stateRoot, appId);
  if (!existsSync(path)) return 'none';
  const details = lstatSync(path);
  if (
    details.isSymbolicLink() ||
    !details.isFile() ||
    (details.mode & 0o077) !== 0
  ) {
    throw fail('unsafe-asset-recovery-journal');
  }
  let journal: AssetImportJournal;
  try {
    journal = JSON.parse(readFileSync(path, 'utf8')) as AssetImportJournal;
  } catch {
    throw fail('invalid-asset-recovery-journal');
  }
  if (
    journal?.schemaVersion !== 1 ||
    journal.application !== appId ||
    journal.bundleDigest !== bundleDigest ||
    resolve(journal.assetRoot || '') !== resolve(assetRoot || '') ||
    !Array.isArray(journal.entries) ||
    !['staging', 'publishing', 'published'].includes(journal.phase) ||
    dirname(resolve(journal.stageRoot || '')) !==
      dirname(resolve(assetRoot || '')) ||
    !String(journal.stageRoot || '').includes('.smrt-asset-stage-')
  ) {
    throw fail('asset-recovery-mismatch');
  }
  if (targetState === 'complete') {
    if (existsSync(journal.stageRoot)) {
      throw fail('asset-recovery-target-mismatch');
    }
    verifyPublishedTree(journal);
    rmSync(path, { force: true });
    return 'complete';
  }
  if (targetState !== 'empty') throw fail('asset-recovery-target-mismatch');
  if (existsSync(journal.stageRoot)) {
    rmSync(journal.stageRoot, { recursive: true });
  } else if (existsSync(journal.assetRoot)) {
    removePublishedTree(journal);
  }
  if (journal.rootExisted && !existsSync(journal.assetRoot)) {
    mkdirSync(journal.assetRoot, { mode: 0o700 });
  }
  rmSync(path, { force: true });
  return 'retry';
}

/**
 * Read an import bundle only when it is a private (mode 0600), regular,
 * non-symlinked file that does not change while it is read.
 */
export function readSensitiveBundle(
  path: string,
  options: { onOpened?: () => void } = {},
): string {
  let details: ReturnType<typeof lstatSync>;
  let initialRealPath: string;
  try {
    details = lstatSync(path);
    initialRealPath = realpathSync(path);
  } catch {
    throw fail('unsafe-bundle-file');
  }
  if (
    details.isSymbolicLink() ||
    !details.isFile() ||
    initialRealPath !== resolve(path) ||
    details.size > MAX_BUNDLE_BYTES ||
    (process.platform !== 'win32' && (details.mode & 0o777) !== 0o600)
  ) {
    throw fail('unsafe-bundle-file');
  }
  const noFollow = constants.O_NOFOLLOW ?? 0;
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | noFollow);
  } catch {
    throw fail('bundle-changed-during-read');
  }
  try {
    const opened = fstatSync(descriptor);
    if (
      opened.dev !== details.dev ||
      opened.ino !== details.ino ||
      opened.size !== details.size ||
      !opened.isFile()
    ) {
      throw fail('bundle-changed-during-read');
    }
    options.onOpened?.();
    const bytes = readBoundedDescriptor(
      descriptor,
      opened.size,
      'bundle-changed-during-read',
    );
    const after = fstatSync(descriptor);
    let afterPath: ReturnType<typeof statSync>;
    let finalRealPath: string;
    try {
      afterPath = statSync(path);
      finalRealPath = realpathSync(path);
    } catch {
      throw fail('bundle-changed-during-read');
    }
    if (
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      afterPath.dev !== opened.dev ||
      afterPath.ino !== opened.ino ||
      finalRealPath !== resolve(path)
    ) {
      throw fail('bundle-changed-during-read');
    }
    return bytes.toString('utf8');
  } finally {
    closeSync(descriptor);
  }
}

/** Digest identifying one serialized bundle for crash recovery. */
export function bundleContentDigest(serialized: string): string {
  return digestBytes(Buffer.from(serialized));
}
