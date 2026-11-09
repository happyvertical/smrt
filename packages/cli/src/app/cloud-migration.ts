/**
 * Local-to-cloud migration and cloud-to-local downgrade (#4806).
 *
 * Built on a cloud link (`smrt-cloud-link-v1`, `@happyvertical/smrt-app-runtime`)
 * and on the schemaVersion-2 logical bundle of `smrt app export`:
 *
 * - **Per-user target** (an empty cloud database owned by one account): the
 *   checked bundle is imported by the existing `importApplication` contract,
 *   byte-preserving and into an empty target only. Rows keep their IDs,
 *   timestamps and recorded sync origin/revision; nothing new is revised, so
 *   no writer identity is needed and none is fabricated.
 * - **Shared target** (the multi-tenant cloud): rows go through the hosted
 *   application's `sync/apply` with their row UUIDs, so the hosted tracked
 *   collection stack applies tenancy, the writable policy and its own sync
 *   writer identity (which fails closed when missing, #4701). The planner
 *   refuses, before anything is written, every row that could cross a tenant
 *   boundary, and rewrites local well-known identities to the linked hosted
 *   ones.
 * - **Downgrade**: a tenant-scoped hosted export is reverse-mapped to the
 *   original local identities and checked for hostile locators, producing the
 *   bundle `smrt app import` accepts.
 *
 * Every refusal is a {@link CloudMigrationError} with a machine-readable code
 * and the offending table/row/column; messages never carry row values.
 */

import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  type CloudLinkIdentities,
  type CloudLinkRecord,
  canonicalCloudUuid,
  cloudLinkIdentityMap,
  type InstallationCustodyOptions,
  inspectInstallationCustody,
  type LocalCloudLinkIdentity,
  openLocalCloudLinkIdentity,
  parseCloudLinkRecord,
  prepareApplicationStateRoot,
  retireInstallation,
  SYSTEM_ROLE_IDS,
  SYSTEM_ROLE_SLUGS,
  stateRootOptions,
  writePrivateFileAtomicSync,
} from '@happyvertical/smrt-app-runtime';
import { isLocalAssetLocator } from '@happyvertical/smrt-assets/locator';
import type {
  SyncApplyBatchRequest,
  SyncApplyBatchResponse,
  SyncApplyItem,
} from '@happyvertical/smrt-core';
import { errorCode } from './errors.js';
import {
  canonicalValue,
  containsNonPortableRows,
  type ImportExecutor,
  type LogicalExportBundle,
  type ManifestTable,
  planImportTables,
  quoteIdentifier,
  serializeExportBundle,
  validateImportBundle,
} from './portability.js';
import {
  ASSET_MANIFEST_SCHEMA_VERSION,
  type AssetBundle,
  digestBytes,
  type PortableRow,
  type PortableTable,
} from './portability-assets.js';

/** Bundle columns a hosted export is filtered by. */
const TENANT_COLUMN = 'tenant_id';
const ASSET_TABLE = 'assets';
const ASSET_SOURCE_COLUMN = 'source_uri';
/** Columns the shared target's writable policy owns. */
const SERVER_MANAGED_COLUMNS = new Set([
  'id',
  TENANT_COLUMN,
  'created_at',
  'updated_at',
]);
/**
 * Credential material beyond the base export rule. Cloud bundles (both
 * directions) carry no rows of a table with such a column.
 */
const CLOUD_NON_PORTABLE_COLUMN_PATTERN =
  /(?:^|_)(?:totp|otp|mfa|recovery_codes?|backup_codes?|passkey|webauthn|refresh_(?:tokens?|secrets?|keys?|hash(?:es)?)|(?:password|passcode|pin|otp|secret|key|auth|login|hash)_salt|salt_(?:hash|value)|verifier|(?:code|reset|backup_code|otp|pin|key|verifier)_hash)(?:_|$)/;
// A bare `hash` or `refresh` is deliberately not matched on its own: content,
// spec and manifest digests (`content_hash`) and a `refresh_interval` /
// `auto_refresh` setting are ordinary data and must migrate. A `salt` column
// migrates alone but withholds its table beside a hash-like column
// (`isCloudNonPortable`). Whatever is withheld is listed in
// `plan.skipped.omittedTables` and must be acknowledged at completion.
const MAX_REPORTED_ISSUES = 50;
const DEFAULT_BATCH_SIZE = 500;
const MAX_JSON_DEPTH = 32;

/** Machine-readable refusal codes. */
export type CloudMigrationErrorCode =
  | 'invalid_bundle'
  | 'plan_refused'
  | 'item_refused'
  | 'asset_refused'
  | 'journal_mismatch'
  | 'verification_failed'
  | 'custody_refused';

/** One refused row or value; never carries the value itself. */
export interface CloudMigrationIssue {
  code:
    | 'foreign_tenant_row'
    | 'global_row'
    | 'tenantless_row'
    | 'modified_system_row'
    | 'identity_collision'
    | 'embedded_identity'
    | 'local_locator'
    | 'unresolved_reference'
    | 'invalid_row_id'
    | 'no_sync_target'
    | 'unsafe_json';
  table: string;
  rowId: string | null;
  column?: string;
}

