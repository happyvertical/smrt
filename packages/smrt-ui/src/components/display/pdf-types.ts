/** One opened PDF. Pages are numbered from 1. */
export interface PdfDocument {
  /** Page count. */
  pages: number;
  /** Draw a page onto `canvas`, `cssWidth` CSS pixels wide (sharp on a dense screen). */
  renderPage(
    page: number,
    canvas: HTMLCanvasElement,
    cssWidth: number,
  ): Promise<{ width: number; height: number }>;
  /** Release the document and any worker. */
  destroy(): Promise<void>;
}

/** Opens PDF bytes. Inject one to use a PDF engine other than pdf.js. */
export type OpenPdf = (bytes: Uint8Array) => Promise<PdfDocument>;

/** Thrown by an opener whose PDF engine is not installed; the viewer shows "unsupported". */
export class PdfEngineUnavailableError extends Error {
  constructor(message = 'The PDF engine (pdfjs-dist) is not available.') {
    super(message);
    this.name = 'PdfEngineUnavailableError';
  }
}
