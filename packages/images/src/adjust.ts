/**
 * Local picture adjustments: brightness, contrast, colour, black-and-white,
 * rotate, flip, region crop and resize. Rendering uses sharp on the server and
 * lives in `./adjust-render` (exported from the Node-only
 * `@happyvertical/smrt-images/node` subpath), so this module stays
 * browser-safe.
 *
 * These are the cheap, instant edits (no GPU, no model): an app offers a few
 * versions of one picture ("brighter by 10, 20 or 30%") and saves the one the
 * person picks. {@link imageAdjustVariants} builds those versions for one
 * {@link ImageAdjustOperation}; {@link encodeImageAdjustments} turns an
 * adjustment into a short, URL-safe string (`b1.2,g,r90`) so a preview route
 * can render it; `applyImageAdjustments` renders it.
 *
 * Everything in this module is pure, so an app can build and check
 * adjustments in a browser without loading sharp.
 */

/** Ways to change a picture locally. */
export type ImageAdjustOperation =
  | 'brighter'
  | 'darker'
  | 'more-contrast'
  | 'less-contrast'
  | 'more-color'
  | 'less-color'
  | 'black-and-white'
  | 'rotate'
  | 'flip'
  | 'zoom'
  | 'resize';

/** Where a zoom (region crop) centres. */
export type ImageFocus =
  | 'center'
  | 'top'
  | 'bottom'
  | 'left'
  | 'right'
  | 'top-left'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-right';

/** A part of the picture, as fractions (0–1) of its width and height. */
export interface ImageRegion {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * One set of adjustments. Every field is optional; a missing field leaves
 * the picture as it is. Applied in this order: rotate, flip, region, colour
 * (brightness, saturation), contrast, black-and-white, resize.
 */
export interface ImageAdjustments {
  /** Brightness multiplier (1 = unchanged, 1.2 = 20% brighter), 0.2–3. */
  brightness?: number;
  /** Contrast multiplier around mid-grey (1 = unchanged), 0.2–3. */
  contrast?: number;
  /** Colour multiplier (1 = unchanged, 0 = no colour), 0–3. */
  saturation?: number;
  /** Black and white. */
  grayscale?: boolean;
  /** Clockwise quarter turns, in degrees. */
  rotate?: 0 | 90 | 180 | 270;
  /** Mirror left to right. */
  flipHorizontal?: boolean;
  /** Upside down (mirror top to bottom). */
  flipVertical?: boolean;
  /** Keep only this part (after rotating and flipping). */
  region?: ImageRegion;
  /** Fit inside this width (keeps the shape; never enlarges). */
  maxWidth?: number;
  /** Fit inside this height (keeps the shape; never enlarges). */
  maxHeight?: number;
}

/** One version of a picture an app can offer. */
export interface ImageAdjustVariant {
  /** Stable within the operation (`brighter-20`). */
  id: string;
  /** Short plain label ("20% brighter"). */
  label: string;
  /** One plain sentence, or omitted. */
  description?: string;
  adjustments: ImageAdjustments;
}

/** The operations, with a plain description for tool and help text. */
export const IMAGE_ADJUST_OPERATIONS: ReadonlyArray<{
  id: ImageAdjustOperation;
  description: string;
}> = Object.freeze([
  { id: 'brighter', description: 'Lighten the picture.' },
  { id: 'darker', description: 'Darken the picture.' },
  { id: 'more-contrast', description: 'Stronger lights and darks.' },
  { id: 'less-contrast', description: 'Softer, flatter lights and darks.' },
  { id: 'more-color', description: 'Richer colour.' },
  { id: 'less-color', description: 'Muted colour.' },
  { id: 'black-and-white', description: 'No colour.' },
  { id: 'rotate', description: 'Turn the picture a quarter or half turn.' },
  { id: 'flip', description: 'Mirror the picture.' },
  {
    id: 'zoom',
    description: 'Zoom in on one part of the picture (a closer crop).',
  },
  { id: 'resize', description: 'Make the picture smaller.' },
]);

const OPERATION_IDS = new Set<string>(
  IMAGE_ADJUST_OPERATIONS.map((op) => op.id),
);

export function isImageAdjustOperation(
  value: unknown,
): value is ImageAdjustOperation {
  return typeof value === 'string' && OPERATION_IDS.has(value);
}

const FOCI: readonly ImageFocus[] = [
  'center',
  'top',
  'bottom',
  'left',
  'right',
  'top-left',
  'top-right',
  'bottom-left',
  'bottom-right',
];

export function isImageFocus(value: unknown): value is ImageFocus {
  return typeof value === 'string' && FOCI.includes(value as ImageFocus);
}

const MIN_SIDE = 16;
const MAX_SIDE = 8192;
const MIN_REGION = 0.05;

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number, places = 3): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function finite(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

function normalizeRegion(value: unknown): ImageRegion | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const left = finite(record.left);
  const top = finite(record.top);
  const width = finite(record.width);
  const height = finite(record.height);
  if (left == null || top == null || width == null || height == null) {
    throw new Error('A region needs left, top, width and height (0 to 1).');
  }
  const l = clamp(left, 0, 1 - MIN_REGION);
  const t = clamp(top, 0, 1 - MIN_REGION);
  const w = clamp(width, MIN_REGION, 1 - l);
  const h = clamp(height, MIN_REGION, 1 - t);
  if (l === 0 && t === 0 && w === 1 && h === 1) return undefined;
  return { left: round(l), top: round(t), width: round(w), height: round(h) };
}

