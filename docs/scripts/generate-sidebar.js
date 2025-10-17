#!/usr/bin/env node
/**
 * Script to generate sidebars.ts from package READMEs
 * Automatically extracts section headings from READMEs and creates sidebar navigation
 */

import { readFile, writeFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const repoRoot = join(__dirname, '../..');
const packagesDir = join(repoRoot, 'packages');
const sidebarPath = join(__dirname, '../sidebars.ts');

// SMRT package names in order
const packages = [
  { id: 'types', label: '@smrt/types', position: 2 },
  { id: 'core', label: '@smrt/core', position: 3 },
  { id: 'accounts', label: '@smrt/accounts', position: 4 },
  { id: 'agents', label: '@smrt/agents', position: 5 },
  { id: 'assets', label: '@smrt/assets', position: 6 },
  { id: 'content', label: '@smrt/content', position: 7 },
  { id: 'events', label: '@smrt/events', position: 8 },
  { id: 'gnode', label: '@smrt/gnode', position: 9 },
  { id: 'places', label: '@smrt/places', position: 10 },
  { id: 'products', label: '@smrt/products', position: 11 },
  { id: 'profiles', label: '@smrt/profiles', position: 12 },
  { id: 'tags', label: '@smrt/tags', position: 13 },
];

/**
 * Extract section headings from markdown content
 * @param {string} content - Markdown content
 * @returns {Array<{label: string, anchor: string}>} - Section headings
 */
function extractSections(content) {
  const lines = content.split('\n');
  const sections = [];

  // Skip frontmatter
  let inFrontmatter = false;
  let startIndex = 0;

  if (lines[0] === '---') {
    inFrontmatter = true;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i] === '---') {
        startIndex = i + 1;
        break;
      }
    }
  }

  // Extract ## headings (h2 only)
  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(/^## (.+)$/);

    if (match) {
      const heading = match[1].trim();

      // Skip certain headings
      if (heading.toLowerCase() === 'license') continue;
      if (heading.startsWith('@smrt/')) continue;
      if (heading.startsWith('@have/')) continue;

      // Remove emojis for both label and anchor
      const cleanHeading = heading
        .replace(/[\u{1F600}-\u{1F64F}]/gu, '') // Emoticons
        .replace(/[\u{1F300}-\u{1F5FF}]/gu, '') // Misc Symbols and Pictographs
        .replace(/[\u{1F680}-\u{1F6FF}]/gu, '') // Transport and Map
        .replace(/[\u{1F1E0}-\u{1F1FF}]/gu, '') // Regional country flags
        .replace(/[\u{2600}-\u{26FF}]/gu, '')   // Misc symbols
        .replace(/[\u{2700}-\u{27BF}]/gu, '')   // Dingbats
        .replace(/[\u{FE00}-\u{FE0F}]/gu, '')   // Variation selectors
        .replace(/[\u{E0000}-\u{E007F}]/gu, '') // Tags
        .replace(/[\u{200D}]/gu, '')            // Zero-width joiner
        .trim();

      // Convert to anchor
      const anchor = cleanHeading
        .toLowerCase()
        .replace(/[^\w\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/^-+|-+$/g, '');  // Remove leading/trailing dashes

      sections.push({
        label: cleanHeading.replace(/'/g, "\\'"),  // Escape single quotes
        anchor: anchor
      });
    }
  }

  return sections;
}

/**
 * Generate sidebar items for a package
 * @param {Object} pkg - Package info
 * @returns {Promise<Array|null>} - Sidebar items or null if README doesn't exist
 */
async function generatePackageSidebar(pkg) {
  try {
    const readmePath = join(packagesDir, pkg.id, 'README.md');
    const content = await readFile(readmePath, 'utf-8');
    const sections = extractSections(content);

    // Limit to first 5-6 most important sections
    const maxSections = 6;
    const items = sections.slice(0, maxSections).map(section => ({
      type: 'link',
      label: section.label,
      href: `/${pkg.id}#${section.anchor}`
    }));

    // Add API Reference link
    items.push({
      type: 'link',
      label: '📚 API Reference',
      href: `/api/${pkg.id}/globals`
    });

    return items;
  } catch (error) {
    console.warn(`⚠ Warning: Could not read README for ${pkg.id}:`, error.message);
    return null;  // Return null to indicate package should be skipped
  }
}

/**
 * Generate the complete sidebars.ts file
 */
async function generateSidebar() {
  console.log('Generating sidebars.ts from package READMEs...');

  // Generate sidebar items for each package
  const allPackageSidebars = await Promise.all(
    packages.map(async (pkg) => {
      const items = await generatePackageSidebar(pkg);
      if (items === null) {
        console.log(`⚠ Skipping ${pkg.label} (no README found)`);
        return null;
      }
      console.log(`✓ Generated sidebar for ${pkg.label} (${items.length} sections)`);
      return { pkg, items };
    })
  );

  // Filter out packages without READMEs
  const packageSidebars = allPackageSidebars.filter(item => item !== null);

  // Build the TypeScript content
  const sidebarContent = `import type { SidebarsConfig } from '@docusaurus/plugin-content-docs';

const sidebars: SidebarsConfig = {
  docsSidebar: [
    {
      type: 'doc',
      id: 'index',
      label: 'Introduction',
    },
${packageSidebars.map(({ pkg, items }) => `    {
      type: 'category',
      label: '${pkg.label}',
      link: { type: 'doc', id: '${pkg.id}' },
      collapsed: true,
      items: [
${items.map(item => `        { type: '${item.type}', label: '${item.label}', href: '${item.href}' },`).join('\n')}
      ],
    },`).join('\n')}
  ],
};

export default sidebars;
`;

  // Write the file
  await writeFile(sidebarPath, sidebarContent, 'utf-8');
  console.log('\n✓ Generated sidebars.ts successfully!');
}

// Run the script
generateSidebar().catch((error) => {
  console.error('Error generating sidebar:', error);
  process.exit(1);
});
