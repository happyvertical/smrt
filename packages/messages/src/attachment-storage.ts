/**
 * Attachment storage root.
 *
 * A stored `Attachment.filePath` is a path relative to one configured root
 * directory. The host calls {@link configureAttachmentStorage} once at startup;
 * without it stored files are never read (fail closed). Writes are checked
 * lexically ({@link normalizeAttachmentPath}); reads also resolve symlinks and
 * refuse anything whose real path leaves the root's real path.
 */

import {
  readAttachmentFileUnderRoot,
  resolveAttachmentStorageRoot,
} from './host.js';

export interface AttachmentStorageConfig {
  /** Absolute directory that holds every stored attachment file. */
  root: string;
}

/** Thrown for a refused attachment path or an unconfigured storage root. */
export class AttachmentStorageError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'AttachmentStorageError';
    this.status = status;
  }
}

/** By name, so a copy of this module loaded twice still recognises it. */
export function isAttachmentStorageError(
  error: unknown,
): error is AttachmentStorageError {
  return error instanceof Error && error.name === 'AttachmentStorageError';
}

interface AttachmentStorageState {
  /** Real path of the configured root. */
  root: string | null;
}

const STATE_KEY = Symbol.for('@happyvertical/smrt-messages:attachment-storage');

// Shared through globalThis, like the mail access state: a module loaded twice
// by a bundler must not split the configuration.
function state(): AttachmentStorageState {
  const holder = globalThis as Record<symbol, unknown>;
  let current = holder[STATE_KEY] as AttachmentStorageState | undefined;
  if (!current) {
    current = { root: null };
    holder[STATE_KEY] = current;
  }
  return current;
}

/**
 * Set the directory stored attachment files are read from. Call once at
 * startup. The root must be an absolute path to an existing directory; its
 * real path is resolved here, once. Calling again replaces it.
 */
export function configureAttachmentStorage(
  config: AttachmentStorageConfig,
): void {
  try {
    state().root = resolveAttachmentStorageRoot(config?.root);
  } catch (error) {
    throw new AttachmentStorageError(
      `configureAttachmentStorage: ${error instanceof Error ? error.message : 'invalid root'}.`,
    );
  }
}

/** Remove the configuration (tests). Stored files are then unreadable. */
export function resetAttachmentStorage(): void {
  state().root = null;
}

function refuse(reason: string): never {
  throw new AttachmentStorageError(`Attachment filePath refused: ${reason}.`);
}

/**
 * The normalised relative form of a stored attachment path, or an
 * {@link AttachmentStorageError}. Absolute paths, `..` segments, backslashes,
 * control characters (NUL included) and percent-encoded dots or separators
 * are refused; empty and `.` segments are dropped. Plain string handling: the
 * package root must stay browser-reachable.
 */
export function normalizeAttachmentPath(filePath: unknown): string {
  if (typeof filePath !== 'string') refuse('not a string');
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing them is the point
  if (/[\u0000-\u001f\u007f]/.test(filePath)) refuse('control character');
  if (filePath.includes('\\')) refuse('backslash');
  if (/%(?:25)*(?:2e|2f|5c)/i.test(filePath)) {
    refuse('percent-encoded dot or separator');
  }
  if (filePath.startsWith('/') || /^[A-Za-z]:/.test(filePath)) {
    refuse('absolute path');
  }
  const segments: string[] = [];
  for (const segment of filePath.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') refuse('parent directory segment');
    segments.push(segment);
  }
  if (!segments.length) refuse('empty path');
  return segments.join('/');
}

/**
 * Read a stored attachment file: `null` when it is missing or unreadable, an
 * {@link AttachmentStorageError} when no root is configured or the path (or
 * where a symlink leads) is outside the root.
 */
export async function readStoredAttachmentFile(
  filePath: string,
): Promise<Buffer | null> {
  const root = state().root;
  if (!root) {
    throw new AttachmentStorageError(
      'Attachment storage is not configured: call configureAttachmentStorage({ root }) at startup to read stored attachment files.',
      500,
    );
  }
  const segments = normalizeAttachmentPath(filePath).split('/');
  const read = await readAttachmentFileUnderRoot(root, segments);
  if (read.status === 'outside') {
    throw new AttachmentStorageError(
      'Attachment filePath refused: it resolves outside the attachment storage root.',
      403,
    );
  }
  return read.status === 'ok' ? read.data : null;
}
