import {
  clipPhotoCutoutOutlineBelowLine,
  type PhotoCutoutRig,
  PhotoCutoutValidationError,
  validatePhotoCutoutOutline,
  validatePhotoCutoutRig,
} from '@happyvertical/animation';

/** A small, server-safe boundary for untrusted vision-model JSON. */
export interface PhotoCutoutSetupInput {
  assetId: string;
  width: number;
  height: number;
}

export interface FaceOutline {
  points: Array<{ x: number; y: number }>;
}
export interface MouthLandmarks {
  mouthLeft: { x: number; y: number };
  mouthRight: { x: number; y: number };
  chin: { x: number; y: number };
}

/** Validate a normalized (0..1000) closed face silhouette from the vision pass. */
export function parseFaceOutline(response: string | unknown): FaceOutline {
  const value = typeof response === 'string' ? JSON.parse(response) : response;
  const points = record(value).points;
  if (!Array.isArray(points) || points.length < 5 || points.length > 64) {
    throw new PhotoCutoutValidationError('face outline needs 5-64 points');
  }
  const parsed = points.map((point) => {
    const p = record(point);
    const x = p.x;
    const y = p.y;
    if (
      typeof x !== 'number' ||
      typeof y !== 'number' ||
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      x < 0 ||
      y < 0 ||
      x > 1000 ||
      y > 1000
    )
      throw new PhotoCutoutValidationError(
        'face outline point is outside normalized bounds',
      );
    return { x, y };
  });
  return {
    points: validatePhotoCutoutOutline(parsed, {
      width: 1000,
      height: 1000,
      minPoints: 5,
    }),
  };
}

/** Build the Canadian horizontal split from real cropped-face landmarks. */
export function assembleCanadianSplitRig(input: {
  outline: FaceOutline;
  landmarks: MouthLandmarks;
  width: number;
  height: number;
  assetId: string;
}): PhotoCutoutRig {
  const seam = (input.landmarks.mouthLeft.y + input.landmarks.mouthRight.y) / 2;
  const lower = clipPhotoCutoutOutlineBelowLine(input.outline.points, {
    width: 1000,
    height: 1000,
    y: seam,
    minPoints: 3,
  });
  const scale = (p: { x: number; y: number }) => ({
    x: (p.x / 1000) * input.width,
    y: (p.y / 1000) * input.height,
  });
  const head = input.outline.points.map(scale);
  const jaw = lower.map(scale);
  const gap = Math.max(
    2,
    Math.round(((input.landmarks.chin.y - seam) / 1000) * input.height * 0.36),
  );
  const canvasHeight = input.height + gap;
  const pivot = scale({
    x: (input.landmarks.mouthLeft.x + input.landmarks.mouthRight.x) / 2,
    y: seam,
  });
  const rig: PhotoCutoutRig = {
    rigKind: 'photo-cutout',
    version: 1,
    id: 'portrait',
    ariaLabel: 'Photographic Canadian character',
    canvas: { width: input.width, height: canvasHeight },
    layers: [
      {
        id: 'head',
        assetId: input.assetId,
        role: 'head',
        clip: head,
        imageFrame: { x: 0, y: 0, width: input.width, height: input.height },
      },
      {
        id: 'jaw',
        assetId: input.assetId,
        role: 'jaw',
        clip: jaw,
        imageFrame: { x: 0, y: 0, width: input.width, height: input.height },
      },
    ],
    jaw: {
      layerId: 'jaw',
      pivot,
      maxOpenDegrees: 0,
      maxOpenOffset: { x: 0, y: gap },
    },
  };
  validatePhotoCutoutRig(rig);
  return rig;
}

export function faceOutlinePrompt(): string {
  return 'Return JSON only: {"points":[{"x":number,"y":number},...]}. The first image is the original portrait. The second is the same original pixels with a labeled coordinate grid: labels 0..1000 map directly to this response’s x and y coordinates. Use that grid to place every point. Trace the visible head-and-face silhouette tightly in clockwise order, starting at the highest visible hair point. Include an actual point at the outermost left hair/ear edge, outermost right hair/ear edge, and lowest chin point; trace every visible hair, ear, cheek, and chin boundary between them without jumping through background. Exclude background beside hair and ears. Use 24-48 points where needed for curved hair/ear contours. This is an approximate closed silhouette for transparent background removal, not fine-hair matting and never a rectangular crop. No prose or extra keys.';
}

