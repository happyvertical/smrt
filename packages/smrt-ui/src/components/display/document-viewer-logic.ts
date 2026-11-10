/**
 * Pure helpers for `DocumentViewer` (smrt#3463): zoom stepping, pinch
 * clamping, page bounds, and the canvas render scale. Svelte-free.
 */

/** The zoom steps, as multiples of "Fit" (the sheet's width). */
export const ZOOM_STEPS: readonly number[] = [1, 1.5, 2, 3, 4, 5];

/** The smallest and largest zoom. */
export const MIN_ZOOM: number = ZOOM_STEPS[0] as number;
export const MAX_ZOOM: number = ZOOM_STEPS[ZOOM_STEPS.length - 1] as number;

/** The biggest canvas drawn, in device pixels; zooming past it enlarges on screen instead. */
export const MAX_CANVAS_PIXELS = 4096 * 4096;

const EPSILON = 0.01;

/**
 * The next zoom step above (`direction` 1) or below (-1) `zoom`. A zoom between
 * steps (left by a pinch) moves to the nearest step in that direction; at an
 * end it stays put.
 */
export function stepZoom(zoom: number, direction: 1 | -1): number {
  if (direction > 0) {
    return ZOOM_STEPS.find((step) => step > zoom + EPSILON) ?? MAX_ZOOM;
  }
  return (
    [...ZOOM_STEPS].reverse().find((step) => step < zoom - EPSILON) ?? MIN_ZOOM
  );
}

/** Clamp a zoom to the supported range. */
export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/** The live pinch scale, bounded so `zoom * scale` stays within the zoom range. */
export function clampPinchScale(zoom: number, scale: number): number {
  return Math.min(MAX_ZOOM / zoom, Math.max(MIN_ZOOM / zoom, scale));
}

/** The zoom a finished pinch commits: `zoom * scale`, to 0.1, within range. */
export function commitPinchZoom(zoom: number, scale: number): number {
  return clampZoom(Math.round(zoom * scale * 10) / 10);
}

/** `page + delta` kept within `1..pages`. */
export function clampPage(page: number, delta: number, pages: number): number {
  return Math.min(Math.max(1, pages), Math.max(1, page + delta));
}

/**
 * The pdf.js scale that draws a page `cssWidth` wide at `ratio` device pixels
 * per CSS pixel, reduced when the canvas would exceed `MAX_CANVAS_PIXELS`.
 */
export function renderScale(
  pageWidth: number,
  pageHeight: number,
  cssWidth: number,
  ratio: number,
  maxPixels: number = MAX_CANVAS_PIXELS,
): number {
  const scale = (cssWidth / pageWidth) * ratio;
  const pixels = pageWidth * scale * pageHeight * scale;
  return pixels > maxPixels ? scale * Math.sqrt(maxPixels / pixels) : scale;
}

/** Whether a MIME type is a PDF. */
export function isPdfType(mimeType: string): boolean {
  return mimeType.split(';')[0]?.trim().toLowerCase() === 'application/pdf';
}

/** Whether a MIME type is an image the browser can show. */
export function isImageType(mimeType: string): boolean {
  return mimeType.trim().toLowerCase().startsWith('image/');
}
