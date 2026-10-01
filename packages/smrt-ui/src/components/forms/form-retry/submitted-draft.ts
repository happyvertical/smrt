/**
 * What a form submitted, kept beside its submission key so a reload can put it
 * back (#3291). Opt-in.
 *
 * The key survives a reload, and `runOnce()` derives the claim from that key
 * AND a digest of what was submitted. A lost response followed by a reload
 * used to keep the key but lose the form: the person re-entered it, the retry
 * carried slightly different content, and a second record was written.
 * Restoring the submitted values — plus any non-field state the page names
 * through its `values` hook — makes the retry byte-identical, so it collapses
 * onto the one record.
 *
 * Tablets and kiosks are shared, so:
 * - `sessionStorage` only (per tab, gone when the tab closes), never
 *   `localStorage`;
 * - a draft is restored only under the key it was submitted with AND for the
 *   owner it was submitted by (the page supplies a stable id for the signed-in
 *   person) — someone else signed in on the same tab gets a fresh form;
 * - it is cleared with the key on a confirmed write, and dropped on a
 *   validation failure (nothing was recorded to retry);
 * - it expires: a draft older than `maxAgeMs` (default one day), or failing
 *   the page's own `fresh()` rule, is never offered as a retry;
 * - password inputs and fields the page names in `exclude` are never written
 *   to storage.
 *
 * A native file input cannot be restored from script. The draft keeps each
 * chosen file's name, type and size (never its bytes) so the helper can
 * report that the file must be chosen again instead of silently submitting
 * without it. Re-choosing the same file reproduces the same content digest —
 * `runOnce()` digests a `File` by name, type and size — so the retry is still
 * the same claim.
 *
 * Every storage access is guarded: a browser that refuses storage simply gets
 * a form that is not restored after a reload.
 *
 * @module
 */

import {
  type FormRetryStorage,
  guardedGet,
  guardedRemove,
  guardedSet,
} from './submission-key.js';

/** A chosen file, as far as a draft can describe it. */
export interface SubmittedFileInfo {
  /** The form field the file was chosen in. */
  field: string;
  /** The file's name. */
  name: string;
  /** The file's MIME type. */
  type: string;
  /** The file's size in bytes. */
  size: number;
}

/** A submit's values, ready to put back into the form. */
export interface SubmittedDraft {
  /** The key the submit carried. */
  token: string;
  /** When the submit was made. */
  savedAt: Date;
  /** Text entries in submission order, as `[name, value]`. */
  fields: ReadonlyArray<readonly [string, string]>;
  /** Files that were chosen and must be chosen again after a reload. */
  files: readonly SubmittedFileInfo[];
  /** What the page's `values.capture()` returned; untrusted until validated. */
  values: unknown;
}

interface StoredDraft {
  v: 1;
  token: string;
  owner: string;
  savedAt: number;
  fields: Array<[string, string]>;
  files: SubmittedFileInfo[];
  values?: unknown;
}

/** The default draft lifetime: one day. */
export const DEFAULT_DRAFT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function isFile(value: unknown): value is File {
  return typeof File !== 'undefined' && value instanceof File;
}

/** Whether `value` is a file the person actually chose (not an empty input). */
export function isChosenFile(value: unknown): boolean {
  return isFile(value) && (value.size > 0 || value.name !== '');
}

/**
 * Reduce `formData` to what a draft can hold: text entries (minus `exclude`)
 * and the identity of each chosen file.
 */
export function describeFormData(
  formData: FormData,
  exclude: ReadonlySet<string>,
): { fields: Array<[string, string]>; files: SubmittedFileInfo[] } {
  const fields: Array<[string, string]> = [];
  const files: SubmittedFileInfo[] = [];
  formData.forEach((value, name) => {
    if (exclude.has(name)) return;
    if (typeof value === 'string') {
      fields.push([name, value]);
    } else if (isChosenFile(value)) {
      files.push({
        field: name,
        name: value.name,
        type: value.type,
        size: value.size,
      });
    }
  });
  return { fields, files };
}

/** Keep what a submit sent, for as long as its key is unresolved. */
export function saveSubmittedDraft(
  storage: FormRetryStorage | null | undefined,
  name: string,
  draft: {
    token: string;
    owner: string;
    savedAt: Date;
    fields: Array<[string, string]>;
    files: SubmittedFileInfo[];
    values?: unknown;
  },
): void {
  const stored: StoredDraft = {
    v: 1,
    token: draft.token,
    owner: draft.owner,
    savedAt: draft.savedAt.getTime(),
    fields: draft.fields,
    files: draft.files,
    ...(draft.values === undefined ? {} : { values: draft.values }),
  };
  let serialized: string;
  try {
    serialized = JSON.stringify(stored);
  } catch {
    // A `values.capture()` result with no JSON form: nothing to restore.
    return;
  }
  guardedSet(storage, name, serialized);
}

/** Drop the stored draft. */
export function clearSubmittedDraft(
  storage: FormRetryStorage | null | undefined,
  name: string,
): void {
  guardedRemove(storage, name);
}

const isString = (value: unknown): value is string => typeof value === 'string';

function parseFields(value: unknown): Array<[string, string]> | null {
  if (!Array.isArray(value)) return null;
  const fields: Array<[string, string]> = [];
  for (const entry of value) {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      !isString(entry[0]) ||
      !isString(entry[1])
    ) {
      return null;
    }
    fields.push([entry[0], entry[1]]);
  }
  return fields;
}

