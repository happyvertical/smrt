/**
 * jsdom stand-ins for the browser APIs `CameraCapture` and `SignaturePad` use
 * (smrt#3290). jsdom has no `DataTransfer`, no canvas, no media playback and
 * never fires the `formdata` event, so each is supplied here, as close to the
 * browser contract as the tests need.
 */
import { type Mock, vi } from 'vitest';

type ImplHolder = Record<symbol, unknown>;

function implOf<T>(wrapper: object, guard: (value: unknown) => boolean): T {
  const key = Object.getOwnPropertySymbols(wrapper).find((symbol) =>
    guard((wrapper as ImplHolder)[symbol]),
  );
  if (!key) throw new Error('jsdom wrapper has no implementation symbol');
  return (wrapper as ImplHolder)[key] as T;
}

/**
 * A real jsdom `FileList` holding `files`. jsdom's `input.files` setter only
 * accepts genuine `FileList` instances and exposes no constructor, so the list
 * is taken from a detached file input and filled through its implementation
 * object. This keeps `new FormData(form)` reading the files exactly as a
 * browser would after `input.files = dataTransfer.files`.
 */
export function createFileList(files: File[]): FileList {
  const input = document.createElement('input');
  input.type = 'file';
  const list = input.files as FileList;
  const impl = implOf<unknown[]>(list, Array.isArray);
  for (const file of files) {
    impl.push(
      implOf(file, (value) => typeof value === 'object' && value !== null),
    );
  }
  return list;
}

/** Browser-shaped `DataTransfer` for jsdom: `items.add()` plus a real `files`. */
export class TestDataTransfer {
  readonly #files: File[] = [];
  readonly items = {
    add: (file: File) => {
      this.#files.push(file);
      return null;
    },
  };
  get files(): FileList {
    return createFileList(this.#files);
  }
}

/** Marker constructor: its presence is what feature detection reads. */
export class TestFormDataEvent {}

/** Select the posting strategy the component will detect on mount. */
export function useFileFieldStrategy(
  strategy: 'data-transfer' | 'formdata-event' | 'none',
): void {
  vi.stubGlobal(
    'DataTransfer',
    strategy === 'data-transfer' ? TestDataTransfer : undefined,
  );
  vi.stubGlobal(
    'FormDataEvent',
    strategy === 'formdata-event' ? TestFormDataEvent : undefined,
  );
}

/**
 * The entry list a native submit of `form` would send: what `new FormData`
 * builds, plus the browser's `formdata` event (which jsdom never fires) so the
 * fallback strategy's listener can contribute.
 */
export function submittedEntries(form: HTMLFormElement): FormData {
  const formData = new FormData(form);
  const event = new Event('formdata');
  Object.defineProperty(event, 'formData', { value: formData });
  form.dispatchEvent(event);
  return formData;
}

/**
 * Make `new FormData(form)` fire `formdata` on the form, as browsers do while
 * constructing the entry list (jsdom does not), so code that snapshots a form
 * — SvelteKit's `enhance`, form-retry's draft comparison — sees files the
 * `formdata`-event strategy appends. Do not combine with
 * {@link submittedEntries}, which dispatches the event itself.
 */
export function useBrowserFormData(): void {
  const NativeFormData = FormData;
  class BrowserFormData extends NativeFormData {
    constructor(form?: HTMLFormElement, submitter?: HTMLElement | null) {
      super(form, submitter);
      if (!form) return;
      const event = new Event('formdata');
      Object.defineProperty(event, 'formData', { value: this });
      form.dispatchEvent(event);
    }
  }
  vi.stubGlobal('FormData', BrowserFormData);
}

/** Canvas 2D, `toBlob` and `toDataURL` stubs. Returns the fake context. */
/** The canvas 2D surface the capture components touch. */
export interface FakeCanvasContext {
  drawImage: Mock;
  fillRect: Mock;
  beginPath: Mock;
  moveTo: Mock;
  lineTo: Mock;
  stroke: Mock;
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  lineCap: string;
  lineJoin: string;
}

export function stubCanvas(): FakeCanvasContext {
  const context: FakeCanvasContext = {
    drawImage: vi.fn(),
    fillRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () => context as unknown as CanvasRenderingContext2D,
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(
    (type = 'image/png') => `data:${type};base64,AAAA`,
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(
    (callback, type = 'image/png') => {
      callback(new Blob(['pixels'], { type }));
    },
  );
  return context;
}

/** `play()` is unimplemented in jsdom; resolve it like an allowed autoplay. */
export function stubMediaPlayback(): void {
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
}

export interface FakeTrack {
  stop: Mock;
}

export function fakeStream(tracks: FakeTrack[] = [{ stop: vi.fn() }]) {
  return { getTracks: () => tracks } as unknown as MediaStream;
}

/** Install `navigator.mediaDevices` (or remove it with `undefined`). */
export function installMediaDevices(
  mediaDevices: { getUserMedia: (...args: unknown[]) => unknown } | undefined,
): void {
  Object.defineProperty(window.navigator, 'mediaDevices', {
    configurable: true,
    value: mediaDevices,
  });
}

export function removeMediaDevices(): void {
  delete (window.navigator as { mediaDevices?: unknown }).mediaDevices;
}
