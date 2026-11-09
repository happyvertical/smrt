/**
 * One error type for the bundler's tree handling: containment-safe walking
 * and copying, staging and publish, dependency-graph segmentation, pruning and
 * the secret deny-list, the import-specifier scan, the product configuration
 * and the validated plan.
 *
 * The message is fixed text keyed by `code`. It never interpolates a path, a
 * package name, a field value, a token or a file name, so a caught error is
 * always safe to log or print. Callers branch on `code`; `category` groups the
 * codes for the bundler's exit-code table (`usage` = 2, `invalid_input` = 3,
 * `verification` = 5, `io` = unexpected).
 *
 * Diagnostics that a human needs (which file, which package, which field)
 * travel in the separate `field` and `subjects` properties. `field` is a
 * static schema or option name. `subjects` holds at most
 * `MAX_ERROR_SUBJECTS` bundle-relative paths or package names, never absolute
 * paths and never file content. Neither is part of `message`.
 */

const TREE_ERROR_MESSAGES = {
  // usage
  invalid_option: 'A bundle option is missing or invalid',
  unsupported_target: 'The bundle target is not supported',
  // invalid_input
  invalid_product_config:
    'Product desktop configuration must be a JSON object with exactly the documented fields',
  config_invalid_json: 'Product desktop configuration must be valid JSON',
  config_duplicate_keys:
    'Product desktop configuration must not repeat object keys',
  config_unsupported_version:
    'Product desktop configuration version is not supported',
  config_invalid_field: 'Product desktop configuration has an invalid field',
  missing_app_file: 'A required application file is missing',
  build_outside_app: 'The build directory must be inside the application',
  out_dir_inside_source:
    'The output directory must not be inside or contain the application',
  out_dir_not_empty: 'The output directory exists and is not empty',
  unsafe_install_config:
    'The application configures pnpm to load code during the install (pnpmfile, global-pnpmfile or configDependencies)',
  invalid_package_json: 'An installed package has an invalid package.json',
  unsupported_resolution:
    'A dependency resolves from a link, file, git, workspace or URL source',
  unresolved_dependency: 'A required dependency is not installed',
  // verification
  path_escape: 'A path escapes the root it must stay inside',
  symlink_refused: 'Symbolic links and junctions are not allowed in a bundle',
  special_file:
    'Device files, FIFOs and sockets are not allowed in a bundle tree',
  hardlink_refused: 'Hard-linked files are not allowed in a bundle tree',
  entry_changed: 'A file or directory changed while it was being copied',
  invalid_name: 'A file name is not safe to place in a bundle',
  name_collision:
    'Two names in one directory differ only by case or Unicode form',
  file_too_large: 'A file exceeds the per-file size limit',
  tree_too_large: 'The tree exceeds the total size limit',
  too_many_files: 'The tree exceeds the file count limit',
  tree_too_deep: 'The tree exceeds the directory depth limit',
  path_too_long: 'A path in the tree exceeds the length limit',
  secret_file: 'A secret or credential file is present in the bundle tree',
  secret_content: 'Secret-looking content is present in the bundle tree',
  removed_package_imported:
    'A kept file statically imports a package removed by feature exclusion',
  dynamic_import_unacknowledged:
    'A kept file dynamically imports a package removed by feature exclusion',
  // io
  destination_exists: 'The destination already exists',
  io_failed: 'A file operation failed',
  publish_failed: 'The bundle could not be published to the output directory',
} as const;

export type TreeErrorCode = keyof typeof TREE_ERROR_MESSAGES;

export type TreeErrorCategory =
  | 'usage'
  | 'invalid_input'
  | 'verification'
  | 'io';

const CATEGORY: Record<TreeErrorCode, TreeErrorCategory> = {
  invalid_option: 'usage',
  unsupported_target: 'usage',
  invalid_product_config: 'invalid_input',
  config_invalid_json: 'invalid_input',
  config_duplicate_keys: 'invalid_input',
  config_unsupported_version: 'invalid_input',
  config_invalid_field: 'invalid_input',
  missing_app_file: 'invalid_input',
  build_outside_app: 'invalid_input',
  out_dir_inside_source: 'invalid_input',
  out_dir_not_empty: 'invalid_input',
  unsafe_install_config: 'invalid_input',
  invalid_package_json: 'invalid_input',
  unsupported_resolution: 'invalid_input',
  unresolved_dependency: 'invalid_input',
  path_escape: 'verification',
  symlink_refused: 'verification',
  special_file: 'verification',
  hardlink_refused: 'verification',
  entry_changed: 'verification',
  invalid_name: 'verification',
  name_collision: 'verification',
  file_too_large: 'verification',
  tree_too_large: 'verification',
  too_many_files: 'verification',
  tree_too_deep: 'verification',
  path_too_long: 'verification',
  secret_file: 'verification',
  secret_content: 'verification',
  removed_package_imported: 'verification',
  dynamic_import_unacknowledged: 'verification',
  destination_exists: 'io',
  io_failed: 'io',
  publish_failed: 'io',
};

/** At most this many subjects are attached to one error. */
export const MAX_ERROR_SUBJECTS = 20;

export interface TreeErrorDetail {
  /** Static schema or option name, never a value. */
  readonly field?: string;
  /** Bundle-relative paths or package names; never absolute, never content. */
  readonly subjects?: readonly string[];
}

export class BundleTreeError extends Error {
  readonly code: TreeErrorCode;
  readonly category: TreeErrorCategory;
  readonly field?: string;
  readonly subjects: readonly string[];

  constructor(code: TreeErrorCode, detail: TreeErrorDetail = {}) {
    super(TREE_ERROR_MESSAGES[code]);
    this.name = 'BundleTreeError';
    this.code = code;
    this.category = CATEGORY[code];
    if (detail.field !== undefined) this.field = detail.field;
    this.subjects = Object.freeze(
      (detail.subjects ?? []).slice(0, MAX_ERROR_SUBJECTS),
    );
  }
}

/** The fixed message table, exposed for the value-free-message test. */
export const TREE_ERROR_MESSAGE_TABLE: Readonly<Record<TreeErrorCode, string>> =
  TREE_ERROR_MESSAGES;

/** Map a thrown errno error to a bundler error without keeping its text. */
export function toTreeError(error: unknown): BundleTreeError {
  if (error instanceof BundleTreeError) return error;
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'ELOOP' || code === 'EMLINK') {
    return new BundleTreeError('symlink_refused');
  }
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return new BundleTreeError('entry_changed');
  }
  if (code === 'EEXIST') return new BundleTreeError('destination_exists');
  return new BundleTreeError('io_failed');
}
