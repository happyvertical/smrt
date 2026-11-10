/**
 * The default PDF opener for `DocumentViewer`, on pdf.js (smrt#3463).
 *
 * `pdfjs-dist` is an OPTIONAL peer dependency: this module is only loaded
 * (dynamically, by the viewer) when a PDF is shown without an injected
 * `openPdf`, and it imports pdf.js dynamically too. The legacy build is used
 * because it supports the widest range of WebViews. pdf.js never fetches
 * anything itself: the bytes come from the caller.
 *
 * The default imports use a variable specifier (`importOptional`), so a
 * consumer's bundler never resolves them: an app WITHOUT pdfjs-dist still
 * builds, and the missing engine surfaces at runtime. The cost is that pdf.js is
 * not bundled by default. An app that wants it bundled passes `loadLibrary`
 * (a function holding its own literal `import('pdfjs-dist/legacy/build/pdf.mjs')`)
 * and `workerSrc`.
 *
 * Worker: pass `workerSrc` (for Vite,
 * `import url from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'`) to render
 * off the main thread. Without it the worker module is imported and run on the
 * main thread (pdf.js's "fake worker"), which needs no bundler URL handling
 * and works under svelte-package and any bundler, at the cost of a busier UI
 * thread while a page draws.
 */
import { importOptional } from '../../utils/import-optional.js';
import { MAX_CANVAS_PIXELS, renderScale } from './document-viewer-logic.js';
import { type OpenPdf, PdfEngineUnavailableError } from './pdf-types.js';

export { MAX_CANVAS_PIXELS, renderScale };

/** The slice of pdf.js this opener uses, so consumers need no pdf.js types. */
export interface PdfJsLike {
  GlobalWorkerOptions: { workerSrc: string };
  getDocument(source: { data: Uint8Array; enableXfa?: boolean }): {
    promise: Promise<PdfJsDocumentLike>;
    destroy(): Promise<void>;
  };
}

interface PdfJsDocumentLike {
  numPages: number;
  getPage(page: number): Promise<{
    getViewport(options: { scale: number }): { width: number; height: number };
    render(options: { canvas: HTMLCanvasElement; viewport: unknown }): {
      promise: Promise<void>;
      cancel(): void;
    };
  }>;
}

/** Options for `createPdfJsOpener`. */
export interface PdfJsOpenerOptions {
  /** URL of `pdf.worker.min.mjs`; omitted, the worker runs on the main thread. */
  workerSrc?: string | URL;
  /** Supplies pdf.js; defaults to a dynamic `import('pdfjs-dist/legacy/build/pdf.mjs')`. */
  loadLibrary?: () => Promise<PdfJsLike>;
}

async function importPdfJs(): Promise<PdfJsLike> {
  return importOptional<PdfJsLike>('pdfjs-dist/legacy/build/pdf.mjs');
}

async function useMainThreadWorker(): Promise<void> {
  const target = globalThis as { pdfjsWorker?: unknown };
  if (target.pdfjsWorker) return;
  target.pdfjsWorker = await importOptional(
    'pdfjs-dist/legacy/build/pdf.worker.min.mjs',
  );
}

/** Build an `OpenPdf` backed by pdf.js; the library loads on first use. */
export function createPdfJsOpener(options: PdfJsOpenerOptions = {}): OpenPdf {
  let library: Promise<PdfJsLike> | null = null;

  function load(): Promise<PdfJsLike> {
    library ??= (async () => {
      try {
        const lib = await (options.loadLibrary ?? importPdfJs)();
        if (options.workerSrc !== undefined) {
          lib.GlobalWorkerOptions.workerSrc = String(options.workerSrc);
        } else if (!lib.GlobalWorkerOptions.workerSrc) {
          await useMainThreadWorker();
        }
        return lib;
      } catch (error) {
        // pdf.js is an optional peer: not installed (or not loadable) means
        // the viewer cannot show PDFs, not that this file is broken.
        throw new PdfEngineUnavailableError(
          error instanceof Error ? error.message : undefined,
        );
      }
    })();
    // A failed load (pdf.js not installed) may be retried.
    library.catch(() => {
      library = null;
    });
    return library;
  }

  return async (bytes) => {
    const lib = await load();
    // pdf.js takes ownership of the buffer it is given; hand it a copy.
    const loading = lib.getDocument({ data: bytes.slice(), enableXfa: false });
    const document = await loading.promise;
    // One page is drawn at a time: a newer request cancels the one drawing,
    // and a request superseded while awaiting getPage never draws.
    let drawing: { cancel(): void } | null = null;
    let generation = 0;
    const stopDrawing = () => {
      drawing?.cancel();
      drawing = null;
    };
    return {
      pages: document.numPages,
      async renderPage(page, canvas, cssWidth) {
        const ticket = ++generation;
        stopDrawing();
        const proxy = await document.getPage(page);
        if (ticket !== generation) return { width: 0, height: 0 };
        stopDrawing();
        const base = proxy.getViewport({ scale: 1 });
        const ratio =
          typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
        const viewport = proxy.getViewport({
          scale: renderScale(
            base.width,
            base.height,
            Math.max(cssWidth, 1),
            ratio,
          ),
        });
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        canvas.style.width = `${Math.round(cssWidth)}px`;
        canvas.style.height = `${Math.round((cssWidth * base.height) / base.width)}px`;
        const task = proxy.render({ canvas, viewport });
        drawing = task;
        try {
          await task.promise;
        } catch (error) {
          // Superseded by a newer page or zoom: that one draws instead.
          if (
            (error as { name?: string } | null)?.name ===
            'RenderingCancelledException'
          ) {
            return { width: base.width, height: base.height };
          }
          throw error;
        } finally {
          if (drawing === task) drawing = null;
        }
        return { width: base.width, height: base.height };
      },
      async destroy() {
        generation += 1;
        drawing?.cancel();
        await loading.destroy();
      },
    };
  };
}
