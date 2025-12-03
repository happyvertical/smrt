/**
 * Initialize Data Directory
 *
 * Creates empty JSON files for the site's data storage.
 * Run this after creating a new site: pnpm run init-data
 */

import { mkdir, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';

const DATA_DIR = join(process.cwd(), 'data');

const INITIAL_FILES: Record<string, any[]> = {
  'contents.json': [],
  'events.json': [],
  'places.json': [],
  'profiles.json': [],
  'assets.json': [],
};

async function initData() {
  console.log('Initializing data directory...\n');

  // Ensure data directory exists
  try {
    await access(DATA_DIR);
    console.log('  ✓ data/ directory exists');
  } catch {
    await mkdir(DATA_DIR, { recursive: true });
    console.log('  ✓ Created data/ directory');
  }

  // Create each data file if it doesn't exist
  for (const [filename, initialData] of Object.entries(INITIAL_FILES)) {
    const filepath = join(DATA_DIR, filename);
    try {
      await access(filepath);
      console.log(`  • ${filename} exists, skipping`);
    } catch {
      await writeFile(filepath, JSON.stringify(initialData, null, 2));
      console.log(`  ✓ Created ${filename}`);
    }
  }

  console.log('\n✅ Data initialization complete!');
  console.log('\nNext steps:');
  console.log('  1. Configure smrt.config.js with your council sources');
  console.log('  2. Run pnpm workflow:caelus to fetch weather data');
  console.log('  3. Run pnpm workflow:praeco to generate articles');
  console.log('  4. Run pnpm dev to start the development server');
}

initData().catch((error) => {
  console.error('Failed to initialize data:', error);
  process.exit(1);
});
