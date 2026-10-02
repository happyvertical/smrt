/**
 * Pure input logic for `SignaturePad.svelte`: the pointer-type gate and the
 * pointer-to-canvas coordinate mapping. Free of DOM and settings dependencies
 * so both are testable without a browser. The component takes `stylusOnly` as a
 * prop the caller resolves (from a tenant setting, a device profile, …) and
 * never decides it itself.
 *
 * Ported from teamworks-os `signature-pad-logic.ts`, smrt#3290.
 */

/** `PointerEvent.pointerType`; browsers may report values beyond the three known ones. */
export type SignaturePointerType = 'pen' | 'touch' | 'mouse' | (string & {});

/**
 * Paper and ink colours for the signature bitmap. A signature is document
 * content, not chrome: it stays dark ink on white paper in every theme and
 * colour scheme, so the exported PNG reads the same wherever it is shown.
 */
export const SIGNATURE_PAPER_COLOR = '#ffffff';
export const SIGNATURE_INK_COLOR = '#111111';

/**
 * Whether a pointer of `pointerType` may draw a stroke.
 *
 * With `stylusOnly`, only `pen` is accepted: finger and mouse input are
 * ignored outright, since nothing at the pointer-event level can tell a
 * gloved finger from a stylus. Otherwise pen, touch and mouse are accepted.
 * Unknown pointer types are rejected in both modes.
 */
export function isAcceptedPointerType(
  pointerType: SignaturePointerType,
  stylusOnly: boolean,
): boolean {
  if (stylusOnly) return pointerType === 'pen';
  return (
    pointerType === 'pen' || pointerType === 'touch' || pointerType === 'mouse'
  );
}

/** The subset of `DOMRect` the coordinate mapping needs. */
export interface CanvasDisplayRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Maps viewport `clientX`/`clientY` (CSS pixels) to the canvas's backing-pixel
 * space.
 *
 * The canvas has a fixed backing resolution but is displayed at `width: 100%`,
 * so the raw `clientX - rect.left` offset is only right when the displayed size
 * happens to equal the backing size; anywhere else the ink drifts from the
 * stylus and clips near the edges. Scaling by `backing / displayed` keeps them
 * aligned. A zero-size rect (not laid out yet) falls back to 1:1 instead of
 * dividing by zero.
 */
export function mapPointerToCanvasPoint(
  clientX: number,
  clientY: number,
  rect: CanvasDisplayRect,
  canvasWidth: number,
  canvasHeight: number,
): { x: number; y: number } {
  const scaleX = rect.width > 0 ? canvasWidth / rect.width : 1;
  const scaleY = rect.height > 0 ? canvasHeight / rect.height : 1;
  return {
    x: (clientX - rect.left) * scaleX,
    y: (clientY - rect.top) * scaleY,
  };
}
