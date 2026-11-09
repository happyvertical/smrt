/**
 * `bundle-report.json` v1 and `bundle-files.sha256`.
 *
 * The report is the provenance and verification record of one bundle. Its
 * schema is closed (unknown keys, duplicate keys, wrong types and unsorted
 * lists are rejected), the serializer is canonical (fixed key order, two-space
 * indent, trailing newline) and it carries no timestamp, no absolute path and
 * no host name, so identical inputs produce a byte-identical report. Only
 * `host` and `measurements` describe the machine that ran the bundler; they
 * are the two members excluded from the determinism guarantee, and the report
 * file itself is not part of `bundle-files.sha256`.
 *
 * Nothing here can hold a secret: values are hashes, versions, bundle-relative
 * paths and counts.
 */

import { createHash } from 'node:crypto';
import { deepFreeze } from '../internal/freeze.js';
import {
  hasClosedKeys,
  isRecord,
  parseStrictJson,
} from '../internal/strict-json.js';
import { BundleError } from './errors.js';

export const BUNDLE_REPORT_FILENAME = 'bundle-report.json';
export const BUNDLE_FILES_FILENAME = 'bundle-files.sha256';

export interface SeriesStats {
  readonly runs: number;
  readonly samplesMs: readonly number[];
  readonly medianMs: number;
  readonly maxMs: number;
}

/** Host-only measurements (design section 5). Absent unless `--measure`. */
export interface BundleMeasurements {
  /** Output of `<bundled node> --version`: proves the binary executes. */
  readonly nodeVersionOutput: string;
  readonly healthRoute: string;
  readonly installed: {
    readonly apparentBytes: number;
    /** `stat.blocks * 512` on POSIX; absent on Windows. */
    readonly onDiskBytes?: number;
    readonly files: number;
  };
  readonly coldStart: {
    /** A new, empty data directory for every run. */
    readonly firstRun: SeriesStats;
    /** One data directory reused after a first run. */
    readonly warm: SeriesStats;
  };
}

export interface ReportPackage {
  readonly name: string;
  readonly version: string;
  readonly path: string;
}

export interface ReportNative {
  readonly path: string;
  readonly format: 'macho' | 'macho-fat' | 'elf' | 'pe';
  readonly kind: 'executable' | 'library' | 'either';
  readonly machines: readonly string[];
  readonly libc?: string;
}

export interface BundleReportV1 {
  readonly version: 1;
  readonly tool: { readonly name: string; readonly version: string };
  readonly product: {
    readonly productId: string;
    readonly bundleId: string;
    readonly displayName: string;
    readonly productVersion: string;
    readonly channel: string;
  };
  readonly target: string;
  readonly host: {
    readonly platform: string;
    readonly arch: string;
    readonly node: string;
    readonly pnpm: string;
  };
  readonly inputs: {
    readonly packageJsonSha256: string;
    readonly lockfileSha256: string;
    readonly workspaceYamlSha256?: string;
    readonly patchesSha256?: string;
    readonly productConfigSha256?: string;
    readonly buildTreeSha256: string;
  };
  readonly node: {
    readonly version: string;
    readonly distFile: string;
    /** Equals the committed pin: acquisition verified it before use. */
    readonly archiveSha256: string;
    readonly binarySha256: string;
    readonly machine: string;
  };
  readonly bridge: {
    readonly file: string;
    readonly sha256: string;
    readonly bytes: number;
  };
  readonly features: {
    readonly enabled: readonly string[];
    readonly removedPackages: readonly ReportPackageRemoval[];
    readonly acknowledgedDynamicImports: readonly {
      readonly from: string;
      readonly specifier: string;
    }[];
  };
  readonly packages: readonly ReportPackage[];
  readonly natives: readonly ReportNative[];
  readonly nativeExceptions: readonly {
    readonly path: string;
    readonly pattern: string;
    readonly reason: string;
  }[];
  /**
   * `files`/`bytes`: removed by the file rules (maps, types, docs, tests,
   * foreign prebuilds) inside kept packages. `removedPackage*`: whole packages
   * dropped by feature segmentation.
   */
  readonly pruned: {
    readonly files: number;
    readonly bytes: number;
    readonly removedPackageFiles: number;
    readonly removedPackageBytes: number;
  };
  readonly files: {
    readonly count: number;
    readonly bytes: number;
    readonly listSha256: string;
    readonly breakdown: {
      readonly nodeBinary: number;
      readonly nodeModules: number;
      readonly appBuild: number;
      readonly other: number;
    };
  };
  readonly measurements?: BundleMeasurements;
}