/** A refused migration step. */
export class CloudMigrationError extends Error {
  override readonly name = 'CloudMigrationError';
  constructor(
    readonly code: CloudMigrationErrorCode,
    message: string,
    readonly issues: readonly CloudMigrationIssue[] = [],
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

class IssueCollector {
  readonly issues: CloudMigrationIssue[] = [];
  total = 0;
  add(issue: CloudMigrationIssue): void {
    this.total += 1;
    if (this.issues.length < MAX_REPORTED_ISSUES) this.issues.push(issue);
  }
  throwIfAny(message: string): void {
    if (this.total === 0) return;
    throw new CloudMigrationError(
      'plan_refused',
      `${message} (${this.total} issue(s); first: ${this.issues[0].code} in ${this.issues[0].table}).`,
      this.issues,
      { issueCount: this.total },
    );
  }
}

/** A salt next to a hash is password-style credential storage. */
const SALT_COLUMN_PATTERN = /(?:^|_)salt(?:_|$)/;
const HASH_LIKE_COLUMN_PATTERN = /(?:^|_)(?:hash|digest)(?:_|$)/;

function isCloudNonPortable(
  table: Pick<ManifestTable, 'name' | 'columns'>,
): boolean {
  return (
    containsNonPortableRows(table) ||
    table.columns.some((column) =>
      CLOUD_NON_PORTABLE_COLUMN_PATTERN.test(column),
    ) ||
    // A `salt` alone is ordinary data and migrates; with any hash-like
    // column in the same table (`hash`, `*_hash`, `digest`) the table is
    // withheld and must be acknowledged at completion.
    (table.columns.some((column) => SALT_COLUMN_PATTERN.test(column)) &&
      table.columns.some((column) => HASH_LIKE_COLUMN_PATTERN.test(column)))
  );
}

function rowIdOf(row: PortableRow): string | null {
  const id = row.id;
  if (typeof id === 'string') return canonicalCloudUuid(id) ?? id;
  if (typeof id === 'number' || typeof id === 'bigint') return String(id);
  return null;
}

function isJsonColumn(table: ManifestTable, column: string): boolean {
  const type = table.columnDefinitions[column]?.type?.toUpperCase();
  return type === 'JSON' || type === 'JSONB';
}

const LOCAL_LOCATOR_PATTERN = /\bfile:|asset-local:/i;

/** A `file:` URL or local asset locator anywhere in the string. */
function looksLikeLocalLocator(value: string): boolean {
  return (
    LOCAL_LOCATOR_PATTERN.test(value) || isLocalAssetLocator(value.trimStart())
  );
}

interface ValueRules {
  /** Exact-match rewrites, lowercase UUID keys. */
  map: ReadonlyMap<string, string>;
  /** IDs that may never appear in the input (the other side of the map). */
  forbidden: ReadonlySet<string>;
  /** IDs that may never appear embedded in a longer string. */
  embedded: readonly string[];
  /** Row IDs present in the bundle but not carried; references refuse. */
  dropped: ReadonlySet<string>;
}

/**
 * Rewrite one string leaf, or report why it cannot cross. Returns the
 * (possibly) rewritten value.
 */
function rewriteString(
  value: string,
  rules: ValueRules,
  report: (code: CloudMigrationIssue['code']) => void,
  locatorAllowed: boolean,
): string {
  const lowered = value.toLowerCase();
  if (rules.forbidden.has(lowered)) {
    report('identity_collision');
    return value;
  }
  const mapped = rules.map.get(lowered);
  if (mapped !== undefined) return mapped;
  if (rules.dropped.has(lowered)) {
    report('unresolved_reference');
    return value;
  }
  if (!locatorAllowed && looksLikeLocalLocator(value)) {
    report('local_locator');
    return value;
  }
  if (lowered.length > 36) {
    for (const id of rules.embedded) {
      if (lowered.includes(id)) {
        report('embedded_identity');
        break;
      }
    }
  }
  return value;
}

function rewriteJson(
  value: unknown,
  rules: ValueRules,
  report: (code: CloudMigrationIssue['code']) => void,
  depth = 0,
): unknown {
  if (depth > MAX_JSON_DEPTH) {
    report('unsafe_json');
    return value;
  }
  if (typeof value === 'string') {
    return rewriteString(value, rules, report, false);
  }
  if (Array.isArray(value)) {
    return value.map((item) => rewriteJson(item, rules, report, depth + 1));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const rewrittenKey = rewriteString(key, rules, report, false);
      out[rewrittenKey] = rewriteJson(item, rules, report, depth + 1);
    }
    return out;
  }
  return value;
}

/** Rewrite every value of one row; JSON text stays byte-identical if unchanged. */
function rewriteRow(
  table: ManifestTable,
  row: PortableRow,
  rules: ValueRules,
  issues: IssueCollector,
): PortableRow {
  const rowId = rowIdOf(row);
  const out: PortableRow = {};
  for (const [column, value] of Object.entries(row)) {
    const report = (code: CloudMigrationIssue['code']) =>
      issues.add({ code, table: table.name, rowId, column });
    const locatorAllowed =
      table.name === ASSET_TABLE && column === ASSET_SOURCE_COLUMN;
    if (typeof value === 'string' && isJsonColumn(table, column)) {
      let parsed: unknown;
      let isJson = true;
      try {
        parsed = JSON.parse(value);
      } catch {
        isJson = false;
      }
      if (!isJson) {
        out[column] = rewriteString(value, rules, report, locatorAllowed);
        continue;
      }
      const rewritten = rewriteJson(parsed, rules, report);
      out[column] =
        JSON.stringify(rewritten) === JSON.stringify(parsed)
          ? value
          : JSON.stringify(rewritten);
    } else if (typeof value === 'string') {
      out[column] = rewriteString(value, rules, report, locatorAllowed);
    } else if (value instanceof Uint8Array) {
      // Binary values pass through unchanged; they are not scanned.
      out[column] = value;
    } else if (value && typeof value === 'object' && !(value instanceof Date)) {
      out[column] = rewriteJson(value, rules, report);
    } else {
      out[column] = value;
    }
  }
  return out;
}

function checkSystemRow(
  table: ManifestTable,
  row: PortableRow,
  rowId: string,
  issues: IssueCollector,
): void {
  const tenant = row[TENANT_COLUMN];
  if (
    ('slug' in row && row.slug !== SYSTEM_ROLE_SLUGS.get(rowId)) ||
    (TENANT_COLUMN in row && tenant !== null && tenant !== undefined)
  ) {
    issues.add({ code: 'modified_system_row', table: table.name, rowId });
  }
}

function requireBundle(
  value: unknown,
  appId: string,
  tables: ManifestTable[],
): LogicalExportBundle {
  const bundle = value as Partial<LogicalExportBundle> | null;
  if (bundle?.schemaVersion !== 2 || !Array.isArray(bundle.tables)) {
    throw new CloudMigrationError(
      'invalid_bundle',
      'Unsupported logical export bundle.',
    );
  }
  if (bundle.application !== appId) {
    throw new CloudMigrationError(
      'invalid_bundle',
      'The bundle belongs to a different application than the link.',
    );
  }
  validateImportBundle(
    { tables: bundle.tables },
    new Map(tables.map((table) => [table.name, table])),
  );
  return bundle as LogicalExportBundle;
}

function filterAssets(
  assets: AssetBundle,
  keptKeys: ReadonlySet<string>,
): AssetBundle {
  const entries = (assets?.entries ?? []).filter((entry) =>
    keptKeys.has(entry.key),
  );
  const paths = new Set(entries.map((entry) => entry.payloadPath));
  return {
    schemaVersion: ASSET_MANIFEST_SCHEMA_VERSION,
    adapter: 'filesystem',
    entries,
    payloads: (assets?.payloads ?? []).filter((payload) =>
      paths.has(payload.path),
    ),
  };
}

function assetKeysOf(tables: PortableTable[]): Set<string> {
  const assetTable = tables.find((table) => table.name === ASSET_TABLE);
  return new Set(
    (assetTable?.rows ?? [])
      .filter((row) => row[ASSET_SOURCE_COLUMN])
      .map((row) => String(row.id ?? '')),
  );
}

function perUserIdentities(
  options: CloudMigrationPlanOptions,
): CloudLinkIdentities {
  const raw = options.perUser?.localIdentities;
  const ids = {
    tenantId: canonicalCloudUuid(raw?.tenantId),
    ownerId: canonicalCloudUuid(raw?.ownerId),
    profileId: canonicalCloudUuid(raw?.profileId),
    membershipId: canonicalCloudUuid(raw?.membershipId),
  };
  if (
    typeof options.perUser?.appId !== 'string' ||
    Object.values(ids).some((id) => id === null)
  ) {
    throw new CloudMigrationError(
      'invalid_bundle',
      'A per-user plan needs the application ID and four local identity UUIDs.',
    );
  }
  return Object.freeze(ids as unknown as CloudLinkIdentities);
}

function normalizeGlobalMap(
  value: Readonly<Record<string, string>> | undefined,
  shared: boolean,
  identityMap: ReadonlyMap<string, string>,
): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  const taken = new Set([...identityMap.keys(), ...identityMap.values()]);
  for (const [local, hosted] of Object.entries(value ?? {})) {
    const from = canonicalCloudUuid(local);
    const to = canonicalCloudUuid(hosted);
    if (
      !shared ||
      !from ||
      !to ||
      from === to ||
      taken.has(from) ||
      taken.has(to)
    ) {
      throw new CloudMigrationError(
        'invalid_bundle',
        'globalIdentityMap entries must be distinct shared-target UUID pairs that touch no linked identity.',
      );
    }
    taken.add(from);
    taken.add(to);
    out[from] = to;
  }
  return Object.freeze(out);
}

