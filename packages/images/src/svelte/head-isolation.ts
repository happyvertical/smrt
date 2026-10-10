import {
  encodeRgbaPng,
  segmentationAlpha,
  segmentImage,
} from '@happyvertical/images/segmentation';
import type { FaceOutline } from '../photo-cutout-setup.js';

/** SMRT's photographic head policy: retain hair + facial skin, excluding neck and clothes. */
export async function isolatePhotoHead(
  image: HTMLImageElement,
  options: {
    assetBaseUrl: string;
    signal?: AbortSignal;
    onProgress?: (stage: 'loading' | 'segmenting') => void;
  },
): Promise<{
  file: File;
  width: number;
  height: number;
  outline: FaceOutline;
}> {
  const width = image.naturalWidth,
    height = image.naturalHeight;
  if (!width || !height || width * height > 16_777_216)
    throw new Error('Choose a photo below 16 megapixels.');
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context)
    throw new Error('Image processing is unavailable in this browser.');
  context.drawImage(image, 0, 0);
  const source = context.getImageData(0, 0, width, height);
  const mask = await segmentImage(source, options);
  if (mask.width !== width || mask.height !== height)
    throw new Error('Segmentation mask does not match the original photo.');
  const alpha = segmentationAlpha(mask, {
    classes: [1, 3],
    lower: 0.15,
    upper: 0.85,
    largestComponent: true,
  });
  options.signal?.throwIfAborted();
  let left = width,
    right = 0,
    top = height,
    bottom = 0;
  for (let i = 0; i < alpha.length; i++)
    if (alpha[i]) {
      const x = i % width,
        y = Math.floor(i / width);
      left = Math.min(left, x);
      right = Math.max(right, x + 1);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y + 1);
    }
  const cropWidth = right - left,
    cropHeight = bottom - top;
  if (cropWidth < 16 || cropHeight < 16)
    throw new Error('No clear head found. Try a closer, front-facing photo.');
  const rgba = new Uint8ClampedArray(cropWidth * cropHeight * 4);
  const boundary: Array<{ x: number; y: number }> = [];
  for (let y = top; y < bottom; y++) {
    let first = right,
      last = left;
    for (let x = left; x < right; x++) {
      const from = (y * width + x) * 4,
        to = ((y - top) * cropWidth + x - left) * 4;
      rgba.set(source.data.subarray(from, from + 3), to);
      rgba[to + 3] = Math.round(
        (alpha[y * width + x] * source.data[from + 3]) / 255,
      );
      if (alpha[y * width + x]) {
        first = Math.min(first, x);
        last = Math.max(last, x + 1);
      }
    }
    if (first < last)
      for (const x of [first, last])
        for (const edgeY of [y, y + 1])
          boundary.push({
            x: ((x - left) / cropWidth) * 1000,
            y: ((edgeY - top) / cropHeight) * 1000,
          });
  }
  // The later rig needs an envelope only: actual silhouette remains the PNG's per-pixel alpha.
  const points = convexEnvelope(boundary);
  const blob = await encodeRgbaPng(cropWidth, cropHeight, rgba);
  options.signal?.throwIfAborted();
  return {
    file: new File([blob], 'isolated-head.png', { type: 'image/png' }),
    width: cropWidth,
    height: cropHeight,
    outline: { points },
  };
}

function convexEnvelope(points: Array<{ x: number; y: number }>) {
  points.sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (
    a: (typeof points)[number],
    b: (typeof points)[number],
    c: (typeof points)[number],
  ) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const half = (list: typeof points) => {
    const result: typeof points = [];
    for (const point of list) {
      while (
        result.length > 1 &&
        cross(result[result.length - 2], result[result.length - 1], point) <= 0
      )
        result.pop();
      result.push(point);
    }
    return result.slice(0, -1);
  };
  return [...half(points), ...half([...points].reverse())];
}
