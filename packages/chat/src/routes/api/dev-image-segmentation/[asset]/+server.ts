import { readFile } from 'node:fs/promises';
import { segmentationAssetPath } from '@happyvertical/images/segmentation-assets';
import { error } from '@sveltejs/kit';
import { dev } from '$app/environment';

/** Serve prepared, allowlisted model assets locally; never receives a user photo. */
export async function GET({ params }: { params: { asset: string } }) {
  if (!dev) error(404, 'Not found');
  let path: string;
  try {
    path = segmentationAssetPath(params.asset);
  } catch {
    error(404, 'Unknown segmentation asset');
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch {
    error(
      503,
      'Segmentation assets are not prepared. Run the SDK images prepare:segmentation command.',
    );
  }
  const body = new Uint8Array(bytes).buffer as ArrayBuffer;
  return new Response(body, {
    headers: {
      'content-type': params.asset.endsWith('.wasm')
        ? 'application/wasm'
        : params.asset.endsWith('.js')
          ? 'text/javascript'
          : 'application/octet-stream',
      'cache-control': 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
    },
  });
}
