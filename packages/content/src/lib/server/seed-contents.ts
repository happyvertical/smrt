/**
 * Seed test contents for the content dev server
 * Runs once on first access — checks if contents exist and creates sample ones if empty.
 */

import { getCollection } from './smrt.js';

let seeded = false;

const SEED_CONTENTS = [
  {
    type: '@happyvertical/smrt-content:Article',
    name: 'The Future of AI Agents in Development',
    title: 'The Future of AI Agents in Development',
    body: '<p>AI agents are transforming how we build software by acting as autonomous co-developers that can plan, execute, and verify code changes.</p><p>Instead of just autocomplete, agents can understand full repository context and follow complex multi-step instructions, reducing the time spent on boilerplate and debugging.</p>',
    state: 'active',
    status: 'published',
    slug: 'future-of-ai-agents',
    author: 'SYSTEM',
    description:
      'An overview of how autonomous AI agents are revolutionizing software engineering.',
    tags: ['AI', 'Engineering', 'Future'],
  },
  {
    type: '@happyvertical/smrt-content:ContentDocument',
    name: 'Q3 Development Roadmap',
    title: 'Q3 Development Roadmap',
    body: '<h1>Q3 Priorities</h1><ul><li>Finish the Asset Manager UI</li><li>Integrate host-based previews for Blind Man Press</li><li>Resolve outstanding CI timeout issues</li><li>Release SMRT v1.0</li></ul>',
    state: 'active',
    status: 'review',
    slug: 'q3-development-roadmap',
    author: 'SYSTEM',
    description:
      'Internal planning document outlining major technical milestones for the upcoming quarter.',
    tags: ['Planning', 'Roadmap', 'Internal'],
  },
  {
    type: '@happyvertical/smrt-content:Article',
    name: 'Svelte 5 Runes: A Paradigm Shift',
    title: 'Svelte 5 Runes: A Paradigm Shift',
    body: '<p>Svelte 5 introduces "runes" as a universal, fine-grained reactivity system, replacing the older compiler-based $ reactive declarations.</p><p>This allows reactivity to exist outside of .svelte components and improves performance by explicitly tracking state dependencies.</p>',
    state: 'highlighted',
    status: 'review',
    slug: 'svelte-5-runes',
    author: 'SYSTEM',
    description:
      'A deep dive into why Svelte 5 runes matter and how to migrate from Svelte 4.',
    tags: ['Svelte', 'Frontend', 'Tutorial'],
  },
];

export async function seedContents(): Promise<void> {
  if (seeded) return;
  seeded = true;

  try {
    const collection = await getCollection<any>(
      '@happyvertical/smrt-content:Content',
    );
    const existing = await collection.list({});

    if (existing.length > 0) {
      console.log(
        `[seed] ${existing.length} contents already exist, skipping seed`,
      );
      return;
    }

    console.log('[seed] No contents found, seeding test contents...');
    for (const contentSchema of SEED_CONTENTS) {
      await collection.create(contentSchema);
    }
    console.log(`[seed] Created ${SEED_CONTENTS.length} test contents`);
  } catch (err) {
    console.error('[seed] Failed to seed contents:', err);
  }
}