export interface ReportPackageRemoval {
  readonly name: string;
  readonly version: string;
  /** Bundle-relative path the package would have had. */
  readonly path: string;
  readonly reason: string;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

interface Node {
  check(value: unknown, path: string): void;
  order(value: unknown): unknown;
}

function fail(path: string): never {
  throw new BundleError('report_invalid', { field: path });
}

function prim(accept: (value: unknown) => boolean): Node {
  return {
    check(value, path) {
      if (!accept(value)) fail(path);
    },
    order: (value) => value,
  };
}

const SHA256 = /^[0-9a-f]{64}$/;
const text = (max = 512) =>
  prim(
    (v) =>
      typeof v === 'string' &&
      v.length > 0 &&
      v.length <= max &&
      // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
      !/[\u0000-\u001f\u007f]/.test(v),
  );
const sha = prim((v) => typeof v === 'string' && SHA256.test(v));
const count = prim((v) => Number.isSafeInteger(v) && (v as number) >= 0);
const ms = prim(
  (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1e9,
);
const lit = (expected: unknown) => prim((v) => v === expected);
const oneOf = (...values: readonly string[]) =>
  prim((v) => typeof v === 'string' && values.includes(v));

/** A relative bundle path: forward slashes, no `.`/`..`, no leading slash. */
const relPath = prim(
  (v) =>
    typeof v === 'string' &&
    v.length > 0 &&
    v.length <= 1024 &&
    !v.startsWith('/') &&
    !v.includes('\\') &&
    !v.includes('\0') &&
    v.split('/').every((s) => s.length > 0 && s !== '.' && s !== '..'),
);

type Field = readonly [key: string, node: Node, optional?: boolean];

function obj(fields: readonly Field[]): Node {
  const required = fields.filter((f) => f[2] !== true).map((f) => f[0]);
  const optional = fields.filter((f) => f[2] === true).map((f) => f[0]);
  return {
    check(value, path) {
      if (!isRecord(value) || !hasClosedKeys(value, required, optional)) {
        fail(path);
      }
      const record = value as Record<string, unknown>;
      for (const [key, node] of fields) {
        if (Object.hasOwn(record, key)) {
          node.check(record[key], path === '' ? key : `${path}.${key}`);
        }
      }
    },
    order(value) {
      const record = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [key, node] of fields) {
        if (Object.hasOwn(record, key)) out[key] = node.order(record[key]);
      }
      return out;
    },
  };
}

function arr(
  item: Node,
  options: {
    max?: number;
    /** Items must be strictly increasing by this key. */
    sortKey?: (item: unknown) => string;
  } = {},
): Node {
  return {
    check(value, path) {
      if (!Array.isArray(value) || value.length > (options.max ?? 200_000)) {
        fail(path);
      }
      const items = value as unknown[];
      items.forEach((entry, index) => {
        item.check(entry, `${path}[${index}]`);
      });
      const key = options.sortKey;
      if (key !== undefined) {
        for (let i = 1; i < items.length; i += 1) {
          const a = key(items[i - 1]);
          const b = key(items[i]);
          if (!(a < b)) fail(path);
        }
      }
    },
    order: (value) => (value as unknown[]).map((entry) => item.order(entry)),
  };
}

const stringList = (sortedUnique: boolean, max = 1000) =>
  arr(text(), {
    max,
    ...(sortedUnique ? { sortKey: (v: unknown) => v as string } : {}),
  });

const series = obj([
  ['runs', count],
  ['samplesMs', arr(ms, { max: 100 })],
  ['medianMs', ms],
  ['maxMs', ms],
]);

const SCHEMA = obj([
  ['version', lit(1)],
  [
    'tool',
    obj([
      ['name', text(128)],
      ['version', text(64)],
    ]),
  ],
  [
    'product',
    obj([
      ['productId', text(64)],
      ['bundleId', text(255)],
      ['displayName', text(128)],
      ['productVersion', text(64)],
      ['channel', text(32)],
    ]),
  ],
  ['target', text(64)],
  [
    'host',
    obj([
      ['platform', text(32)],
      ['arch', text(32)],
      ['node', text(32)],
      ['pnpm', text(64)],
    ]),
  ],
  [
    'inputs',
    obj([
      ['packageJsonSha256', sha],
      ['lockfileSha256', sha],
      ['workspaceYamlSha256', sha, true],
      ['patchesSha256', sha, true],
      ['productConfigSha256', sha, true],
      ['buildTreeSha256', sha],
    ]),
  ],
  [
    'node',
    obj([
      ['version', text(32)],
      ['distFile', text(128)],
      ['archiveSha256', sha],
      ['binarySha256', sha],
      ['machine', oneOf('arm64', 'x86_64')],
    ]),
  ],
  [
    'bridge',
    obj([
      ['file', relPath],
      ['sha256', sha],
      ['bytes', count],
    ]),
  ],
  [
    'features',
    obj([
      ['enabled', stringList(true, 64)],
      [
        'removedPackages',
        arr(
          obj([
            ['name', text(214)],
            ['version', text(64)],
            ['path', relPath],
            ['reason', text(256)],
          ]),
          { sortKey: (v) => (v as ReportPackageRemoval).path },
        ),
      ],
      [
        'acknowledgedDynamicImports',
        arr(
          obj([
            ['from', text(512)],
            ['specifier', text(512)],
          ]),
          {
            sortKey: (v) => {
              const r = v as { from: string; specifier: string };
              return `${r.from}\0${r.specifier}`;
            },
          },
        ),
      ],
    ]),
  ],
  [
    'packages',
    arr(
      obj([
        ['name', text(214)],
        ['version', text(64)],
        ['path', relPath],
      ]),
      { sortKey: (v) => (v as ReportPackage).path },
    ),
  ],
  [
    'natives',
    arr(
      obj([
        ['path', relPath],
        ['format', oneOf('macho', 'macho-fat', 'elf', 'pe')],
        ['kind', oneOf('executable', 'library', 'either')],
        ['machines', stringList(false, 8)],
        ['libc', text(16), true],
      ]),
      { sortKey: (v) => (v as ReportNative).path },
    ),
  ],
  [
    'nativeExceptions',
    arr(
      obj([
        ['path', relPath],
        ['pattern', text(256)],
        ['reason', text(256)],
      ]),
      { sortKey: (v) => (v as { path: string }).path },
    ),
  ],
  [
    'pruned',
    obj([
      ['files', count],
      ['bytes', count],
      ['removedPackageFiles', count],
      ['removedPackageBytes', count],
    ]),
  ],
  [
    'files',
    obj([
      ['count', count],
      ['bytes', count],
      ['listSha256', sha],
      [
        'breakdown',
        obj([
          ['nodeBinary', count],
          ['nodeModules', count],
          ['appBuild', count],
          ['other', count],
        ]),
      ],
    ]),
  ],
  [
    'measurements',
    obj([
      ['nodeVersionOutput', text(128)],
      ['healthRoute', text(256)],
      [
        'installed',
        obj([
          ['apparentBytes', count],
          ['onDiskBytes', count, true],
          ['files', count],
        ]),
      ],
      [
        'coldStart',
        obj([
          ['firstRun', series],
          ['warm', series],
        ]),
      ],
    ]),
    true,
  ],
]);

/** Validate a report against the closed v1 schema; returns it frozen. */
export function validateBundleReport(value: unknown): BundleReportV1 {
  SCHEMA.check(value, '');
  return deepFreeze(value as BundleReportV1);
}

/** Canonical JSON: validated, fixed key order, two-space indent, newline. */
export function serializeBundleReport(report: BundleReportV1): string {
  SCHEMA.check(report, '');
  return `${JSON.stringify(SCHEMA.order(report), null, 2)}\n`;
}

/** Parse `bundle-report.json` strictly (duplicate keys and unknown keys fail). */
export function parseBundleReport(json: string): BundleReportV1 {
  const parsed = parseStrictJson(json);
  if (!parsed.ok) throw new BundleError('report_invalid');
  return validateBundleReport(parsed.value);
}

// ---------------------------------------------------------------------------
// bundle-files.sha256
// ---------------------------------------------------------------------------

export interface FileDigest {
  /** Bundle-relative path with forward slashes. */
  readonly path: string;
  readonly sha256: string;
}

const byPath = (a: FileDigest, b: FileDigest): number =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0;

/**
 * `<sha256>  <path>` lines, sorted by UTF-16 code unit order of the path (the
 * same on every OS and independent of the order the files were listed in),
 * each ending in a newline. Compatible with `sha256sum -c`.
 */
export function formatFileList(entries: readonly FileDigest[]): string {
  const sorted = [...entries].sort(byPath);
  for (let i = 0; i < sorted.length; i += 1) {
    const entry = sorted[i] as FileDigest;
    if (!SHA256.test(entry.sha256) || entry.path.includes('\n')) {
      throw new BundleError('report_invalid');
    }
    if (i > 0 && (sorted[i - 1] as FileDigest).path === entry.path) {
      throw new BundleError('report_invalid');
    }
  }
  return sorted.map((entry) => `${entry.sha256}  ${entry.path}\n`).join('');
}

export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}
