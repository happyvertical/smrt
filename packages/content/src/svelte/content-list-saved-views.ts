/**
 * Saved views for ContentList (#2452).
 *
 * A saved view is a named `DataTableSnapshot` an operator can come back to. The
 * payload is persisted outside the application's control — today in
 * `localStorage`, which is writable by anyone with a console — so it is treated
 * exactly like a URL: untrusted on the way back in.
 *
 * Restoration is therefore two gates, in order:
 *
 * 1. `hydrateDataTableSnapshot` (smrt-ui) parses the stored payload
 *    structurally, upgrades version 1/2 into normalized version 3, and throws
 *    on anything it cannot make sense of. It intentionally runs *without*
 *    column ids, so it normalizes shape but does not know which columns this
 *    list publishes.
 * 2. `sanitizeContentListViewState` (`content-list-url-state.ts`) — the same
 *    validator the URL path uses — then holds the hydrated state to the
 *    adapter's published column and operator vocabulary. A stored view can no
 *    more restore a filter on the hidden `description` column, a structural
 *    `select`/`actions` column, or a column that has since been removed than a
 *    crafted link can.
 *
 * A stale view is not an error: a snapshot that references a column which no
 * longer exists restores the valid remainder and reports the drops, so the UI
 * can say what it discarded instead of refusing to open the list.
 *
 * The storage seam is deliberately narrow (`list`/`get`/`save`/`delete`) and
 * asynchronous, so the server-backed store that lands later is a drop-in
 * replacement rather than a signature change. Nothing here knows about a
 * backend, a tenant, or a principal.
 */

import {
  type DataTableSnapshot,
  type DataTableViewState,
  hydrateDataTableSnapshot,
} from '@happyvertical/smrt-ui/data';
import { CONTENT_LIST_SURFACE_ID } from './content-list-controller.js';
import {
  type ContentListStateDrop,
  type ContentListStateValidationOptions,
  sanitizeContentListViewState,
} from './content-list-url-state.js';

export type {
  ContentListStateDrop,
  ContentListStateDropReason,
  ContentListStateDropScope,
} from './content-list-url-state.js';

/**
 * Envelope version for a stored view. Bumped only when the envelope around the
 * snapshot changes; the snapshot carries its own `version` for the state.
 */
export const CONTENT_LIST_SAVED_VIEW_SCHEMA_VERSION = 1;

/** Prefix of the `localStorage` key a saved-view store owns. */
export const CONTENT_LIST_SAVED_VIEW_STORAGE_PREFIX =
  'smrt:content-list:saved-views';

/** A named, restorable content list view. */
export interface ContentListSavedView {
  /** Stable identity. Survives renames and re-saves. */
  id: string;
  /** Operator-facing name. */
  name: string;
  /** Envelope version, currently `CONTENT_LIST_SAVED_VIEW_SCHEMA_VERSION`. */
  schemaVersion: number;
  /** The persisted view payload, normalized on write. */
  snapshot: DataTableSnapshot;
  /** ISO timestamps, for ordering the operator's list. */
  createdAt: string;
  updatedAt: string;
}

/** What a caller supplies to create or update a view. */
export interface ContentListSavedViewInput {
  /** Omit to create; supply to overwrite an existing view in place. */
  id?: string;
  name: string;
  snapshot: DataTableSnapshot;
}

/**
 * The persistence seam. Asynchronous on purpose: the `localStorage` default is
 * synchronous underneath, but a server-backed store cannot be, and changing
 * the signature later would break every consumer.
 */
export interface ContentListSavedViewStore {
  /** Every stored view, most recently updated first. Corrupt entries are skipped. */
  list(): Promise<ContentListSavedView[]>;
  /** One view, or `null` when it is absent or unreadable. */
  get(id: string): Promise<ContentListSavedView | null>;
  /** Creates or replaces a view. Throws `TypeError` on an unusable snapshot. */
  save(input: ContentListSavedViewInput): Promise<ContentListSavedView>;
  /** Removes a view. Resolves `false` when there was nothing to remove. */
  delete(id: string): Promise<boolean>;
}

/** The concrete store also reports whether writes actually persist. */
export interface ContentListLocalSavedViewStore
  extends ContentListSavedViewStore {
  /**
   * False once the store has fallen back to memory — blocked storage, private
   * browsing, or a server render. A UI can warn that views will not survive a
   * reload instead of silently losing them.
   */
  isPersistent(): boolean;
}

