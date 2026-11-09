/**
 * The one error type, and the one closed exit-code table, of the runtime
 * bundler.
 *
 * Three worker modules throw their own value-free error classes
 * (`NodeDistError`, `BundleTreeError`, `NativeVerificationError`). The
 * orchestrator adds a few failures of its own. `BundleError` unifies all four
 * behind a closed `code` union, a `category` and an `exitCode`, so the CLI has
 * exactly one place that decides what a failure means to a shell.
 *
 * Exit codes (design section 1.3):
 *
 * | Exit | Category        | Meaning |
 * | ---- | --------------- | ------- |
 * | 0    | (ok)            | bundle written, all checks green |
 * | 1    | `internal`      | unexpected error (a bug) |
 * | 2    | `usage`         | bad or missing option, unsupported target, unpinned Node |
 * | 3    | `invalid_input` | app, build, lockfile or configuration missing or invalid |
 * | 4    | `provenance`    | checksum mismatch, fetch refused, lockfile drift |
 * | 5    | `verification`  | wrong-arch native, symlink, secret, removed package imported |
 * | 6    | `budget`        | `--max-size` exceeded |
 * | 7    | `child_failed`  | pnpm failed, smoke start failed |
 * | 8    | `io`            | a file operation failed |
 *
 * The message is fixed text keyed by `code`; it never contains a path, a
 * package name, a version, a URL or a child process's output. Diagnostics a
 * human needs travel in `field`, `subjects` (bundle-relative paths or package
 * names) and `failures` (native verification), never in `message`.
 */

import {
  type NativeErrorCode,
  type NativeFailure,
  NativeVerificationError,
  nativeErrorMessage,
} from './native/errors.js';
import {
  NODE_DIST_MESSAGES,
  NodeDistError,
  type NodeDistErrorCode,
} from './node-errors.js';
import type { BundleReportV1 } from './report.js';
import {
  BundleTreeError,
  MAX_ERROR_SUBJECTS,
  TREE_ERROR_MESSAGE_TABLE,
  type TreeErrorCode,
} from './tree-errors.js';

/** The closed exit-code table. */
export const BUNDLE_EXIT_CODES = Object.freeze({
  ok: 0,
  internal: 1,
  usage: 2,
  invalid_input: 3,
  provenance: 4,
  verification: 5,
  budget: 6,
  child_failed: 7,
  io: 8,
});

export type BundleErrorCategory = Exclude<keyof typeof BUNDLE_EXIT_CODES, 'ok'>;

/** Pipeline stages, in execution order (design section 2.2). */
export const BUNDLE_STAGES = [
  'inputs',
  'build_copy',
  'install',
  'normalize',
  'segment',
  'prune_copy',
  'scan',
  'bridge',
  'node',
  'natives',
  'manifests',
  'report',
  'measure',
  'publish',
] as const;

export type BundleStage = (typeof BUNDLE_STAGES)[number];

const OWN_CODES = {
  // usage
  measure_needs_host_target:
    'Measuring needs the bundle target to be the machine running the bundler',
  // invalid_input
  bridge_missing:
    'A pre-bundled bridge file is required for the bundle (pass --bridge)',
  bridge_config_missing:
    'The product configuration has no bridge section (envPrefix and mcpPath)',
  entry_missing: 'The sidecar entry script is not in the build output',
  // provenance
  lockfile_drift:
    'pnpm-lock.yaml does not match package.json, so the frozen install was refused',
  integrity_failure: 'A downloaded package failed its integrity check',
  lockfile_non_registry:
    'The lockfile resolves an installed package from a tarball URL, git or a directory',
  // verification
  bridge_not_self_contained:
    'The bridge file imports something other than Node built-in modules',
  build_step_required:
    'An installed package needs a build step and ships no prebuilt binary',
  manifest_round_trip:
    'The written manifests do not round-trip through the contract parsers',
  bundle_changed_while_measuring:
    'The bundle changed while it was being started for measurement',
  // budget
  size_budget_exceeded: 'The installed size is above the configured budget',
  // child_failed
  pnpm_failed: 'pnpm install failed',
  smoke_start_failed:
    'The bundled sidecar did not answer its health route in time',
  // internal
  report_invalid: 'The bundle report does not match its schema',
  internal: 'An unexpected error occurred',
} as const;

type OwnCodeName = keyof typeof OWN_CODES;

const OWN_CATEGORY: Record<OwnCodeName, BundleErrorCategory> = {
  measure_needs_host_target: 'usage',
  bridge_missing: 'invalid_input',
  bridge_config_missing: 'invalid_input',
  entry_missing: 'invalid_input',
  lockfile_drift: 'provenance',
  integrity_failure: 'provenance',
  lockfile_non_registry: 'provenance',
  bridge_not_self_contained: 'verification',
  build_step_required: 'verification',
  manifest_round_trip: 'verification',
  bundle_changed_while_measuring: 'verification',
  size_budget_exceeded: 'budget',
  pnpm_failed: 'child_failed',
  smoke_start_failed: 'child_failed',
  report_invalid: 'internal',
  internal: 'internal',
};

const NATIVE_CATEGORY: Record<NativeErrorCode, BundleErrorCategory> = {
  unsupported_target: 'usage',
  invalid_node_version: 'usage',
  invalid_product_name: 'usage',
  invalid_exception: 'invalid_input',
  truncated: 'verification',
  malformed: 'verification',
  unsupported_format: 'verification',
  read_limit: 'verification',
  verification_failed: 'verification',
  read_failed: 'io',
};

