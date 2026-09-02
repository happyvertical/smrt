import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ASSET_MANIFEST_SCHEMA_VERSION = 1;
export const MAX_ASSET_COUNT = 1_000;
export const MAX_ASSET_BYTES = 64 * 1024 * 1024;
export const MAX_TOTAL_ASSET_BYTES = 256 * 1024 * 1024;
export const MAX_BUNDLE_BYTES = 512 * 1024 * 1024;

const ASSET_URI_PREFIX = 'smrt-bundle://asset/';
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const MAX_BASE64_ASSET_LENGTH = Math.ceil(MAX_ASSET_BYTES / 3) * 4;

function fail(code) {
  const error = new Error(`Asset portability validation failed (${code}).`);
  error.code = code;
  return error;
}

function isSanitizedFailure(error) {
  return (
    error &&
    typeof error === 'object' &&
    typeof error.code === 'string' &&
    /^[a-z][a-z0-9-]*$/.test(error.code)
  );
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function digestBytes(value) {
  return `sha256:${sha256(value)}`;
}

function isInside(parent, child) {
  const nested = relative(parent, child);
  return nested !== '' && nested !== '..' && !nested.startsWith(`..${sep}`);
}

function assertOutsideSource(sourceRoot, candidate, code) {
  const source = realpathSync(sourceRoot);
  const resolved = resolve(candidate);
  if (resolved === source || isInside(source, resolved) || isInside(resolved, source)) {
    throw fail(code);
  }
  return resolved;
}

function assertRealDirectory(path, code) {
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

export function assertAssetRoot({ sourceRoot, assetRoot, allowMissing = false }) {
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

function normalizePayloadPath(value) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 512 ||
    value.includes('\\') ||
    value.includes('\0') ||
    value.startsWith('/') ||
    value.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw fail('unsafe-payload-path');
  }
  return value;
}

function normalizeDestinationPath(value) {
  const normalized = normalizePayloadPath(value);
  if (!/^portable\/[a-f0-9]{64}$/.test(normalized)) {
    throw fail('unsafe-destination-path');
  }
  return normalized;
}

function portableUri(key) {
  return `${ASSET_URI_PREFIX}${encodeURIComponent(key)}`;
}

function payloadPathForKey(key) {
  return `payloads/${sha256(key)}`;
}

function destinationPathForKey(key) {
  return `portable/${sha256(key)}`;
}

function readBoundedDescriptor(descriptor, expectedSize, changedCode) {
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

function readRegularFileUnchecked(path, approvedRoot, onOpened) {
  const lexicalPath = resolve(path);
  if (!isInside(approvedRoot, lexicalPath)) throw fail('asset-outside-root');
  const before = lstatSync(lexicalPath);
  if (before.isSymbolicLink() || !before.isFile()) throw fail('asset-not-regular');
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

function readRegularFile(path, approvedRoot, onOpened) {
  try {
    return readRegularFileUnchecked(path, approvedRoot, onOpened);
  } catch (error) {
    if (isSanitizedFailure(error)) throw error;
    throw fail('asset-changed-during-read');
  }
}

function pathFromSourceUri(sourceUri) {
  if (typeof sourceUri !== 'string' || !sourceUri.startsWith('file://')) {
    throw fail('unsupported-asset-source');
  }
  try {
    return fileURLToPath(sourceUri);
  } catch {
    throw fail('unsupported-asset-source');
  }
}

function assetRows(tables) {
  const table = tables.find((candidate) => candidate?.name === 'assets');
  if (!table) return [];
  if (!Array.isArray(table.rows) || !table.columns?.includes('id') || !table.columns?.includes('source_uri')) {
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
}) {
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
  const keys = new Set();
  const payloadPaths = new Set();
  const entries = [];
  const payloads = [];
  let totalBytes = 0;
  for (const row of rows) {
    if (!row?.source_uri) continue;
    const key = String(row.id || '');
    if (!key || key.length > 512 || keys.has(key)) throw fail('duplicate-asset-key');
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

function decodePayload(payload, expectedByteLength) {
  if (
    payload?.encoding !== 'base64' ||
    typeof payload.data !== 'string' ||
    payload.data.length > MAX_BASE64_ASSET_LENGTH ||
    !BASE64_PATTERN.test(payload.data)
  ) {
    throw fail('invalid-asset-payload');
  }
  const padding = payload.data.endsWith('==')
    ? 2
    : payload.data.endsWith('=')
      ? 1
      : 0;
  const decodedLength = (payload.data.length / 4) * 3 - padding;
  if (decodedLength !== expectedByteLength) throw fail('asset-size-mismatch');
  const bytes = Buffer.from(payload.data, 'base64');
  if (bytes.toString('base64') !== payload.data) {
    throw fail('invalid-asset-payload');
  }
  return bytes;
}

/** Validate every manifest/payload relationship and hydrate destination URIs. */
export function verifyFilesystemAssets({ assetBundle, tables, sourceRoot, assetRoot }) {
  if (
    assetBundle?.schemaVersion !== ASSET_MANIFEST_SCHEMA_VERSION ||
    assetBundle?.adapter !== 'filesystem' ||
    !Array.isArray(assetBundle.entries) ||
    !Array.isArray(assetBundle.payloads)
  ) {
    throw fail('unsupported-asset-manifest');
  }
  if (assetBundle.entries.length > MAX_ASSET_COUNT) throw fail('too-many-assets');
  if (assetBundle.entries.length !== assetBundle.payloads.length) {
    throw fail('asset-payload-count-mismatch');
  }
  const rows = assetRows(tables);
  const rowByKey = new Map();
  for (const row of rows) {
    if (!row?.source_uri) continue;
    const key = String(row.id || '');
    if (!key || rowByKey.has(key) || row.source_uri !== portableUri(key)) {
      throw fail('invalid-asset-reference');
    }
    rowByKey.set(key, row);
  }
  const payloadByPath = new Map();
  for (const payload of assetBundle.payloads) {
    const path = normalizePayloadPath(payload?.path);
    if (payloadByPath.has(path)) throw fail('duplicate-payload-path');
    payloadByPath.set(path, payload);
  }
  const keys = new Set();
  const paths = new Set();
  const verified = [];
  let totalBytes = 0;
  for (const entry of assetBundle.entries) {
    const key = typeof entry?.key === 'string' ? entry.key : '';
    const payloadPath = normalizePayloadPath(entry?.payloadPath);
    if (!key || key.length > 512 || keys.has(key)) throw fail('duplicate-asset-key');
    if (paths.has(payloadPath)) throw fail('duplicate-payload-path');
    keys.add(key);
    paths.add(payloadPath);
    if (
      !Number.isSafeInteger(entry.byteLength) ||
      entry.byteLength < 0 ||
      entry.byteLength > MAX_ASSET_BYTES
    ) {
      throw fail('invalid-asset-size');
    }
    if (!DIGEST_PATTERN.test(entry.contentDigest || '')) {
      throw fail('invalid-asset-digest');
    }
    totalBytes += entry.byteLength;
    if (totalBytes > MAX_TOTAL_ASSET_BYTES) throw fail('asset-total-too-large');
    const payload = payloadByPath.get(payloadPath);
    if (!payload) throw fail('missing-asset-payload');
    const bytes = decodePayload(payload, entry.byteLength);
    if (bytes.byteLength !== entry.byteLength) throw fail('asset-size-mismatch');
    if (digestBytes(bytes) !== entry.contentDigest) throw fail('asset-digest-mismatch');
    if (!rowByKey.has(key)) throw fail('unreferenced-asset-payload');
    verified.push({
      key,
      bytes,
      contentDigest: entry.contentDigest,
      relativePath: destinationPathForKey(key),
    });
  }
  if (keys.size !== rowByKey.size) throw fail('missing-asset-entry');
  if (payloadByPath.size !== paths.size) throw fail('unreferenced-asset-payload');
  if (verified.length === 0) return { root: null, entries: [] };
  const root = assertAssetRoot({ sourceRoot, assetRoot, allowMissing: true });
  for (const entry of verified) {
    rowByKey.get(entry.key).source_uri = pathToFileURL(join(root, entry.relativePath)).href;
  }
  return { root, entries: verified };
}

function journalPath(stateRoot, appId) {
  return join(stateRoot, `.smrt-asset-import-${sha256(appId).slice(0, 16)}.json`);
}

function writeJournal(path, journal) {
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

function assertEmptyAssetRoot(root) {
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
}) {
  if (verified.entries.length === 0) return null;
  assertEmptyAssetRoot(verified.root);
  const stageRoot = join(
    dirname(verified.root),
    `.smrt-asset-stage-${process.pid}-${randomBytes(8).toString('hex')}`,
  );
  const path = journalPath(stateRoot, appId);
  if (existsSync(path)) throw fail('asset-recovery-required');
  const journal = {
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
export function publishFilesystemAssets(staged, options = {}) {
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
  journal,
  entry,
  approvedRoot,
  { allowMissing = false, verifyDigest = true } = {},
) {
  const destination = join(
    journal.assetRoot,
    normalizeDestinationPath(entry.relativePath),
  );
  if (!existsSync(destination)) {
    if (allowMissing) return false;
    throw fail('missing-published-asset');
  }
  const bytes = readRegularFile(destination, approvedRoot);
  if (
    verifyDigest &&
    digestBytes(bytes) !== entry.contentDigest
  ) {
    throw fail('published-asset-digest-mismatch');
  }
  return true;
}

function verifyPublishedTree(journal, { verifyDigest = true } = {}) {
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

export function verifyPublishedFilesystemAssets(staged) {
  if (staged) verifyPublishedTree(staged.journal);
}

function removePublishedTree(journal) {
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

export function finishFilesystemAssets(staged) {
  if (!staged) return;
  verifyPublishedTree(staged.journal);
  rmSync(staged.path, { force: true });
}

export function rollbackFilesystemAssets(staged) {
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
}) {
  const path = journalPath(stateRoot, appId);
  if (!existsSync(path)) return 'none';
  const details = lstatSync(path);
  if (details.isSymbolicLink() || !details.isFile() || (details.mode & 0o077) !== 0) {
    throw fail('unsafe-asset-recovery-journal');
  }
  let journal;
  try {
    journal = JSON.parse(readFileSync(path, 'utf8'));
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
    dirname(resolve(journal.stageRoot || '')) !== dirname(resolve(assetRoot || '')) ||
    !String(journal.stageRoot || '').includes('.smrt-asset-stage-')
  ) {
    throw fail('asset-recovery-mismatch');
  }
  if (targetState === 'complete') {
    if (existsSync(journal.stageRoot)) throw fail('asset-recovery-target-mismatch');
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

export function readSensitiveBundle(path, options = {}) {
  let details;
  let initialRealPath;
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
  let descriptor;
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
    let afterPath;
    let finalRealPath;
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

export function bundleContentDigest(serialized) {
  return digestBytes(Buffer.from(serialized));
}