/** Options for {@link planCloudMigration}. */
export interface CloudMigrationPlanOptions {
  /** The local logical bundle (`smrt app export`, decrypted if sealed). */
  bundle: unknown;
  /** Application tables from the build manifest (`manifestTables`). */
  tables: ManifestTable[];
  /** Shared target: the verified link receipt. */
  link?: CloudLinkRecord;
  /**
   * Per-user target: the installation's application and local identities.
   * A per-user database is linked after the import (its hosted account is
   * the imported local owner), so no link exists yet.
   */
  perUser?: { appId: string; localIdentities: CloudLinkIdentities };
  /**
   * Shared target only: extra local→hosted mappings for global rows that
   * exist on both sides under different IDs (resolved by the operator from
   * the hosted application, e.g. a profile type by slug). System role IDs
   * never need one.
   */
  globalIdentityMap?: Readonly<Record<string, string>>;
}

/** A checked, remapped migration. */
export interface CloudMigrationPlan {
  readonly target: CloudLinkRecord['target'];
  readonly appId: string;
  /** The shared-target link; `null` for a per-user plan. */
  readonly link: CloudLinkRecord | null;
  readonly localIdentities: CloudLinkIdentities;
  /** Operator-resolved global mappings (shared target), local → hosted. */
  readonly globalIdentityMap: Readonly<Record<string, string>>;
  /** SHA-256 of the canonical serialization of {@link bundle}. */
  readonly bundleDigest: string;
  /** What the target receives: every manifest table, remapped rows only. */
  readonly bundle: LogicalExportBundle;
  readonly skipped: {
    readonly identityRows: number;
    readonly systemRows: number;
    /** Tables whose rows were withheld as credential material. */
    readonly omittedTables: readonly string[];
  };
  readonly tables: readonly ManifestTable[];
}

/**
 * Check and remap a local bundle for its link's target. Refuses (code
 * `plan_refused`, with issues) before anything is written when:
 *
 * - shared target: a row belongs to another tenant (`foreign_tenant_row`), is
 *   global (`global_row`), or lives in a table without a tenant column
 *   (`tenantless_row`), unless it is a linked identity or a system role;
 * - a system role row differs from its canonical slug or is tenant-bound
 *   (`modified_system_row`);
 * - a value already equals a hosted identity (`identity_collision`), embeds
 *   a local identity in a longer string (`embedded_identity`), is a local
 *   file or asset locator outside `assets.source_uri` (`local_locator`), or
 *   references a row that is not carried (`unresolved_reference`).
 */
export function planCloudMigration(
  options: CloudMigrationPlanOptions,
): CloudMigrationPlan {
  if (Boolean(options.link) === Boolean(options.perUser)) {
    throw new CloudMigrationError(
      'invalid_bundle',
      'Plan with either a shared-target link or per-user identities.',
    );
  }
  const link = options.link ? parseCloudLinkRecord(options.link) : null;
  if (link && link.target !== 'shared') {
    throw new CloudMigrationError(
      'invalid_bundle',
      'A per-user plan takes the local identities, not a link.',
    );
  }
  const appId = link?.appId ?? (options.perUser?.appId as string);
  const localIdentities = link?.localIdentities ?? perUserIdentities(options);
  const bundle = requireBundle(options.bundle, appId, options.tables);
  const shared = link !== null;
  const identityMap = new Map(
    link
      ? cloudLinkIdentityMap(link)
      : [...SYSTEM_ROLE_IDS, ...Object.values(localIdentities)].map(
          (id) => [id, id] as const,
        ),
  );
  const globalIdentityMap = normalizeGlobalMap(
    options.globalIdentityMap,
    shared,
    identityMap,
  );
  for (const [from, to] of Object.entries(globalIdentityMap)) {
    identityMap.set(from, to);
  }
  const localIdentityIds = new Set(Object.values(localIdentities));
  const hostedIds = new Set<string>();
  if (shared) {
    for (const [from, to] of identityMap) if (from !== to) hostedIds.add(to);
  }
  const issues = new IssueCollector();
  const tableByName = new Map(
    options.tables.map((table) => [table.name, table]),
  );
  const exportedByName = new Map(
    bundle.tables.map((table) => [table.name, table]),
  );

  // Pass 1: decide which rows are carried; collect IDs of rows that are not.
  const carried = new Map<string, PortableRow[]>();
  const dropped = new Set<string>();
  const omittedTables: string[] = [];
  let identityRows = 0;
  let systemRows = 0;
  for (const table of options.tables) {
    const rows = (exportedByName.get(table.name) as PortableTable).rows;
    const kept: PortableRow[] = [];
    if (isCloudNonPortable(table)) {
      if (rows.length > 0) omittedTables.push(table.name);
      for (const row of rows) {
        const id = rowIdOf(row);
        if (id) dropped.add(id);
      }
      carried.set(table.name, kept);
      continue;
    }
    const hasTenant = table.columns.includes(TENANT_COLUMN);
    for (const row of rows) {
      const id = rowIdOf(row);
      if (id && SYSTEM_ROLE_IDS.has(id)) {
        checkSystemRow(table, row, id, issues);
        if (shared) {
          systemRows += 1;
          continue;
        }
      } else if (shared && id && localIdentityIds.has(id)) {
        // Represented on the hosted side by the linked identity.
        identityRows += 1;
        continue;
      } else if (shared) {
        if (!id || !canonicalCloudUuid(id)) {
          issues.add({ code: 'invalid_row_id', table: table.name, rowId: id });
          continue;
        }
        if (!hasTenant) {
          if (id in globalIdentityMap) continue;
          issues.add({ code: 'tenantless_row', table: table.name, rowId: id });
          continue;
        }
        const tenant = canonicalCloudUuid(row[TENANT_COLUMN]);
        if (row[TENANT_COLUMN] != null && id in globalIdentityMap) {
          // A carried row's own ID may never be rewritten onto a hosted row.
          issues.add({
            code: 'identity_collision',
            table: table.name,
            rowId: id,
          });
          continue;
        }
        if (row[TENANT_COLUMN] == null) {
          if (identityMap.has(id)) {
            // A global row the operator mapped to its hosted counterpart.
            continue;
          }
          issues.add({ code: 'global_row', table: table.name, rowId: id });
          continue;
        }
        if (tenant !== link.localIdentities.tenantId) {
          issues.add({
            code: 'foreign_tenant_row',
            table: table.name,
            rowId: id,
          });
          continue;
        }
      }
      kept.push(row);
    }
    carried.set(table.name, kept);
  }

  // Pass 2: rewrite values of carried rows.
  const rules: ValueRules = {
    map: identityMap,
    forbidden: hostedIds,
    embedded: shared ? [...localIdentityIds] : [],
    dropped,
  };
  const tables: PortableTable[] = [];
  for (const table of options.tables) {
    const manifest = tableByName.get(table.name) as ManifestTable;
    tables.push({
      name: table.name,
      columns: (exportedByName.get(table.name) as PortableTable).columns,
      rows: (carried.get(table.name) ?? []).map((row) =>
        rewriteRow(manifest, row, rules, issues),
      ),
    });
  }
  issues.throwIfAny('The bundle cannot be migrated to this cloud target');

  const migrated: LogicalExportBundle = {
    schemaVersion: 2,
    application: bundle.application,
    profile: bundle.profile,
    exportedAt: bundle.exportedAt,
    tables,
    assets: filterAssets(bundle.assets, assetKeysOf(tables)),
  };
  return Object.freeze({
    target: shared ? ('shared' as const) : ('per-user' as const),
    appId,
    link,
    localIdentities,
    globalIdentityMap,
    bundleDigest: digestBytes(serializeExportBundle(migrated)),
    bundle: migrated,
    skipped: Object.freeze({
      identityRows,
      systemRows,
      omittedTables: Object.freeze(omittedTables),
    }),
    tables: options.tables,
  });
}