/** Every code a `BundleError` can carry. */
export type BundleErrorCode =
  | OwnCodeName
  | NodeDistErrorCode
  | TreeErrorCode
  | NativeErrorCode;

/** Where the code came from; selects the message table. */
export type BundleErrorOrigin = 'bundle' | 'node' | 'tree' | 'native';

export interface BundleErrorDetail {
  readonly stage?: BundleStage;
  /** Static option or schema name, never a value. */
  readonly field?: string;
  /** Bundle-relative paths or package names; never absolute, never content. */
  readonly subjects?: readonly string[];
  readonly failures?: readonly NativeFailure[];
  /** The report of a bundle that was built but not published (budget). */
  readonly report?: BundleReportV1;
}

interface Resolved {
  readonly message: string;
  readonly category: BundleErrorCategory;
}

function resolve(origin: BundleErrorOrigin, code: string): Resolved {
  switch (origin) {
    case 'bundle': {
      const own = code as OwnCodeName;
      return { message: OWN_CODES[own], category: OWN_CATEGORY[own] };
    }
    case 'node': {
      const error = new NodeDistError(code as NodeDistErrorCode);
      return {
        message: NODE_DIST_MESSAGES[code as NodeDistErrorCode],
        category: error.category,
      };
    }
    case 'tree': {
      const error = new BundleTreeError(code as TreeErrorCode);
      return {
        message: TREE_ERROR_MESSAGE_TABLE[code as TreeErrorCode],
        category: error.category,
      };
    }
    case 'native':
      return {
        message: nativeErrorMessage(code as NativeErrorCode),
        category: NATIVE_CATEGORY[code as NativeErrorCode],
      };
  }
}

export class BundleError extends Error {
  readonly code: BundleErrorCode;
  readonly category: BundleErrorCategory;
  readonly exitCode: number;
  readonly origin: BundleErrorOrigin;
  readonly stage?: BundleStage;
  readonly field?: string;
  readonly subjects: readonly string[];
  readonly failures: readonly NativeFailure[];
  readonly report?: BundleReportV1;

  constructor(
    code: BundleErrorCode,
    detail: BundleErrorDetail = {},
    origin: BundleErrorOrigin = 'bundle',
  ) {
    const resolved = resolve(origin, code);
    super(resolved.message);
    this.name = 'BundleError';
    this.code = code;
    this.origin = origin;
    this.category = resolved.category;
    this.exitCode = BUNDLE_EXIT_CODES[resolved.category];
    if (detail.stage !== undefined) this.stage = detail.stage;
    if (detail.field !== undefined) this.field = detail.field;
    this.subjects = Object.freeze(
      (detail.subjects ?? []).slice(0, MAX_ERROR_SUBJECTS),
    );
    this.failures = Object.freeze((detail.failures ?? []).slice(0, 200));
    if (detail.report !== undefined) this.report = detail.report;
  }

  /**
   * Normalise anything thrown into a `BundleError`. A worker error keeps its
   * code, message, field and subjects; anything else becomes `internal` and
   * its text is dropped (it could contain a path or a secret).
   */
  static from(error: unknown, stage?: BundleStage): BundleError {
    if (error instanceof BundleError) {
      if (error.stage !== undefined || stage === undefined) return error;
      return new BundleError(
        error.code,
        {
          stage,
          ...(error.field === undefined ? {} : { field: error.field }),
          subjects: error.subjects,
          failures: error.failures,
          ...(error.report === undefined ? {} : { report: error.report }),
        },
        error.origin,
      );
    }
    const stageDetail = stage === undefined ? {} : { stage };
    if (error instanceof BundleTreeError) {
      return new BundleError(
        error.code,
        {
          ...stageDetail,
          ...(error.field === undefined ? {} : { field: error.field }),
          subjects: error.subjects,
        },
        'tree',
      );
    }
    if (error instanceof NodeDistError) {
      return new BundleError(error.code, stageDetail, 'node');
    }
    if (error instanceof NativeVerificationError) {
      return new BundleError(
        error.code,
        {
          ...stageDetail,
          failures: error.failures,
          subjects: error.failures.map((failure) => failure.path),
        },
        'native',
      );
    }
    return new BundleError('internal', stageDetail);
  }
}

/** The process exit code for any thrown value. */
export function bundleExitCode(error: unknown): number {
  return BundleError.from(error).exitCode;
}

/** The `--json` failure document: `{ ok:false, code, stage, message, ... }`. */
export interface BundleFailureDocument {
  readonly ok: false;
  readonly code: BundleErrorCode;
  readonly category: BundleErrorCategory;
  readonly exitCode: number;
  readonly stage: BundleStage | null;
  readonly message: string;
  readonly field?: string;
  readonly subjects?: readonly string[];
}

export function bundleFailureDocument(error: unknown): BundleFailureDocument {
  const e = BundleError.from(error);
  return {
    ok: false,
    code: e.code,
    category: e.category,
    exitCode: e.exitCode,
    stage: e.stage ?? null,
    message: e.message,
    ...(e.field === undefined ? {} : { field: e.field }),
    ...(e.subjects.length === 0 ? {} : { subjects: e.subjects }),
  };
}
