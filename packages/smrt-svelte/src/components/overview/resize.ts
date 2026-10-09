/**
 * Pure span math for resizing a widget by dragging its inline-end edge
 * (#3727). The grid is a flow of equal columns; a span is a whole number of
 * them, so a drag snaps to the nearest column boundary.
 */

export interface SpanFromPointerInput {
  /** Pointer position along the inline axis (client coordinates). */
  pointer: number;
  /** The tile's inline-start edge (left in LTR, right in RTL). */
  start: number;
  rtl: boolean;
  /** Width of the whole grid. */
  gridWidth: number;
  /** Columns currently drawn (1, 2 or 4 depending on the container). */
  columns: number;
  /** Gap between columns, in the same unit. */
  gap: number;
  min: number;
  max: number;
}

/** The span a tile would have if its end edge were at `pointer`. */
export function spanFromPointer(input: SpanFromPointerInput): number {
  const { pointer, start, rtl, gridWidth, gap, min, max } = input;
  const columns = Math.max(1, Math.floor(input.columns));
  const width = rtl ? start - pointer : pointer - start;
  const column = (gridWidth - gap * (columns - 1)) / columns;
  const raw =
    column + gap > 0 ? Math.round((width + gap) / (column + gap)) : min;
  return Math.max(min, Math.min(max, columns, raw));
}

/** The next span for an arrow key, or `null` for a key that does nothing. */
export function spanFromKey(
  key: string,
  span: number,
  min: number,
  max: number,
  rtl: boolean,
): number | null {
  let next: number;
  switch (key) {
    case 'ArrowRight':
      next = span + (rtl ? -1 : 1);
      break;
    case 'ArrowLeft':
      next = span + (rtl ? 1 : -1);
      break;
    case 'ArrowUp':
      next = span + 1;
      break;
    case 'ArrowDown':
      next = span - 1;
      break;
    case 'Home':
      next = min;
      break;
    case 'End':
      next = max;
      break;
    default:
      return null;
  }
  return Math.max(min, Math.min(max, next));
}