/**
 * Write a plan's bundle (per-user target) to a new mode-0600 file without
 * replacing anything, for `importApplication` / `smrt app import`.
 */
export function writeCloudMigrationBundle(
  plan: CloudMigrationPlan,
  destination: string,
): string {
  const serialized = `${serializeExportBundle(plan.bundle)}\n`;
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = join(
    dirname(destination),
    `.${basename(destination)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`,
  );
  try {
    const fd = openSync(temporary, 'wx', 0o600);
    try {
      writeSync(fd, serialized);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      linkSync(temporary, destination);
    } catch (error) {
      if (errorCode(error) === 'EEXIST') {
        throw new Error(`Migration bundle already exists: ${destination}`);
      }
      throw error;
    }
  } finally {
    rmSync(temporary, { force: true });
  }
  return destination;
}

/** A verified asset ready for upload. */
export interface CloudAssetUpload {
  key: string;
  contentDigest: string;
  bytes: Buffer;
}

function verifiedAssetUploads(assets: AssetBundle): CloudAssetUpload[] {
  const byPath = new Map(
    (assets.payloads ?? []).map((payload) => [payload.path, payload]),
  );
  return (assets.entries ?? []).map((entry) => {
    const payload = byPath.get(entry.payloadPath);
    const bytes =
      payload?.encoding === 'base64'
        ? Buffer.from(payload.data, 'base64')
        : null;
    if (
      !bytes ||
      bytes.toString('base64') !== payload?.data ||
      bytes.byteLength !== entry.byteLength ||
      digestBytes(bytes) !== entry.contentDigest
    ) {
      throw new CloudMigrationError(
        'asset_refused',
        `Asset ${entry.key} does not match its digest.`,
      );
    }
    return { key: entry.key, contentDigest: entry.contentDigest, bytes };
  });
}

/** Hosted transport for the shared target, authenticated as the linked principal. */
export interface SharedCloudTransport {
  /** `POST {basePath}/sync/apply` on the linked origin. */
  apply(request: SyncApplyBatchRequest): Promise<SyncApplyBatchResponse>;
  /**
   * Store one asset under the session's tenant. Idempotent for the same
   * key and digest (`'exists'`); a different digest under an existing key
   * must fail.
   */
  putAsset(asset: CloudAssetUpload): Promise<'stored' | 'exists'>;
}

function camelField(column: string): string {
  return column.replace(/_([a-z0-9])/g, (_match, char: string) =>
    char.toUpperCase(),
  );
}

function payloadValue(
  table: ManifestTable,
  column: string,
  value: unknown,
): unknown {
  if (typeof value === 'string' && isJsonColumn(table, column)) {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  if (typeof value === 'bigint') return value.toString();
  return value;
}

/**
 * The ordered `sync/apply` items of a shared plan: parent-first creates, then
 * updates for deferred cyclic references. Deterministic for one plan.
 */
export function sharedMigrationItems(
  plan: CloudMigrationPlan,
  segments: Readonly<Record<string, string>>,
): SyncApplyItem[] {
  if (plan.target !== 'shared' || !plan.link) {
    throw new CloudMigrationError(
      'invalid_bundle',
      'Only a shared-target plan migrates through sync/apply.',
    );
  }
  const issues = new IssueCollector();
  const rowsByName = new Map(
    plan.bundle.tables.map((table) => [table.name, table.rows]),
  );
  const creates: SyncApplyItem[] = [];
  const updates: SyncApplyItem[] = [];
  for (const table of planImportTables([...plan.tables])) {
    const rows = rowsByName.get(table.name) ?? [];
    if (rows.length === 0) continue;
    const segment = segments[table.name];
    if (typeof segment !== 'string' || !segment) {
      issues.add({ code: 'no_sync_target', table: table.name, rowId: null });
      continue;
    }
    for (const row of rows) {
      const id = rowIdOf(row) as string;
      const payload: Record<string, unknown> = {};
      const deferred: Record<string, unknown> = {};
      for (const column of table.columns) {
        if (SERVER_MANAGED_COLUMNS.has(column)) continue;
        const value = payloadValue(table, column, row[column]);
        if (table.deferredColumns.has(column)) {
          payload[camelField(column)] = null;
          if (value != null) deferred[camelField(column)] = value;
        } else {
          payload[camelField(column)] = value;
        }
      }
      creates.push({
        itemId: `${table.name}:${id}:create`,
        object: segment,
        op: 'create',
        id,
        payload,
      });
      if (Object.keys(deferred).length > 0) {
        updates.push({
          itemId: `${table.name}:${id}:link`,
          object: segment,
          op: 'update',
          id,
          payload: deferred,
        });
      }
    }
  }
  issues.throwIfAny('The shared target has no sync/apply route for a table');
  return [...creates, ...updates];
}

/** Journal of a shared migration, in the state root. */
export interface SharedMigrationJournal {
  schemaVersion: 1;
  binding: {
    bundleDigest: string;
    origin: string;
    linkId: string;
    tenantId: string;
  };
  assetsStored: string[];
  /** SHA-256 of each acknowledged batch, in order. */
  acknowledgedBatches: string[];
  status: 'in-progress' | 'applied';
}

function writeJsonAtomic(path: string, value: unknown): void {
  writePrivateFileAtomicSync(path, `${JSON.stringify(value, null, 2)}\n`, {
    createParent: true,
  });
}

function readJournal(path: string): SharedMigrationJournal | null {
  if (!existsSync(path)) return null;
  try {
    const journal = JSON.parse(readFileSync(path, 'utf8'));
    if (
      journal?.schemaVersion !== 1 ||
      !Array.isArray(journal.acknowledgedBatches) ||
      !Array.isArray(journal.assetsStored)
    ) {
      throw new Error('invalid');
    }
    return journal as SharedMigrationJournal;
  } catch {
    throw new CloudMigrationError(
      'journal_mismatch',
      'The migration journal is unreadable; nothing was sent.',
    );
  }
}

/** Options for {@link runSharedCloudMigration}. */
export interface SharedMigrationOptions {
  plan: CloudMigrationPlan;
  /** Manifest table name → `sync/apply` collection segment. */
  segments: Readonly<Record<string, string>>;
  transport: SharedCloudTransport;
  /** Journal file, normally `<state root>/cloud-migration-journal.json`. */
  journalPath: string;
  batchSize?: number;
}

/** Outcome of {@link runSharedCloudMigration}. */
export interface SharedMigrationResult {
  itemCount: number;
  batchCount: number;
  resumedBatches: number;
  assetCount: number;
}

/** A server-supplied status token, or `null` when it is not a plain token. */
function safeToken(value: unknown): string | null {
  return typeof value === 'string' && /^[a-z_]{1,40}$/.test(value)
    ? value
    : null;
}

function batchDigest(items: SyncApplyItem[]): string {
  return createHash('sha256').update(JSON.stringify(items)).digest('hex');
}

/**
 * Send a shared plan through `sync/apply`. Resumable: acknowledged batches
 * are recorded in a journal bound to the bundle digest, origin, link and
 * tenant, and a resume under any other binding or with different batches
 * refuses. Re-sending is harmless anyway (an identical create is an applied
 * no-op). Any `conflict` or `rejected` result stops the run; nothing on the
 * hosted side is ever overwritten.
 */
export async function runSharedCloudMigration(
  options: SharedMigrationOptions,
): Promise<SharedMigrationResult> {
  const { plan, transport } = options;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1000) {
    throw new RangeError('batchSize must be between 1 and 1000.');
  }
  const items = sharedMigrationItems(plan, options.segments);
  const link = plan.link as CloudLinkRecord;
  const uploads = verifiedAssetUploads(plan.bundle.assets);
  const binding = {
    bundleDigest: plan.bundleDigest,
    origin: link.origin,
    linkId: link.linkId,
    tenantId: link.tenantId,
  };
  // Creates and deferred-reference updates never share a batch: a re-sent
  // create batch must not meet a row an update in the same batch changed.
  const batches: SyncApplyItem[][] = [];
  for (const phase of ['create', 'update'] as const) {
    const phaseItems = items.filter((item) => item.op === phase);
    for (let index = 0; index < phaseItems.length; index += batchSize) {
      batches.push(phaseItems.slice(index, index + batchSize));
    }
  }
  const digests = batches.map(batchDigest);
  const existing = readJournal(options.journalPath);
  if (
    existing &&
    (JSON.stringify(existing.binding) !== JSON.stringify(binding) ||
      existing.acknowledgedBatches.length > digests.length ||
      existing.acknowledgedBatches.some(
        (digest, index) => digest !== digests[index],
      ))
  ) {
    throw new CloudMigrationError(
      'journal_mismatch',
      'A migration journal for a different bundle, link or tenant exists; nothing was sent.',
    );
  }
  const journal: SharedMigrationJournal = existing ?? {
    schemaVersion: 1,
    binding,
    assetsStored: [],
    acknowledgedBatches: [],
    status: 'in-progress',
  };
  writeJsonAtomic(options.journalPath, journal);
  const resumedBatches = journal.acknowledgedBatches.length;

  for (const upload of uploads) {
    if (journal.assetsStored.includes(upload.key)) continue;
    await transport.putAsset(upload);
    journal.assetsStored.push(upload.key);
    writeJsonAtomic(options.journalPath, journal);
  }
  for (let index = resumedBatches; index < batches.length; index += 1) {
    const batch = batches[index];
    const response = await transport.apply({ items: batch });
    const results = response?.results;
    if (!Array.isArray(results) || results.length !== batch.length) {
      throw new CloudMigrationError(
        'item_refused',
        'The hosted sync/apply response does not match the batch.',
      );
    }
    for (let position = 0; position < batch.length; position += 1) {
      const result = results[position];
      if (result?.status !== 'applied') {
        const [table] = batch[position].itemId.split(':');
        throw new CloudMigrationError(
          'item_refused',
          `The hosted application refused ${table} ${batch[position].id} (${safeToken(result?.status) ?? 'missing'}${result?.reason ? `: ${safeToken(result.reason) ?? 'unknown'}` : ''}); nothing was overwritten.`,
          [],
          {
            table,
            rowId: batch[position].id,
            status: safeToken(result?.status),
            reason: safeToken(result?.reason),
          },
        );
      }
    }
    journal.acknowledgedBatches.push(digests[index]);
    writeJsonAtomic(options.journalPath, journal);
  }
  journal.status = 'applied';
  writeJsonAtomic(options.journalPath, journal);
  return {
    itemCount: items.length,
    batchCount: batches.length,
    resumedBatches,
    assetCount: uploads.length,
  };
}