/** The slice of the DOM Storage API this module uses. */
export interface ContentListSavedViewStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface ContentListSavedViewStoreOptions {
  /**
   * Storage backend. Defaults to `globalThis.localStorage` when it is reachable
   * and writable; `null` forces the in-memory store.
   */
  storage?: ContentListSavedViewStorage | null;
  /** Distinguishes several mounted lists. Defaults to the adapter's surface id. */
  surfaceId?: string;
  /** Full storage key override; takes precedence over `surfaceId`. */
  storageKey?: string;
  /** Injectable clock, for deterministic tests. */
  now?: () => Date;
  /** Injectable id factory, for deterministic tests. */
  createId?: () => string;
}

/** The outcome of restoring a saved view. */
export interface ContentListSavedViewRestoration {
  /**
   * The validated patch to apply, via `applyContentListViewState`. Selection
   * and expansion are never present: a saved view names a query, not a set of
   * rows someone had checked.
   */
  state: Partial<DataTableViewState>;
  /** Everything the validator refused, for reporting to the operator. */
  dropped: ContentListStateDrop[];
}

function storageKeyFor(options: ContentListSavedViewStoreOptions): string {
  if (options.storageKey) return options.storageKey;
  const surfaceId = options.surfaceId ?? CONTENT_LIST_SURFACE_ID;
  return `${CONTENT_LIST_SAVED_VIEW_STORAGE_PREFIX}:v${CONTENT_LIST_SAVED_VIEW_SCHEMA_VERSION}:${surfaceId}`;
}

/**
 * Resolves the ambient `localStorage`, or `null` when it is unreachable.
 *
 * Reading the property itself throws in some browsers when site data is
 * blocked, and Safari's private mode throws on the first `setItem` rather than
 * on access — so availability is probed with a real write, not assumed.
 */
function resolveAmbientStorage(): ContentListSavedViewStorage | null {
  try {
    const storage = (
      globalThis as { localStorage?: ContentListSavedViewStorage | null }
    ).localStorage;
    if (!storage) return null;
    const probe = `${CONTENT_LIST_SAVED_VIEW_STORAGE_PREFIX}:probe`;
    storage.setItem(probe, '1');
    storage.removeItem(probe);
    return storage;
  } catch {
    return null;
  }
}

function createMemoryStorage(): ContentListSavedViewStorage {
  const entries = new Map<string, string>();
  return {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
    },
    removeItem: (key) => {
      entries.delete(key);
    },
  };
}

