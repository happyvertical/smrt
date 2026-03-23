import { error, json } from '@sveltejs/kit';
import { getCollection } from '$lib/server/smrt';
import type { RequestHandler } from './$types';

// Mock AI Variation
export const POST: RequestHandler = async ({ params, request }) => {
  await getCollection<any>('@happyvertical/smrt-assets:Asset');
  const collection = await getCollection<any>(
    '@happyvertical/smrt-images:Image',
  );
  const image = await collection.get(params.id);

  if (!image) throw error(404, 'Image not found');

  const { prompt } = await request.json();

  if (!prompt) throw error(400, 'Prompt is required for variation');

  // Instead of actually calling OpenAI, we create a dummy "AI Generated" variation
  // using an Unsplash placeholder so the developer can verify the UI flow.
  const newImage = await collection.create({
    name: `${image.name}-variation`,
    sourceUri: `https://images.unsplash.com/photo-1542281286-9e0a16bb7366?auto=format&fit=crop&w=1000&q=80`, // placeholder variation image
    mimeType: 'image/jpeg',
    width: image.width,
    height: image.height,
    alt: `Variant of ${image.name}: ${prompt}`,
    parentId: image.id,
    description: `AI Edited: ${prompt}`,
    typeSlug: 'image',
  });

  // Return the created variation matching what ImageUploader expects
  return json({ image: newImage });
};
