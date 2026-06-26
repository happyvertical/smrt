/**
 * Seed test images for the content dev server
 * Runs once on first access — checks if images exist and creates sample ones if empty.
 */

import { Image } from '@happyvertical/smrt-images';
import { getCollection } from './smrt.js';

let seeded = false;

const SEED_IMAGES = [
  {
    name: 'City Skyline at Sunset',
    description:
      'A modern cityscape at sunset with warm orange and purple tones',
    sourceUri: '/test-assets/cityscape.png',
    mimeType: 'image/png',
    width: 1024,
    height: 1024,
    alt: 'City skyline with skyscrapers reflecting golden sunset light',
  },
  {
    name: 'Coffee Shop Interior',
    description: 'A cozy coffee shop interior with warm lighting and plants',
    sourceUri: '/test-assets/coffee-shop.png',
    mimeType: 'image/png',
    width: 1024,
    height: 1024,
    alt: 'Laptop and latte on a wooden table in a cozy coffee shop',
  },
  {
    name: 'Tech Circuit Abstract',
    description:
      'Abstract technology background with glowing circuit board patterns',
    sourceUri: '/test-assets/tech-abstract.png',
    mimeType: 'image/png',
    width: 1024,
    height: 1024,
    alt: 'Glowing blue and purple abstract circuit board pattern',
  },
];

export async function seedImages(): Promise<void> {
  if (seeded) return;
  seeded = true;

  try {
    const collection = await getCollection<Image>(
      '@happyvertical/smrt-images:Image',
    );
    const existing = await collection.list({});

    if (existing.length > 0) {
      console.log(
        `[seed] ${existing.length} images already exist, skipping seed`,
      );
      return;
    }

    console.log('[seed] No images found, seeding test images...');
    for (const img of SEED_IMAGES) {
      await collection.create(img);
    }
    console.log(`[seed] Created ${SEED_IMAGES.length} test images`);
  } catch (err) {
    console.error('[seed] Failed to seed images:', err);
  }
}