function parseFiles(value: unknown): SubmittedFileInfo[] | null {
  if (!Array.isArray(value)) return null;
  const files: SubmittedFileInfo[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) return null;
    const { field, name, type, size } = entry as Record<string, unknown>;
    if (
      !isString(field) ||
      !isString(name) ||
      !isString(type) ||
      typeof size !== 'number' ||
      !Number.isFinite(size)
    ) {
      return null;
    }
    files.push({ field, name, type, size });
  }
  return files;
}

/**
 * The draft submitted under `token` by `owner` while `fresh(savedAt)` holds,
 * or `null`. Any other stored draft is stale and is removed. A draft is never
 * restored for an empty owner.
 */
export function readSubmittedDraft(
  storage: FormRetryStorage | null | undefined,
  name: string,
  match: {
    token: string;
    owner: string;
    fresh: (savedAt: Date) => boolean;
  },
): SubmittedDraft | null {
  const raw = guardedGet(storage, name);
  if (!raw) return null;
  let stored: Partial<StoredDraft> | null;
  try {
    stored = JSON.parse(raw) as Partial<StoredDraft>;
  } catch {
    stored = null;
  }
  const fields = stored ? parseFields(stored.fields) : null;
  const files = stored ? parseFiles(stored.files) : null;
  const valid =
    stored !== null &&
    typeof stored === 'object' &&
    stored.v === 1 &&
    stored.token === match.token &&
    match.owner !== '' &&
    stored.owner === match.owner &&
    typeof stored.savedAt === 'number' &&
    Number.isFinite(stored.savedAt) &&
    fields !== null &&
    files !== null &&
    match.fresh(new Date(stored.savedAt));
  if (!valid || !stored || !fields || !files) {
    clearSubmittedDraft(storage, name);
    return null;
  }
  return {
    token: match.token,
    savedAt: new Date(stored.savedAt as number),
    fields,
    files,
    values: stored.values,
  };
}

/** A control `applyDraftToForm` may write. */
type RestorableControl =
  | HTMLInputElement
  | HTMLTextAreaElement
  | HTMLSelectElement;

function isRestorableControl(element: Element): element is RestorableControl {
  if (
    !(element instanceof HTMLInputElement) &&
    !(element instanceof HTMLTextAreaElement) &&
    !(element instanceof HTMLSelectElement)
  ) {
    return false;
  }
  if (!element.name || element.disabled) return false;
  if (element instanceof HTMLInputElement) {
    const type = element.type;
    // Hidden fields are page-controlled (render their source state through
    // the `values` hook); buttons are not values; files cannot be set;
    // passwords are never stored.
    if (
      type === 'hidden' ||
      type === 'submit' ||
      type === 'button' ||
      type === 'reset' ||
      type === 'image' ||
      type === 'file' ||
      type === 'password'
    ) {
      return false;
    }
  }
  return true;
}

function notify(control: RestorableControl): void {
  // Svelte's `bind:value` / `bind:checked` / `bind:group` listen for these, so
  // bound state follows the restored DOM value.
  control.dispatchEvent(new Event('input', { bubbles: true }));
  control.dispatchEvent(new Event('change', { bubbles: true }));
}

/**
 * Put a draft's text values back into `form`'s controls, by name and in
 * document order. A checkbox or radio is checked exactly when its `value` was
 * submitted under its name (so one submitted unchecked is unchecked again); a
 * multi-select selects exactly the submitted options; repeated text controls
 * of one name take the submitted values in order. Hidden, file and password
 * inputs, and names in `exclude`, are left alone. Each changed control
 * receives `input` and `change` events so framework bindings pick it up.
 */
export function applyDraftToForm(
  form: HTMLFormElement,
  draft: Pick<SubmittedDraft, 'fields'>,
  exclude: ReadonlySet<string> = new Set(),
): void {
  const byName = new Map<string, string[]>();
  for (const [name, value] of draft.fields) {
    const values = byName.get(name);
    if (values) values.push(value);
    else byName.set(name, [value]);
  }
  const consumed = new Map<string, number>();
  for (const element of Array.from(form.elements)) {
    if (!isRestorableControl(element) || exclude.has(element.name)) continue;
    const values = byName.get(element.name) ?? [];
    if (
      element instanceof HTMLInputElement &&
      (element.type === 'checkbox' || element.type === 'radio')
    ) {
      const checked = values.includes(element.value);
      if (element.checked !== checked) {
        element.checked = checked;
        notify(element);
      }
      continue;
    }
    if (element instanceof HTMLSelectElement && element.multiple) {
      let changed = false;
      for (const option of Array.from(element.options)) {
        const selected = values.includes(option.value);
        if (option.selected !== selected) {
          option.selected = selected;
          changed = true;
        }
      }
      if (changed) notify(element);
      continue;
    }
    // A single-value control takes the next submitted value of its name. One
    // with no submitted value left (it did not take part in the submit) is
    // left as rendered.
    const index = consumed.get(element.name) ?? 0;
    if (index >= values.length) continue;
    consumed.set(element.name, index + 1);
    if (element.value !== values[index]) {
      element.value = values[index];
      notify(element);
    }
  }
}