export function parseMouthLandmarks(
  response: string | unknown,
): MouthLandmarks {
  const root = record(
    typeof response === 'string' ? JSON.parse(response) : response,
  );
  const point = (name: 'mouthLeft' | 'mouthRight' | 'chin') => {
    const p = record(root[name]);
    const x = p.x;
    const y = p.y;
    if (
      typeof x !== 'number' ||
      typeof y !== 'number' ||
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      x < 0 ||
      x > 1000 ||
      y < 0 ||
      y > 1000
    )
      throw new PhotoCutoutValidationError(
        `${name} is outside normalized bounds`,
      );
    return { x, y };
  };
  const mouthLeft = point('mouthLeft');
  const mouthRight = point('mouthRight');
  const chin = point('chin');
  if (
    mouthLeft.x >= mouthRight.x ||
    chin.y <= Math.max(mouthLeft.y, mouthRight.y)
  )
    throw new PhotoCutoutValidationError(
      'mouth and chin landmarks are anatomically invalid',
    );
  return { mouthLeft, mouthRight, chin };
}

export function mouthLandmarksPrompt(): string {
  return 'Return JSON only: {"mouthLeft":{"x":number,"y":number},"mouthRight":{"x":number,"y":number},"chin":{"x":number,"y":number}}. Analyze this transparent cropped face. Coordinates are normalized 0..1000 in this cropped image. mouthLeft and mouthRight are the actual outer lip corners; chin is the center lowest chin point. Do not return polygons, a rig, or prose.';
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PhotoCutoutValidationError('setup response must be an object');
  }
  return value as Record<string, unknown>;
}

/**
 * Parses a model response and binds every image layer to the authorized source
 * image. The animation validator is the final geometry and bounds authority.
 */
export function parsePhotoCutoutSetup(
  response: string | unknown,
  source: PhotoCutoutSetupInput,
): PhotoCutoutRig {
  const candidate =
    typeof response === 'string' ? JSON.parse(response) : response;
  const root = record(candidate);
  const rig = (root.rig ?? candidate) as unknown;
  const rigRecord = record(rig);
  const canvas = record(rigRecord.canvas);
  if (canvas.width !== source.width || canvas.height !== source.height) {
    throw new PhotoCutoutValidationError(
      'setup canvas does not match source image',
    );
  }
  const layers = rigRecord.layers;
  if (!Array.isArray(layers)) {
    throw new PhotoCutoutValidationError('setup layers are required');
  }
  for (const layer of layers) {
    const layerRecord = record(layer);
    if (
      layerRecord.kind !== 'solid' &&
      layerRecord.assetId !== source.assetId
    ) {
      throw new PhotoCutoutValidationError(
        'setup may reference only the authorized source asset',
      );
    }
  }
  // The solid mouth is painted beneath the photographic jaw. Making its clip
  // identical to the jaw guarantees it cannot appear through a neutral jaw;
  // the runtime reveals it only as the jaw rotates open.
  const jaw = layers.find((layer) => record(layer).role === 'jaw');
  const mouth = layers.find(
    (layer) =>
      record(layer).role === 'mouth-interior' && record(layer).kind === 'solid',
  );
  if (!jaw || !mouth) {
    throw new PhotoCutoutValidationError(
      'setup requires jaw and mouth-interior layers',
    );
  }
  record(mouth).clip = record(jaw).clip;
  validatePhotoCutoutRig(rig);
  return rig;
}

/** Deliberately specific instructions reduce geometry ambiguity from vision models. */
export function photoCutoutSetupPrompt(source: PhotoCutoutSetupInput): string {
  return `Analyze the supplied portrait and return JSON only with this exact shape:
{"rig":{"rigKind":"photo-cutout","version":1,"id":"portrait","ariaLabel":"Photographic portrait","canvas":{"width":${source.width},"height":${source.height}},"layers":[{"id":"head","assetId":"${source.assetId}","role":"head","clip":[{"x":10,"y":10},{"x":90,"y":10},{"x":90,"y":110},{"x":10,"y":110}]},{"id":"mouth","kind":"solid","role":"mouth-interior","color":{"r":30,"g":10,"b":10},"clip":[{"x":40,"y":70},{"x":60,"y":70},{"x":50,"y":82}]},{"id":"jaw","assetId":"${source.assetId}","role":"jaw","clip":[{"x":30,"y":65},{"x":70,"y":65},{"x":70,"y":105},{"x":30,"y":105}]}],"jaw":{"layerId":"jaw","pivot":{"x":50,"y":65},"maxOpenDegrees":12}}}
Use the example only as a schema: scale all numeric coordinates to the actual ${source.width}x${source.height} image. Image layers use assetId "${source.assetId}"; the only solid layer is mouth-interior and uses integer RGB. Create a cutout head polygon, jaw polygon, and visible mouth interior from the photographed face. The jaw must be an inset lower-face polygon: leave at least 2% of head width/height between every jaw or pivot point and the head boundary. Place mouth entirely inside jaw. Every polygon must be simple, have at least three points, remain in the canvas, and the jaw/mouth must be inside the head. Do not include URLs, SVG paths, markup, transforms, prose, or keys not shown.`;
}
