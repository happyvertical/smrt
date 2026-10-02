/**
 * Framework-free helpers that let a capture component (`CameraCapture`,
 * `SignaturePad`) post a `File` it created through a plain
 * `<form method="POST" enctype="multipart/form-data">`, without the caller
 * wiring a hidden input or intercepting submit.
 *
 * Two strategies, chosen once per page by {@link detectNativeFileFieldStrategy}:
 *
 * - `data-transfer` (preferred): the component renders a hidden
 *   `<input type="file" name>` and fills it with `new DataTransfer()`, so the
 *   browser posts the file exactly like a user-picked one. Needs a constructible
 *   `DataTransfer` whose `files` an input accepts (Chrome 60+, Firefox 62+,
 *   Safari 14.1+).
 * - `formdata-event` (fallback when `DataTransfer` is unavailable): the hidden
 *   input carries no `name`, and a capture-phase `formdata` listener appends the
 *   file to the form's entry list while the browser builds it. The browser fires
 *   `formdata` for native navigation submits as well as `new FormData(form)`, so
 *   the request is the same.
 * - `none`: neither API exists. Nothing is posted for the field; the
 *   component's `onCapture` callback remains the only channel. Components expose
 *   the active strategy as `data-smrt-file-field` for diagnostics.
 *
 * In both posting strategies an uncommitted field posts what an empty native
 * file input posts (an empty, unnamed `application/octet-stream` file), so the
 * server sees one shape regardless of strategy. A reset of the owning form
 * empties the field like a native file input ({@link attachFormResetListener}).
 */

/** How a capture component posts its file in a native form. */
export type NativeFileFieldStrategy =
  | 'data-transfer'
  | 'formdata-event'
  | 'none';

/** Globals the strategy probe reads; injectable for tests. */
export interface NativeFileFieldEnvironment {
  DataTransfer?: unknown;
  FormDataEvent?: unknown;
  File?: unknown;
  /** Creates a detached `<input type="file">` for the assignment probe. */
  createFileInput?: () => HTMLInputElement;
}

type DataTransferConstructor = new () => DataTransfer;

function browserEnvironment(): NativeFileFieldEnvironment {
  const scope = globalThis as Record<string, unknown>;
  return {
    DataTransfer: scope.DataTransfer,
    FormDataEvent: scope.FormDataEvent,
    File: scope.File,
    createFileInput:
      typeof document === 'undefined'
        ? undefined
        : () => {
            const input = document.createElement('input');
            input.type = 'file';
            return input;
          },
  };
}

/**
 * Put `file` into `input` through a fresh `DataTransfer`. Returns `true` only
 * when the input now holds exactly one file. Old engines expose a
 * `DataTransfer` interface whose constructor throws ("Illegal constructor"), or
 * reject the `files` assignment; both report `false`.
 */
export function assignFileWithDataTransfer(
  input: HTMLInputElement,
  file: File,
  DataTransferCtor: unknown = (globalThis as Record<string, unknown>)
    .DataTransfer,
): boolean {
  if (typeof DataTransferCtor !== 'function') return false;
  try {
    const transfer = new (DataTransferCtor as DataTransferConstructor)();
    transfer.items.add(file);
    input.files = transfer.files;
    return input.files?.length === 1;
  } catch {
    return false;
  }
}

/**
 * Empty a file input so it posts the native "no file chosen" entry. Scripts may
 * always set a file input's value to the empty string (only non-empty values
 * throw).
 */
export function clearFileInput(input: HTMLInputElement): void {
  input.value = '';
}

/** Pick the strategy for this page. Safe during SSR (returns `none`). */
export function detectNativeFileFieldStrategy(
  env: NativeFileFieldEnvironment = browserEnvironment(),
): NativeFileFieldStrategy {
  const FileCtor = env.File;
  if (env.createFileInput && typeof FileCtor === 'function') {
    try {
      const probe = new (FileCtor as typeof File)([], 'probe.bin');
      if (
        assignFileWithDataTransfer(
          env.createFileInput(),
          probe,
          env.DataTransfer,
        )
      ) {
        return 'data-transfer';
      }
    } catch {
      // Fall through to the next strategy.
    }
  }
  if (typeof env.FormDataEvent === 'function') return 'formdata-event';
  return 'none';
}

/** The entry a `formdata`-event field contributes, read at submit time. */
export interface FormDataFieldEntry {
  /** The form whose entry list receives the file (the hidden input's `form`). */
  form: HTMLFormElement | null;
  name: string;
  /** The committed file, or `null` to post the native empty-file entry. */
  file: File | null;
}

/** The native "no file chosen" entry: an empty, unnamed octet-stream file. */
export function emptyFileEntry(): File {
  return new File([], '', { type: 'application/octet-stream' });
}

/**
 * Install the `formdata`-event fallback. The listener runs in the capture
 * phase on `target` (normally `document`), so it sees the event whichever form
 * currently owns the field, then appends only for that form. Returns a disposer.
 */
export function attachFormDataFallback(
  target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>,
  readEntry: () => FormDataFieldEntry | null,
): () => void {
  const listener = (event: Event) => {
    const entry = readEntry();
    if (!entry?.form || !entry.name || event.target !== entry.form) return;
    const formData = (event as Event & { formData?: FormData }).formData;
    if (!formData) return;
    const file = entry.file ?? emptyFileEntry();
    formData.append(entry.name, file, file.name);
  };
  target.addEventListener('formdata', listener, true);
  return () => target.removeEventListener('formdata', listener, true);
}

/**
 * Call `onReset` whenever the form returned by `readForm` resets
 * (`form.reset()`, a reset button, or SvelteKit `enhance`'s `update()` after a
 * success). A native file input is emptied by its form's reset; a capture
 * component must empty its own committed state at the same moment, or it keeps
 * showing a file that no longer posts.
 *
 * Like {@link attachFormDataFallback}, the listener runs in the capture phase
 * on `target` (normally `document`) and reads the owning form at dispatch
 * time, so a field moved between forms needs no re-wiring and a page listener
 * that stops propagation cannot hide the reset. `reset` fires before the
 * browser resets the controls, and `onReset` runs even if a later listener
 * cancels it: the component and the posted entry are then both empty, which
 * keeps what is shown equal to what posts. Returns a disposer.
 */
export function attachFormResetListener(
  target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>,
  readForm: () => HTMLFormElement | null | undefined,
  onReset: () => void,
): () => void {
  const listener = (event: Event) => {
    const form = readForm();
    if (form && event.target === form) onReset();
  };
  target.addEventListener('reset', listener, true);
  return () => target.removeEventListener('reset', listener, true);
}

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/** `photo` + `image/png` → `photo.png`; unknown types fall back to `bin`. */
export function fileNameForType(base: string, type: string): string {
  return `${base}.${EXTENSIONS[type] ?? 'bin'}`;
}
