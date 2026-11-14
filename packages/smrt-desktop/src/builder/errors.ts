/**
 * The one error type, and the closed exit-code table, of `smrt desktop build`.
 *
 * Exit codes are the bundler's (`BUNDLE_EXIT_CODES`): 0 ok, 1 internal, 2
 * usage, 3 invalid input, 4 provenance, 5 verification, 7 child failed, 8 io.
 * Messages are fixed text keyed by `code`; they never carry a path, a version,
 * a product name or a child process's output. What a human needs travels in
 * `field` (a static option name) and `subjects` (bundle-relative paths).
 */

import { BUNDLE_EXIT_CODES } from '../bundler/errors.js';

export const BUILD_STAGES = [
  'inputs',
  'materialize',
  'stage_bundle',
  'configure',
  'tauri_build',
  'collect',
  'smoke',
] as const;

export type BuildStage = (typeof BUILD_STAGES)[number];

type Category = Exclude<keyof typeof BUNDLE_EXIT_CODES, 'ok'>;

const TABLE = {
  invalid_option: ['usage', 'A command-line option is missing or invalid'],
  unsupported_target: [
    'usage',
    'The target is not one this command builds an installer for',
  ],
  smoke_needs_host_target: [
    'usage',
    'The launch smoke needs the target to be the machine running the build',
  ],
  app_invalid: [
    'invalid_input',
    'The application directory or its smrt-desktop.json is missing or invalid',
  ],
  identity_missing: [
    'invalid_input',
    'The product configuration does not carry an owner input the build needs',
  ],
  icons_invalid: [
    'invalid_input',
    'A configured icon is missing, not a regular file, or the icon list is unusable',
  ],
  bundle_invalid: [
    'invalid_input',
    'The runtime bundle is missing, incomplete or not made by smrt desktop bundle',
  ],
  bundle_mismatch: [
    'verification',
    'The runtime bundle does not match the application, the target or its digest list',
  ],
  wrapper_missing: [
    'invalid_input',
    'The packaged wrapper is missing or incomplete in the installed package',
  ],
  wrapper_version_drift: [
    'verification',
    'The wrapper version differs from the @happyvertical/smrt-desktop package version',
  ],
  tauri_version_mismatch: [
    'verification',
    'The installed Tauri CLI is not the pinned version',
  ],
  output_exists: [
    'invalid_input',
    'The output directory exists and is not empty',
  ],
  tauri_failed: ['child_failed', 'tauri build failed'],
  smoke_failed: ['child_failed', 'The launch smoke failed'],
  no_installer: [
    'verification',
    'tauri build produced no installer of the expected kind',
  ],
  io_failed: ['io', 'A file operation failed'],
  internal: ['internal', 'An unexpected error occurred'],
} as const satisfies Record<string, readonly [Category, string]>;

export type BuildErrorCode = keyof typeof TABLE;

export interface BuildErrorDetail {
  readonly stage?: BuildStage;
  readonly field?: string;
  readonly subjects?: readonly string[];
}

const MAX_SUBJECTS = 20;

export class BuildError extends Error {
  readonly code: BuildErrorCode;
  readonly category: Category;
  readonly exitCode: number;
  readonly stage?: BuildStage;
  readonly field?: string;
  readonly subjects: readonly string[];

  constructor(code: BuildErrorCode, detail: BuildErrorDetail = {}) {
    const [category, message] = TABLE[code];
    super(message);
    this.name = 'BuildError';
    this.code = code;
    this.category = category;
    this.exitCode = BUNDLE_EXIT_CODES[category];
    if (detail.stage !== undefined) this.stage = detail.stage;
    if (detail.field !== undefined) this.field = detail.field;
    this.subjects = (detail.subjects ?? []).slice(0, MAX_SUBJECTS);
  }

  /** Anything that is not already a `BuildError` becomes `internal`. */
  static from(error: unknown, stage?: BuildStage): BuildError {
    if (error instanceof BuildError) return error;
    return new BuildError('internal', stage === undefined ? {} : { stage });
  }
}

/** Every code with its category and message (for the README table test). */
export const BUILD_ERROR_CODES: readonly BuildErrorCode[] = Object.freeze(
  Object.keys(TABLE) as BuildErrorCode[],
);
