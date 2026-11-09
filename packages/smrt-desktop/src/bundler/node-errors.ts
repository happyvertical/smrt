/**
 * One error type for the Node sidecar binary pipeline (pins, download,
 * archive extraction, install arguments).
 *
 * The message is fixed text keyed by `code`. It never interpolates a path, a
 * URL, a version, a header, a hash or an archive member name, so a caught error
 * is always safe to log or print. Callers branch on `code`; `category` groups
 * codes for the bundler's exit-code table (`usage`, `provenance`,
 * `verification`, `io`).
 */

const NODE_DIST_ERROR_MESSAGES = {
  // usage
  invalid_node_version: 'Node version must be a plain major.minor.patch number',
  unsupported_target: 'Target has no known Node distribution file',
  unpinned_version: 'Node version is not pinned; refusing to download it',
  unpinned_file: 'Node distribution file is not pinned for this version',
  invalid_path: 'Node cache and output paths must be absolute',
  invalid_environment:
    'Child process environment entry is not allowed or not well formed',
  invalid_install_plan: 'Install plan has a value outside the supported set',
  install_unsafe:
    'Install command would allow lifecycle scripts or is not the exact pinned form',
  insecure_url: 'Node download location must be a plain https URL',
  tls_verification_disabled:
    'TLS certificate verification is disabled in the environment; refusing to download Node',
  offline_cache_miss:
    'Node is not in the cache and downloads are disabled (offline)',
  // provenance
  fetch_failed: 'Downloading the Node distribution failed',
  redirect_refused: 'The Node download host answered with a redirect',
  http_status: 'The Node download host did not answer 200',
  download_too_large: 'The Node download exceeds the size limit',
  checksum_mismatch:
    'The Node distribution file does not match its committed SHA-256 pin',
  cache_tampered:
    'A cached Node distribution file does not match its committed SHA-256 pin and was removed',
  node_pin_unverified:
    'The committed Node pin is not verified against the Node.js release signature (gpg); a release or signing bundle needs a verified pin',
  // verification (archive content)
  archive_invalid: 'The Node archive is not a valid gzip-compressed tar file',
  archive_truncated: 'The Node archive ends before the expected content',
  archive_too_large: 'The Node archive expands beyond the size limit',
  member_missing: 'The Node archive does not contain the expected file',
  member_ambiguous:
    'The Node archive contains the expected file more than once',
  member_unsafe: 'The expected Node archive entry is not a regular file',
  member_too_large: 'A Node archive entry exceeds the size limit',
  binary_rejected: 'The Node executable was rejected by the target check',
  // io
  untrusted_file: 'A Node cache or archive file failed the trust checks',
  destination_exists: 'The Node output path already exists',
  io_failed: 'A file operation for the Node binary failed',
} as const;

export type NodeDistErrorCode = keyof typeof NODE_DIST_ERROR_MESSAGES;

export type NodeDistErrorCategory =
  | 'usage'
  | 'provenance'
  | 'verification'
  | 'io';

const CATEGORY: Record<NodeDistErrorCode, NodeDistErrorCategory> = {
  invalid_node_version: 'usage',
  unsupported_target: 'usage',
  unpinned_version: 'usage',
  unpinned_file: 'usage',
  invalid_path: 'usage',
  invalid_environment: 'usage',
  invalid_install_plan: 'usage',
  install_unsafe: 'usage',
  insecure_url: 'usage',
  tls_verification_disabled: 'provenance',
  offline_cache_miss: 'usage',
  fetch_failed: 'provenance',
  redirect_refused: 'provenance',
  http_status: 'provenance',
  download_too_large: 'provenance',
  checksum_mismatch: 'provenance',
  cache_tampered: 'provenance',
  node_pin_unverified: 'provenance',
  archive_invalid: 'verification',
  archive_truncated: 'verification',
  archive_too_large: 'verification',
  member_missing: 'verification',
  member_ambiguous: 'verification',
  member_unsafe: 'verification',
  member_too_large: 'verification',
  binary_rejected: 'verification',
  untrusted_file: 'io',
  destination_exists: 'io',
  io_failed: 'io',
};

export class NodeDistError extends Error {
  readonly code: NodeDistErrorCode;
  readonly category: NodeDistErrorCategory;

  constructor(code: NodeDistErrorCode) {
    super(NODE_DIST_ERROR_MESSAGES[code]);
    this.name = 'NodeDistError';
    this.code = code;
    this.category = CATEGORY[code];
  }
}

/** The fixed message table, exposed for the value-free-message test. */
export const NODE_DIST_MESSAGES: Readonly<Record<NodeDistErrorCode, string>> =
  NODE_DIST_ERROR_MESSAGES;