/** Outcome of {@link verifyCloudMigration}. */
export interface CloudMigrationVerification {
  /** Every carried row and asset is present on the target. */
  ok: boolean;
  /** `ok` and every carried value is identical. */
  exact: boolean;
  rowCount: number;
  missing: Array<{ table: string; rowId: string }>;
  /** Per table, columns whose values differ on the target. */
  changedColumns: Record<string, string[]>;
  assets: { missing: string[]; mismatched: string[] };
}

/** JSON with object keys sorted, so jsonb key order never reads as a change. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function comparableValue(
  table: ManifestTable | undefined,
  column: string,
  value: unknown,
): string | null {
  if (table && value != null && isJsonColumn(table, column)) {
    if (typeof value !== 'string') return stableJson(value);
    try {
      return stableJson(JSON.parse(value));
    } catch {
      return value;
    }
  }
  return canonicalValue(value);
}

/**
 * Compare a plan with an export of the target (in the target's IDs, i.e.
 * before any downgrade mapping). Rows are matched by ID; the target may hold
 * more rows than were migrated.
 */
export function verifyCloudMigration(
  plan: CloudMigrationPlan,
  target: Pick<LogicalExportBundle, 'tables' | 'assets'>,
): CloudMigrationVerification {
  const manifest = new Map(plan.tables.map((table) => [table.name, table]));
  const targetRows = new Map<string, Map<string, PortableRow>>();
  for (const table of target.tables ?? []) {
    const byId = new Map<string, PortableRow>();
    for (const row of table.rows ?? []) {
      const id = rowIdOf(row);
      if (id) byId.set(id, row);
    }
    targetRows.set(table.name, byId);
  }
  const missing: CloudMigrationVerification['missing'] = [];
  const changed: Record<string, Set<string>> = {};
  let rowCount = 0;
  for (const table of plan.bundle.tables) {
    const definition = manifest.get(table.name);
    const actual = targetRows.get(table.name) ?? new Map();
    for (const row of table.rows) {
      rowCount += 1;
      const id = rowIdOf(row) as string;
      const found = actual.get(id);
      if (!found) {
        missing.push({ table: table.name, rowId: id });
        continue;
      }
      for (const column of table.columns) {
        if (
          comparableValue(definition, column, row[column]) !==
          comparableValue(definition, column, found[column])
        ) {
          changed[table.name] ??= new Set();
          changed[table.name].add(column);
        }
      }
    }
  }
  const targetAssets = new Map(
    (target.assets?.entries ?? []).map((entry) => [
      entry.key,
      entry.contentDigest,
    ]),
  );
  const assetsMissing: string[] = [];
  const assetsMismatched: string[] = [];
  for (const entry of plan.bundle.assets.entries) {
    const digest = targetAssets.get(entry.key);
    if (digest === undefined) assetsMissing.push(entry.key);
    else if (digest !== entry.contentDigest) assetsMismatched.push(entry.key);
  }
  const changedColumns = Object.fromEntries(
    Object.entries(changed).map(([table, columns]) => [
      table,
      [...columns].sort(),
    ]),
  );
  const ok =
    missing.length === 0 &&
    assetsMissing.length === 0 &&
    assetsMismatched.length === 0;
  return {
    ok,
    exact: ok && Object.keys(changedColumns).length === 0,
    rowCount,
    missing,
    changedColumns,
    assets: { missing: assetsMissing, mismatched: assetsMismatched },
  };
}

/** Default hosted tables of the linked identities and system roles. */
export const DEFAULT_CLOUD_IDENTITY_TABLES = Object.freeze({
  tenantId: 'tenants',
  ownerId: 'users',
  profileId: 'profiles',
  membershipId: 'memberships',
  systemRoles: 'roles',
});

/**
 * The hosted rows a tenant-scoped export selects by ID: each linked identity
 * in its own table, the system roles, and the hosted side of each
 * operator-resolved global mapping (in the table that holds it).
 */
export function cloudIdentityRows(
  link: CloudLinkRecord,
  options: {
    tables?: Partial<typeof DEFAULT_CLOUD_IDENTITY_TABLES>;
    globalRows?: Readonly<Record<string, readonly string[]>>;
  } = {},
): Record<string, string[]> {
  const tables = { ...DEFAULT_CLOUD_IDENTITY_TABLES, ...options.tables };
  const rows: Record<string, string[]> = {};
  const add = (table: string, id: string) => {
    const canonical = canonicalCloudUuid(id);
    if (!canonical) {
      throw new CloudMigrationError('invalid_bundle', 'Row IDs must be UUIDs.');
    }
    const list = rows[table] ?? [];
    rows[table] = list;
    if (!list.includes(canonical)) list.push(canonical);
  };
  for (const key of [
    'tenantId',
    'ownerId',
    'profileId',
    'membershipId',
  ] as const) {
    add(tables[key], link.hostedIdentities[key]);
  }
  for (const id of SYSTEM_ROLE_IDS) add(tables.systemRoles, id);
  for (const [table, ids] of Object.entries(options.globalRows ?? {})) {
    for (const id of ids) add(table, id);
  }
  return rows;
}