/**
 * Check and tidy adjustments from an untrusted source: clamp every value to
 * its range and drop what would change nothing. Throws a plain `Error` for a
 * value that cannot be understood (a rotation that is not a quarter turn).
 */
export function normalizeImageAdjustments(input: unknown): ImageAdjustments {
  if (!input || typeof input !== 'object') return {};
  const record = input as Record<string, unknown>;
  const result: ImageAdjustments = {};

  const multiplier = (key: string, min: number, max: number) => {
    const value = finite(record[key]);
    if (value == null) return undefined;
    const clamped = round(clamp(value, min, max));
    return clamped === 1 ? undefined : clamped;
  };
  const brightness = multiplier('brightness', 0.2, 3);
  if (brightness != null) result.brightness = brightness;
  const contrast = multiplier('contrast', 0.2, 3);
  if (contrast != null) result.contrast = contrast;
  const saturation = multiplier('saturation', 0, 3);
  if (saturation != null) result.saturation = saturation;
  if (record.grayscale === true) result.grayscale = true;

  const rotate = finite(record.rotate);
  if (rotate != null) {
    const turn = ((Math.round(rotate) % 360) + 360) % 360;
    if (turn % 90 !== 0) {
      throw new Error('Pictures can only be turned a quarter or half turn.');
    }
    if (turn !== 0) result.rotate = turn as 90 | 180 | 270;
  }
  if (record.flipHorizontal === true) result.flipHorizontal = true;
  if (record.flipVertical === true) result.flipVertical = true;

  const region = normalizeRegion(record.region);
  if (region) result.region = region;

  for (const key of ['maxWidth', 'maxHeight'] as const) {
    const value = finite(record[key]);
    if (value != null) {
      result[key] = Math.round(clamp(value, MIN_SIDE, MAX_SIDE));
    }
  }
  return result;
}

/** True when the adjustments change nothing. */
export function isEmptyImageAdjustments(
  adjustments: ImageAdjustments,
): boolean {
  return Object.keys(normalizeImageAdjustments(adjustments)).length === 0;
}

/**
 * A short, URL-safe string for adjustments, stable for the same values
 * (usable as a cache key): `b1.2,c1.1,s0.8,g,r90,fh,fv,x0.1_0.1_0.5_0.5,w1600,h900`.
 */
export function encodeImageAdjustments(input: ImageAdjustments): string {
  const a = normalizeImageAdjustments(input);
  const parts: string[] = [];
  if (a.brightness != null) parts.push(`b${a.brightness}`);
  if (a.contrast != null) parts.push(`c${a.contrast}`);
  if (a.saturation != null) parts.push(`s${a.saturation}`);
  if (a.grayscale) parts.push('g');
  if (a.rotate) parts.push(`r${a.rotate}`);
  if (a.flipHorizontal) parts.push('fh');
  if (a.flipVertical) parts.push('fv');
  if (a.region) {
    const { left, top, width, height } = a.region;
    parts.push(`x${left}_${top}_${width}_${height}`);
  }
  if (a.maxWidth != null) parts.push(`w${a.maxWidth}`);
  if (a.maxHeight != null) parts.push(`h${a.maxHeight}`);
  return parts.join(',');
}