function defaultCreateId(): string {
  try {
    const cryptoRef = (globalThis as { crypto?: { randomUUID?: () => string } })
      .crypto;
    if (typeof cryptoRef?.randomUUID === 'function') {
      return cryptoRef.randomUUID();
    }
  } catch {
    // Fall through to the non-cryptographic id below.
  }
  return `view-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

/**
 * Parses one stored entry, or returns `null` when it is unusable.
 *
 * Every stored record goes through `hydrateDataTableSnapshot`, so a hand-edited
 * or truncated entry is discarded on read rather than handed to the controller.
 */
function parseStoredView(value: unknown): ContentListSavedView | null {
  if (!isPlainObject(value)) return null;
  const { id, name, snapshot, createdAt, updatedAt, schemaVersion } = value;
  if (typeof id !== 'string' || id.length === 0) return null;
  if (typeof name !== 'string') return null;
  if (
    schemaVersion !== undefined &&
    schemaVersion !== CONTENT_LIST_SAVED_VIEW_SCHEMA_VERSION
  ) {
    return null;
  }
  let hydrated: DataTableSnapshot;
  try {
    hydrated = hydrateDataTableSnapshot(snapshot);
  } catch {
    return null;
  }
  const created = typeof createdAt === 'string' ? createdAt : '';
  return {
    id,
    name,
    schemaVersion: CONTENT_LIST_SAVED_VIEW_SCHEMA_VERSION,
    snapshot: hydrated,
    createdAt: created,
    updatedAt: typeof updatedAt === 'string' ? updatedAt : created,
  };
}

function sortViews(views: ContentListSavedView[]): ContentListSavedView[] {
  return views.sort((left, right) => {
    if (left.updatedAt === right.updatedAt) {
      return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
    }
    return left.updatedAt < right.updatedAt ? 1 : -1;
  });
}

/**
 * Creates the default saved-view store.
 *
 * Backed by `localStorage` when it is reachable and writable, and by an
 * in-memory map otherwise — a server render, a private window, or a browser
 * with site data blocked degrades to a store that works for the session
 * instead of throwing on the first save.
 */
export function createContentListSavedViewStore(
  options: ContentListSavedViewStoreOptions = {},
): ContentListLocalSavedViewStore {
  const key = storageKeyFor(options);
  const now = options.now ?? (() => new Date());
  const createId = options.createId ?? defaultCreateId;
  const requested =
    options.storage === undefined ? resolveAmbientStorage() : options.storage;
  let storage = requested ?? createMemoryStorage();
  let persistent = requested !== null && requested !== undefined;

  /** Demotes to memory the first time the backing storage misbehaves. */
  function degrade(): void {
    if (!persistent) return;
    persistent = false;
    storage = createMemoryStorage();
  }

  function readAll(): ContentListSavedView[] {
    let raw: string | null;
    try {
      raw = storage.getItem(key);
    } catch {
      degrade();
      return [];
    }
    if (!raw) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
    if (!Array.isArray(parsed)) return [];
    const views: ContentListSavedView[] = [];
    for (const entry of parsed) {
      const view = parseStoredView(entry);
      if (view) views.push(view);
    }
    return views;
  }

  function writeAll(views: readonly ContentListSavedView[]): void {
    try {
      storage.setItem(key, JSON.stringify(views));
    } catch {
      // A quota or private-mode failure must not lose the operator's view:
      // demote to memory and keep the write.
      degrade();
      try {
        storage.setItem(key, JSON.stringify(views));
      } catch {
        // The in-memory fallback cannot fail; nothing further to do.
      }
    }
  }

  return {
    isPersistent: () => persistent,
    async list() {
      return sortViews(readAll());
    },
    async get(id) {
      return readAll().find((view) => view.id === id) ?? null;
    },
    async save(input) {
      if (!input || typeof input.name !== 'string' || !input.name.trim()) {
        throw new TypeError('A content list saved view requires a name');
      }
      // Hydrating on write keeps a malformed payload out of storage entirely,
      // so the only tampered payloads the read path has to survive are ones
      // written around this API.
      const snapshot = hydrateDataTableSnapshot(input.snapshot);
      const timestamp = now().toISOString();
      const views = readAll();
      const existing = input.id
        ? views.find((view) => view.id === input.id)
        : undefined;
      const view: ContentListSavedView = {
        id: existing?.id ?? input.id ?? createId(),
        name: input.name.trim(),
        schemaVersion: CONTENT_LIST_SAVED_VIEW_SCHEMA_VERSION,
        snapshot,
        createdAt: existing?.createdAt || timestamp,
        updatedAt: timestamp,
      };
      writeAll([...views.filter((entry) => entry.id !== view.id), view]);
      return view;
    },
    async delete(id) {
      const views = readAll();
      const next = views.filter((view) => view.id !== id);
      if (next.length === views.length) return false;
      writeAll(next);
      return true;
    },
  };
}

/**
 * An explicitly non-persistent store, for server rendering and for tests that
 * must not touch ambient storage.
 */
export function createContentListMemorySavedViewStore(
  options: Omit<ContentListSavedViewStoreOptions, 'storage'> = {},
): ContentListLocalSavedViewStore {
  // `null` is the documented "force memory" signal, so the store also reports
  // itself as non-persistent rather than claiming durability it does not have.
  return createContentListSavedViewStore({ ...options, storage: null });
}

/**
 * Validates a stored payload and returns the patch to apply.
 *
 * Accepts either a whole `ContentListSavedView` or a bare snapshot. Throws
 * `TypeError` — via `hydrateDataTableSnapshot` — when the payload is not a
 * supported snapshot at all; column-level problems are reported in `dropped`
 * so a stale view still opens.
 */
export function restoreContentListSavedView(
  value: unknown,
  options: ContentListStateValidationOptions = {},
): ContentListSavedViewRestoration {
  const payload =
    isPlainObject(value) && Object.hasOwn(value, 'snapshot')
      ? value.snapshot
      : value;
  const hydrated = hydrateDataTableSnapshot(payload);
  const { state, dropped } = sanitizeContentListViewState(
    hydrated.state,
    options,
  );
  return { state, dropped };
}

/**
 * Builds the input for `store.save` from a controller snapshot.
 *
 * Selection and expansion are stripped before the snapshot is stored: a saved
 * view names a query, and persisting the rows someone had checked would restore
 * a selection into a list whose rows have since changed.
 */
export function toContentListSavedViewInput(
  name: string,
  snapshot: DataTableSnapshot,
  options: { id?: string } = {},
): ContentListSavedViewInput {
  return {
    ...(options.id ? { id: options.id } : {}),
    name,
    snapshot: {
      ...snapshot,
      state: {
        ...snapshot.state,
        selection: { scope: 'explicit', rowIds: [] },
        selectedRowIds: [],
        expandedRowIds: [],
      },
    },
  };
}