/** Options for {@link exportTenantBundle}. */
export interface TenantExportOptions {
  appId: string;
  /** Profile of the exporting runtime. */
  profile: string;
  /** The hosted tenant; never taken from client input. */
  tenantId: string;
  /**
   * Rows selected by ID, per table (see {@link cloudIdentityRows}). In a
   * table with a tenant column only global rows (`tenant_id IS NULL`) are
   * selected this way, so another tenant's row can never be pulled in by
   * reusing an identity's ID.
   */
  idRows: Readonly<Record<string, readonly string[]>>;
  /** Hosted asset bundle for the exported asset rows (default: none). */
  assets?: AssetBundle;
}

/**
 * Hosted-side tenant-scoped export (the downgrade source and the
 * verification target). Rows come only from tables with a tenant column and
 * the tenant's ID, plus the listed global rows by ID; tables whose rows are
 * credential material carry none. Call it inside a read-only transaction for
 * a consistent snapshot.
 */
export async function exportTenantBundle(
  db: ImportExecutor,
  tables: ManifestTable[],
  options: TenantExportOptions,
): Promise<LogicalExportBundle> {
  const tenantId =
    canonicalCloudUuid(options.tenantId) ??
    (() => {
      throw new CloudMigrationError(
        'invalid_bundle',
        'tenantId must be a UUID.',
      );
    })();
  const exported: PortableTable[] = [];
  for (const table of tables) {
    const columns = table.columns.map(quoteIdentifier).join(', ');
    const hasTenant = table.columns.includes(TENANT_COLUMN);
    const ids = table.columns.includes('id')
      ? [...(options.idRows[table.name] ?? [])].map((id) => {
          const canonical = canonicalCloudUuid(id);
          if (!canonical) {
            throw new CloudMigrationError(
              'invalid_bundle',
              'Row IDs must be UUIDs.',
            );
          }
          return canonical;
        })
      : [];
    let rows: PortableRow[] = [];
    if (!isCloudNonPortable(table) && (hasTenant || ids.length > 0)) {
      const conditions: string[] = [];
      const params: unknown[] = [];
      const idList = `${quoteIdentifier('id')} IN (${ids.map(() => '?').join(', ')})`;
      if (hasTenant) {
        conditions.push(`${quoteIdentifier(TENANT_COLUMN)} = ?`);
        params.push(tenantId);
        if (ids.length > 0) {
          conditions.push(
            `(${quoteIdentifier(TENANT_COLUMN)} IS NULL AND ${idList})`,
          );
          params.push(...ids);
        }
      } else {
        conditions.push(idList);
        params.push(...ids);
      }
      rows = (
        await db.query(
          `SELECT ${columns} FROM ${quoteIdentifier(table.name)} WHERE ${conditions.join(' OR ')}`,
          ...params,
        )
      ).rows as PortableRow[];
    }
    exported.push({ name: table.name, columns: table.columns, rows });
  }
  return {
    schemaVersion: 2,
    application: options.appId,
    profile: options.profile,
    exportedAt: new Date().toISOString(),
    tables: exported,
    assets: filterAssets(
      options.assets ?? {
        schemaVersion: ASSET_MANIFEST_SCHEMA_VERSION,
        adapter: 'filesystem',
        entries: [],
        payloads: [],
      },
      assetKeysOf(exported),
    ),
  };
}

/** A row whose JSON columns hold JSON text (a `local` bundle's encoding). */
function jsonColumnsAsText(
  table: ManifestTable,
  row: PortableRow,
  parsed: boolean,
): PortableRow {
  if (!parsed) return row;
  const out: PortableRow = { ...row };
  for (const column of Object.keys(row)) {
    if (
      row[column] != null &&
      !(row[column] instanceof Uint8Array) &&
      isJsonColumn(table, column)
    ) {
      out[column] = JSON.stringify(row[column]);
    }
  }
  return out;
}

/** Options for {@link downgradeCloudBundle}. */
export interface CloudDowngradeOptions {
  /** The hosted export (`exportTenantBundle`, or a per-user `app export`). */
  bundle: unknown;
  tables: ManifestTable[];
  /** The link the data was migrated under. */
  link: CloudLinkRecord;
  /** The same operator-resolved global mappings, local → hosted. */
  globalIdentityMap?: Readonly<Record<string, string>>;
  /**
   * Engine the hosted export was read from. PostgreSQL returns JSON columns
   * parsed, SQLite as text; the downgrade always produces a `local` bundle
   * with JSON columns as JSON text. Defaults from the bundle's profile.
   */
  sourceEngine?: 'sqlite' | 'postgres';
  /**
   * The per-table hosted IDs the export selected by ID (`cloudIdentityRows`).
   * When given, a global or tenantless row is accepted only in its own table.
   */
  idRows?: Readonly<Record<string, readonly string[]>>;
}

/**
 * Turn a hosted export into the local bundle `smrt app import` accepts:
 * hosted identities are mapped back to the link's original local identities.
 * Refuses (`plan_refused`):
 *
 * - shared target: a row of another tenant (`foreign_tenant_row`), a global
 *   row that is not a linked identity, system role or mapped global row
 *   (`global_row`), or such a row in a table without a tenant column
 *   (`tenantless_row`);
 * - a value that already equals a local identity (`identity_collision`) or
 *   embeds a hosted identity (`embedded_identity`);
 * - a `file:` URL or local asset locator anywhere but `assets.source_uri`,
 *   which import then verifies against the bundle's asset manifest
 *   (`local_locator`); a tampered system role (`modified_system_row`).
 */
export function downgradeCloudBundle(
  options: CloudDowngradeOptions,
): LogicalExportBundle {
  const link = parseCloudLinkRecord(options.link);
  const bundle = requireBundle(options.bundle, link.appId, options.tables);
  const shared = link.target === 'shared';
  const forward = new Map(cloudLinkIdentityMap(link));
  for (const [from, to] of Object.entries(
    normalizeGlobalMap(options.globalIdentityMap, shared, forward),
  )) {
    forward.set(from, to);
  }
  const reverse = new Map<string, string>();
  for (const [local, hosted] of forward) reverse.set(hosted, local);
  const localIds = new Set(Object.values(link.localIdentities));
  for (const [local, hosted] of forward) {
    if (local !== hosted) localIds.add(local);
  }
  const rules: ValueRules = {
    map: reverse,
    forbidden: shared ? localIds : new Set(),
    embedded: shared ? Object.values(link.hostedIdentities) : [],
    dropped: new Set(),
  };
  const byIdAllowed = new Set(reverse.keys());
  const parsedJson =
    (options.sourceEngine ??
      (bundle.profile === 'local' ? 'sqlite' : 'postgres')) === 'postgres';
  const issues = new IssueCollector();
  const tables: PortableTable[] = [];
  const exportedByName = new Map(
    bundle.tables.map((table) => [table.name, table]),
  );
  for (const table of options.tables) {
    const exported = exportedByName.get(table.name) as PortableTable;
    const hasTenant = table.columns.includes(TENANT_COLUMN);
    const rows: PortableRow[] = [];
    if (!isCloudNonPortable(table)) {
      for (const row of exported.rows) {
        const id = rowIdOf(row);
        if (id && SYSTEM_ROLE_IDS.has(id)) {
          checkSystemRow(table, row, id, issues);
        }
        if (shared) {
          const tenant = canonicalCloudUuid(row[TENANT_COLUMN]);
          const byId =
            id !== null &&
            byIdAllowed.has(id) &&
            (!options.idRows ||
              (options.idRows[table.name] ?? []).some(
                (allowed) => canonicalCloudUuid(allowed) === id,
              ));
          const refused: CloudMigrationIssue['code'] | null = !hasTenant
            ? byId
              ? null
              : 'tenantless_row'
            : row[TENANT_COLUMN] == null
              ? byId
                ? null
                : 'global_row'
              : tenant === link.tenantId
                ? null
                : 'foreign_tenant_row';
          if (refused) {
            issues.add({ code: refused, table: table.name, rowId: id });
            continue;
          }
        }
        rows.push(
          rewriteRow(
            table,
            jsonColumnsAsText(table, row, parsedJson),
            rules,
            issues,
          ),
        );
      }
    }
    tables.push({ name: table.name, columns: exported.columns, rows });
  }
  issues.throwIfAny('The hosted export cannot be restored locally');
  return {
    schemaVersion: 2,
    application: bundle.application,
    profile: 'local',
    exportedAt: bundle.exportedAt,
    tables,
    assets: filterAssets(bundle.assets, assetKeysOf(tables)),
  };
}