/** Read a string from {@link encodeImageAdjustments}. Throws on anything else. */
export function decodeImageAdjustments(spec: string): ImageAdjustments {
  const text = typeof spec === 'string' ? spec.trim() : '';
  if (!text) return {};
  if (text.length > 200) throw new Error('Unknown picture adjustment.');
  const raw: Record<string, unknown> = {};
  for (const part of text.split(',')) {
    const match = /^(b|c|s|r|w|h|x)([0-9._-]+)$|^(g|fh|fv)$/.exec(part);
    if (!match) throw new Error('Unknown picture adjustment.');
    if (match[3] === 'g') raw.grayscale = true;
    else if (match[3] === 'fh') raw.flipHorizontal = true;
    else if (match[3] === 'fv') raw.flipVertical = true;
    else if (match[1] === 'x') {
      const values = match[2].split('_').map(Number);
      if (values.length !== 4 || values.some((v) => !Number.isFinite(v))) {
        throw new Error('Unknown picture adjustment.');
      }
      const [left, top, width, height] = values;
      raw.region = { left, top, width, height };
    } else {
      const value = Number(match[2]);
      if (!Number.isFinite(value)) {
        throw new Error('Unknown picture adjustment.');
      }
      const key = {
        b: 'brightness',
        c: 'contrast',
        s: 'saturation',
        r: 'rotate',
        w: 'maxWidth',
        h: 'maxHeight',
      }[match[1] as 'b' | 'c' | 's' | 'r' | 'w' | 'h'];
      raw[key] = value;
    }
  }
  return normalizeImageAdjustments(raw);
}

/** The region for a zoom on `focus`, keeping `scale` (0.3–0.95) of each side. */
export function regionForFocus(focus: ImageFocus, scale: number): ImageRegion {
  const size = clamp(scale, 0.3, 0.95);
  const spare = 1 - size;
  const horizontal = focus.includes('left')
    ? 0
    : focus.includes('right')
      ? spare
      : spare / 2;
  const vertical = focus.startsWith('top')
    ? 0
    : focus.startsWith('bottom')
      ? spare
      : spare / 2;
  return {
    left: round(horizontal),
    top: round(vertical),
    width: round(size),
    height: round(size),
  };
}

const PERCENT_STEPS = [10, 20, 30] as const;

/**
 * Two to four versions for one operation, mildest first. `focus` is where a
 * zoom centres (default the middle).
 */