function stateRootPath(
  options: InstallationCustodyOptions,
  name: string,
): string {
  return join(prepareApplicationStateRoot(stateRootOptions(options)), name);
}

/** `<state root>/cloud-link.json`: the verified link receipt (no secrets). */
export function cloudLinkRecordPath(
  options: InstallationCustodyOptions,
): string {
  return stateRootPath(options, 'cloud-link.json');
}

/**
 * Store a verified link receipt atomically (mode 0600). Re-storing the same
 * link is a no-op; a different link for this location is refused.
 */
export function writeCloudLinkRecord(
  options: InstallationCustodyOptions,
  link: CloudLinkRecord,
): CloudLinkRecord {
  const record = parseCloudLinkRecord(link);
  const existing = readCloudLinkRecord(options);
  if (existing) {
    if (JSON.stringify(existing) !== JSON.stringify(record)) {
      throw new CloudMigrationError(
        'custody_refused',
        'A different cloud link is already recorded for this location.',
      );
    }
    return existing;
  }
  writeJsonAtomic(cloudLinkRecordPath(options), record);
  return record;
}

/** Read the stored link receipt, or `null`. */
export function readCloudLinkRecord(
  options: InstallationCustodyOptions,
): CloudLinkRecord | null {
  const path = cloudLinkRecordPath(options);
  if (!existsSync(path)) return null;
  try {
    return parseCloudLinkRecord(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    throw new CloudMigrationError(
      'custody_refused',
      'The stored cloud link record is unreadable.',
    );
  }
}

/** Local record of a migration, `<state root>/cloud-migration.json`. */
export interface CloudMigrationRecord {
  schemaVersion: 1;
  status: 'in-progress' | 'completed';
  target: CloudLinkRecord['target'];
  installationId: string;
  startedAt: string;
  /** Set for a shared migration at start, for per-user at completion. */
  linkId?: string;
  origin?: string;
  accountId?: string;
  tenantId?: string;
  completedAt?: string;
  bundleDigest?: string;
  acknowledgedChangedColumns?: Record<string, string[]>;
  /** Tables withheld from the bundle that the operator accepted leaving behind. */
  acknowledgedOmittedTables?: string[];
  /**
   * Custody epoch of the installation when the migration began. A restore
   * (abandoning the migration) bumps it, so completion can tell that this
   * location was put back in service after the bundle's retirement.
   */
  custodyEpoch?: number;
  secretValuesIncluded: false;
}

/** Where the migration record lives for an installation. */
export function cloudMigrationRecordPath(
  options: InstallationCustodyOptions,
): string {
  return stateRootPath(options, 'cloud-migration.json');
}

/** Read the local migration record, or `null`. */
export function readCloudMigrationRecord(
  options: InstallationCustodyOptions,
): CloudMigrationRecord | null {
  const path = cloudMigrationRecordPath(options);
  if (!existsSync(path)) return null;
  let record: Partial<CloudMigrationRecord>;
  try {
    record = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    record = {};
  }
  if (
    record?.schemaVersion !== 1 ||
    (record.status !== 'in-progress' && record.status !== 'completed') ||
    (record.target !== 'shared' && record.target !== 'per-user') ||
    !canonicalCloudUuid(record.installationId) ||
    Number.isNaN(Date.parse(String(record.startedAt))) ||
    record.secretValuesIncluded !== false
  ) {
    throw new CloudMigrationError(
      'custody_refused',
      'The cloud migration record is unreadable.',
    );
  }
  return record as CloudMigrationRecord;
}

/**
 * Open the link identity for the **per-user** link of a migration in progress.
 *
 * Beginning a migration retires this location before the bundle is exported,
 * and the per-user link can only be made after that bundle is imported (the
 * hosted account is the imported local owner), so an ordinary
 * {@link openLocalCloudLinkIdentity} would refuse by then. This opens it for
 * the installation the migration record names, on a location that is retired
 * for exactly that installation, and signs only the per-user challenge.
 */
export async function openMigrationCloudLinkIdentity(
  options: InstallationCustodyOptions,
): Promise<LocalCloudLinkIdentity> {
  const record = readCloudMigrationRecord(options);
  if (
    !record ||
    record.target !== 'per-user' ||
    record.status !== 'in-progress'
  ) {
    throw new CloudMigrationError(
      'custody_refused',
      'No per-user cloud migration is in progress at this location.',
    );
  }
  return openLocalCloudLinkIdentity({
    ...options,
    retiredInstallationId: record.installationId,
  });
}

/** Options for {@link beginCloudMigration}. */
export type BeginCloudMigrationOptions = InstallationCustodyOptions &
  (
    | { target: 'shared'; link: CloudLinkRecord }
    | { target: 'per-user'; link?: undefined }
  );

/**
 * Start a migration: retire this location **before** the bundle is exported,
 * so no local write can follow the snapshot (the runtime refuses to start a
 * retired location). Checks custody and any earlier record first, so a wrong
 * link changes nothing. Requires the application to be stopped.
 * `smrt app installation restore --origin-retired` resumes local use if the
 * migration is abandoned.
 */
export async function beginCloudMigration(
  options: BeginCloudMigrationOptions,
): Promise<CloudMigrationRecord> {
  const link = options.link ? parseCloudLinkRecord(options.link) : null;
  if ((options.target === 'shared') !== (link?.target === 'shared')) {
    throw new CloudMigrationError(
      'custody_refused',
      'A shared migration needs its shared-target link; a per-user one starts without.',
    );
  }
  const custody = await inspectInstallationCustody(options);
  const existing = readCloudMigrationRecord(options);
  if (existing) {
    if (
      existing.target !== options.target ||
      existing.installationId !== custody.installationId ||
      (link && existing.linkId !== link.linkId)
    ) {
      throw new CloudMigrationError(
        'custody_refused',
        'A different cloud migration is recorded for this location.',
      );
    }
    if (existing.status === 'completed' || custody.status === 'retired') {
      return existing;
    }
    if (custody.status !== 'in-custody') {
      throw new CloudMigrationError(
        'custody_refused',
        `This data root is not in this location's custody (${custody.status}).`,
      );
    }
    // An interrupted start, or a location restored after an abandoned
    // attempt: retire again and restart the clock, so only a bundle exported
    // from now on can complete the migration.
    const restarted = {
      ...existing,
      startedAt: new Date().toISOString(),
      ...(custody.epoch !== null ? { custodyEpoch: custody.epoch } : {}),
    };
    writeJsonAtomic(cloudMigrationRecordPath(options), restarted);
    await retireInstallation(options);
    return restarted;
  }
  if (custody.status !== 'in-custody' || !custody.installationId) {
    throw new CloudMigrationError(
      'custody_refused',
      `This data root is not in this location's custody (${custody.status}).`,
    );
  }
  if (link && link.installationId !== custody.installationId) {
    throw new CloudMigrationError(
      'custody_refused',
      'The link belongs to a different installation than this data root.',
    );
  }
  const record: CloudMigrationRecord = {
    schemaVersion: 1,
    status: 'in-progress',
    target: options.target,
    installationId: custody.installationId,
    startedAt: new Date().toISOString(),
    ...(custody.epoch !== null ? { custodyEpoch: custody.epoch } : {}),
    ...(link
      ? {
          linkId: link.linkId,
          origin: link.origin,
          accountId: link.accountId,
          tenantId: link.tenantId,
        }
      : {}),
    secretValuesIncluded: false,
  };
  // Record first, then retire: a crash between the two leaves a record that
  // the next start completes.
  writeJsonAtomic(cloudMigrationRecordPath(options), record);
  await retireInstallation(options);
  return record;
}

/** Options for {@link completeCloudMigration}. */
export interface CompleteCloudMigrationOptions
  extends InstallationCustodyOptions {
  plan: CloudMigrationPlan;
  /** The link: the shared one, or the per-user one made after import. */
  link: CloudLinkRecord;
  /** A fresh export of the target, in hosted IDs. */
  target: Pick<LogicalExportBundle, 'tables' | 'assets'>;
  /** Shared target: the journal the run wrote; it must say `applied`. */
  journalPath?: string;
  /** Columns allowed to differ on the target (never `id` / `tenant_id`). */
  acknowledgedChangedColumns?: Readonly<Record<string, readonly string[]>>;
  /**
   * Tables whose rows were withheld from the bundle (`plan.skipped
   * .omittedTables`: credential-like columns) and are therefore not on the
   * target. Every one must be named: completing retires the local copy.
   */
  acknowledgedOmittedTables?: readonly string[];
}

/**
 * Finish a migration. Verifies the target itself, and refuses unless:
 * this location is still retired for the installation the migration began
 * with (restoring it, even after a later retire, is abandoning the migration:
 * writes made since never reached the cloud); the plan's bundle was exported
 * after the location was retired; the link
 * matches the plan (and, per-user, maps the plan's identities to themselves);
 * a shared run's journal is `applied` for this bundle and link; every carried
 * row and asset is present; every table withheld from the bundle is
 * acknowledged; and every column whose value changed on the target is
 * acknowledged (`id` and `tenant_id` never can be).
 */
export async function completeCloudMigration(
  options: CompleteCloudMigrationOptions,
): Promise<CloudMigrationVerification & { record: CloudMigrationRecord }> {
  const { plan } = options;
  const link = parseCloudLinkRecord(options.link);
  const existing = readCloudMigrationRecord(options);
  const refuse = (message: string): never => {
    throw new CloudMigrationError('custody_refused', message);
  };
  if (!existing || existing.target !== plan.target) {
    refuse('No migration for this target was started at this location.');
  }
  const started = existing as CloudMigrationRecord;
  if (existing?.status === 'completed') {
    if (existing.bundleDigest !== plan.bundleDigest) {
      refuse('A different migration already completed here.');
    }
  }
  const custody = await inspectInstallationCustody(options);
  if (
    custody.status !== 'retired' ||
    custody.installationId !== started.installationId ||
    (started.custodyEpoch !== undefined &&
      custody.epoch !== started.custodyEpoch)
  ) {
    refuse(
      `This location is not retired for the installation the migration began with (${custody.status}); it was put back in service, so local writes since may never have reached the cloud. Start the migration again and export a new bundle.`,
    );
  }
  const exportedAt = Date.parse(plan.bundle.exportedAt);
  const startedAt = Date.parse(started.startedAt);
  if (
    !Number.isFinite(exportedAt) ||
    !Number.isFinite(startedAt) ||
    exportedAt < startedAt
  ) {
    refuse(
      'The migrated bundle has no valid export time or was exported before this location was retired; export again.',
    );
  }
  if (
    link.target !== plan.target ||
    link.appId !== plan.appId ||
    link.installationId !== started.installationId ||
    JSON.stringify(link.localIdentities) !==
      JSON.stringify(plan.localIdentities) ||
    (plan.target === 'shared' &&
      (plan.link?.linkId !== link.linkId || started.linkId !== link.linkId)) ||
    (plan.target === 'per-user' &&
      JSON.stringify(link.hostedIdentities) !==
        JSON.stringify(plan.localIdentities))
  ) {
    refuse('The link does not match the migration plan.');
  }
  if (plan.target === 'shared') {
    const journal = options.journalPath
      ? readJournal(options.journalPath)
      : null;
    if (
      journal?.status !== 'applied' ||
      journal.binding.bundleDigest !== plan.bundleDigest ||
      journal.binding.linkId !== link.linkId
    ) {
      refuse('The shared migration has not been applied for this plan.');
    }
  }
  const acknowledgedOmitted = new Set(options.acknowledgedOmittedTables ?? []);
  const unacknowledgedOmitted = plan.skipped.omittedTables.filter(
    (table) => !acknowledgedOmitted.has(table),
  );
  if (unacknowledgedOmitted.length > 0) {
    throw new CloudMigrationError(
      'verification_failed',
      `These tables were withheld from the migration (credential-like columns) and are not on the target; acknowledge each to complete and retire the local copy: ${unacknowledgedOmitted.join(', ')}.`,
      [],
      { unacknowledgedOmittedTables: unacknowledgedOmitted },
    );
  }
  const verification = verifyCloudMigration(plan, options.target);
  if (!verification.ok) {
    throw new CloudMigrationError(
      'verification_failed',
      'The target is missing migrated rows or assets.',
      [],
      {
        missing: verification.missing.length,
        assetsMissing: verification.assets.missing.length,
        assetsMismatched: verification.assets.mismatched.length,
      },
    );
  }
  const acknowledged = options.acknowledgedChangedColumns ?? {};
  const unacknowledged = Object.entries(verification.changedColumns).flatMap(
    ([table, columns]) =>
      columns
        .filter(
          (column) =>
            column === 'id' ||
            column === TENANT_COLUMN ||
            !acknowledged[table]?.includes(column),
        )
        .map((column) => `${table}.${column}`),
  );
  if (unacknowledged.length > 0) {
    throw new CloudMigrationError(
      'verification_failed',
      `Values changed on the target and must be acknowledged: ${unacknowledged.join(', ')}.`,
      [],
      { unacknowledged },
    );
  }
  const record: CloudMigrationRecord = {
    ...started,
    status: 'completed',
    linkId: link.linkId,
    origin: link.origin,
    accountId: link.accountId,
    tenantId: link.tenantId,
    completedAt: new Date().toISOString(),
    bundleDigest: plan.bundleDigest,
    acknowledgedChangedColumns: verification.changedColumns,
    ...(plan.skipped.omittedTables.length > 0
      ? { acknowledgedOmittedTables: [...plan.skipped.omittedTables] }
      : {}),
  };
  writeJsonAtomic(cloudMigrationRecordPath(options), record);
  return { ...verification, record };
}