export function imageAdjustVariants(
  operation: ImageAdjustOperation,
  options: { focus?: ImageFocus } = {},
): ImageAdjustVariant[] {
  switch (operation) {
    case 'brighter':
      return PERCENT_STEPS.map((step) => ({
        id: `brighter-${step}`,
        label: `${step}% brighter`,
        adjustments: { brightness: 1 + step / 100 },
      }));
    case 'darker':
      return PERCENT_STEPS.map((step) => ({
        id: `darker-${step}`,
        label: `${step}% darker`,
        adjustments: { brightness: 1 - step / 100 },
      }));
    case 'more-contrast':
      return PERCENT_STEPS.map((step) => ({
        id: `contrast-up-${step}`,
        label: `${step}% more contrast`,
        adjustments: { contrast: 1 + step / 100 },
      }));
    case 'less-contrast':
      return PERCENT_STEPS.map((step) => ({
        id: `contrast-down-${step}`,
        label: `${step}% less contrast`,
        adjustments: { contrast: 1 - step / 100 },
      }));
    case 'more-color':
      return PERCENT_STEPS.map((step) => ({
        id: `color-up-${step}`,
        label: `${step * 2}% more colour`,
        adjustments: { saturation: 1 + (step * 2) / 100 },
      }));
    case 'less-color':
      return PERCENT_STEPS.map((step) => ({
        id: `color-down-${step}`,
        label: `${step * 2}% less colour`,
        adjustments: { saturation: 1 - (step * 2) / 100 },
      }));
    case 'black-and-white':
      return [
        {
          id: 'bw',
          label: 'Black and white',
          adjustments: { grayscale: true },
        },
        {
          id: 'bw-contrast',
          label: 'Black and white, stronger',
          description: 'More contrast, like a newspaper photo.',
          adjustments: { grayscale: true, contrast: 1.25 },
        },
        {
          id: 'bw-soft',
          label: 'Black and white, softer',
          adjustments: { grayscale: true, contrast: 0.85, brightness: 1.05 },
        },
      ];
    case 'rotate':
      return [
        {
          id: 'rotate-right',
          label: 'Turn right',
          adjustments: { rotate: 90 },
        },
        {
          id: 'rotate-left',
          label: 'Turn left',
          adjustments: { rotate: 270 },
        },
        {
          id: 'rotate-half',
          label: 'Upside down',
          adjustments: { rotate: 180 },
        },
      ];
    case 'flip':
      return [
        {
          id: 'flip-horizontal',
          label: 'Mirror left to right',
          adjustments: { flipHorizontal: true },
        },
        {
          id: 'flip-vertical',
          label: 'Mirror top to bottom',
          adjustments: { flipVertical: true },
        },
      ];
    case 'zoom': {
      const focus = options.focus ?? 'center';
      return [
        { id: 'zoom-1', label: 'A little closer', scale: 0.8 },
        { id: 'zoom-2', label: 'Closer', scale: 0.65 },
        { id: 'zoom-3', label: 'Much closer', scale: 0.5 },
      ].map(({ id, label, scale }) => ({
        id,
        label,
        adjustments: { region: regionForFocus(focus, scale) },
      }));
    }
    case 'resize':
      return [
        { id: 'size-large', label: 'Large (1600 wide)', side: 1600 },
        { id: 'size-medium', label: 'Medium (1200 wide)', side: 1200 },
        { id: 'size-small', label: 'Small (800 wide)', side: 800 },
      ].map(({ id, label, side }) => ({
        id,
        label,
        adjustments: { maxWidth: side, maxHeight: side },
      }));
    default:
      throw new Error('Unknown picture adjustment.');
  }
}

/** A plain sentence for adjustments ("20% brighter, black and white"). */
export function describeImageAdjustments(input: ImageAdjustments): string {
  const a = normalizeImageAdjustments(input);
  const percent = (value: number) => Math.round(Math.abs(value - 1) * 100);
  const parts: string[] = [];
  if (a.rotate) {
    parts.push(
      a.rotate === 90
        ? 'turned right'
        : a.rotate === 270
          ? 'turned left'
          : 'turned upside down',
    );
  }
  if (a.flipHorizontal) parts.push('mirrored left to right');
  if (a.flipVertical) parts.push('mirrored top to bottom');
  if (a.region) parts.push('zoomed in');
  if (a.brightness != null) {
    parts.push(
      `${percent(a.brightness)}% ${a.brightness > 1 ? 'brighter' : 'darker'}`,
    );
  }
  if (a.contrast != null) {
    parts.push(
      `${percent(a.contrast)}% ${a.contrast > 1 ? 'more' : 'less'} contrast`,
    );
  }
  if (a.saturation != null) {
    parts.push(
      `${percent(a.saturation)}% ${a.saturation > 1 ? 'more' : 'less'} colour`,
    );
  }
  if (a.grayscale) parts.push('black and white');
  if (a.maxWidth != null || a.maxHeight != null) parts.push('smaller');
  return parts.join(', ') || 'unchanged';
}

/** Output of `applyImageAdjustments` (Node-only, `@happyvertical/smrt-images/node`). */
export interface AppliedImageAdjustments {
  data: Buffer;
  mimeType: string;
  width: number;
  height: number;
}

export type ImageAdjustOutputFormat = 'jpeg' | 'png' | 'webp';

/** A pixel rectangle inside a `width`×`height` picture for `region`. */
export function regionToPixels(
  region: ImageRegion,
  width: number,
  height: number,
): { left: number; top: number; width: number; height: number } {
  const left = clamp(Math.round(region.left * width), 0, width - 1);
  const top = clamp(Math.round(region.top * height), 0, height - 1);
  return {
    left,
    top,
    width: clamp(Math.round(region.width * width), 1, width - left),
    height: clamp(Math.round(region.height * height), 1, height - top),
  };
}
