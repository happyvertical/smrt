import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const Filename = fileURLToPath(import.meta.url);
const Dirname = dirname(Filename);

/**
 * Package metadata extracted from CLAUDE.md files
 */
export interface PackageMetadata {
  name: string;
  path: string;
  description: string;
  claudeMd: string;
  keywords: string[];
}

/**
 * Keyword mapping for routing queries to SMRT packages
 */
export const PACKAGE_KEYWORDS: Record<string, string[]> = {
  core: [
    'smrt',
    'framework',
    'orm',
    'database',
    'collection',
    'object',
    'decorator',
    'schema',
    'persistence',
    'api',
    'rest',
    'cli',
    'mcp',
    'generator',
    'virtual module',
    'ai',
    'crud',
  ],
  types: ['types', 'typescript', 'definitions', 'interfaces', 'type safety'],
  config: [
    'config',
    'configuration',
    'cosmiconfig',
    'settings',
    'environment',
    'options',
  ],
  agents: [
    'agent',
    'autonomous',
    'actor',
    'workflow',
    'orchestration',
    'task',
    'automation',
  ],
  assets: [
    'asset',
    'file',
    'metadata',
    'version',
    'storage',
    'media',
    'document',
  ],
  content: [
    'content',
    'article',
    'markdown',
    'cms',
    'document',
    'blog',
    'post',
    'page',
    'publishing',
  ],
  events: [
    'event',
    'calendar',
    'meeting',
    'schedule',
    'attendance',
    'rsvp',
    'date',
    'time',
  ],
  gnode: [
    'federation',
    'network',
    'knowledge base',
    'distributed',
    'peer',
    'sync',
    'graph',
  ],
  places: [
    'place',
    'location',
    'geography',
    'venue',
    'address',
    'map',
    'coordinates',
  ],
  products: [
    'product',
    'catalog',
    'inventory',
    'microservice',
    'category',
    'sku',
    'store',
  ],
  profiles: [
    'profile',
    'user',
    'person',
    'relationship',
    'organization',
    'contact',
    'identity',
  ],
  tags: [
    'tag',
    'taxonomy',
    'categorization',
    'hierarchy',
    'classification',
    'label',
  ],
  accounts: [
    'accounting',
    'ledger',
    'transaction',
    'currency',
    'financial',
    'debit',
    'credit',
    'balance',
  ],
};

/**
 * Cache for loaded CLAUDE.md files
 */
const packageCache = new Map<string, PackageMetadata>();

/**
 * Get the root SMRT directory
 */
function getSMRTRoot(): string {
  // From packages/smrt-mcp/src/registry.ts -> ../../.. to get to SMRT root
  return join(Dirname, '..', '..', '..');
}

/**
 * Extract description from CLAUDE.md content
 * Looks for "Purpose and Responsibilities" or first paragraph
 */
function extractDescription(content: string): string {
  // Try to find Purpose and Responsibilities section
  const purposeMatch = content.match(
    /##\s+Purpose and Responsibilities\s+([^\n]+(?:\n(?!##)[^\n]+)*)/i,
  );
  if (purposeMatch) {
    // Get first sentence or first 200 chars
    const purpose = purposeMatch[1]
      .trim()
      .replace(/\n/g, ' ')
      .replace(/\s+/g, ' ');
    const firstSentence = purpose.match(/^[^.!?]+[.!?]/);
    if (firstSentence) {
      return firstSentence[0].trim();
    }
    return `${purpose.substring(0, 200).trim()}...`;
  }

  // Fallback: get first paragraph after title
  const lines = content.split('\n');
  let foundTitle = false;
  for (const line of lines) {
    if (line.startsWith('# ') || line.startsWith('## ')) {
      foundTitle = true;
      continue;
    }
    if (foundTitle && line.trim().length > 0 && !line.startsWith('#')) {
      return line.trim();
    }
  }

  return 'No description available';
}

/**
 * Scan packages directory for CLAUDE.md files and build registry
 */
export async function buildPackageRegistry(): Promise<
  Map<string, PackageMetadata>
> {
  if (packageCache.size > 0) {
    return packageCache;
  }

  const smrtRoot = getSMRTRoot();
  const packagesDir = join(smrtRoot, 'packages');

  try {
    const entries = await readdir(packagesDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const packageName = entry.name;
      const claudeMdPath = join(packagesDir, packageName, 'CLAUDE.md');

      try {
        const claudeMd = await readFile(claudeMdPath, 'utf-8');
        const description = extractDescription(claudeMd);
        const keywords = PACKAGE_KEYWORDS[packageName] || [];

        packageCache.set(packageName, {
          name: packageName,
          path: join(packagesDir, packageName),
          description,
          claudeMd,
          keywords,
        });
      } catch (_error) {
        // Skip packages without CLAUDE.md
      }
    }

    return packageCache;
  } catch (error) {
    throw new Error(
      `Failed to build package registry: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Get package metadata by name
 */
export async function getPackage(
  name: string,
): Promise<PackageMetadata | undefined> {
  const registry = await buildPackageRegistry();
  return registry.get(name);
}

/**
 * Get all packages
 */
export async function getAllPackages(): Promise<PackageMetadata[]> {
  const registry = await buildPackageRegistry();
  return Array.from(registry.values());
}

/**
 * Get package CLAUDE.md content
 */
export async function getPackageDocs(
  name: string,
): Promise<string | undefined> {
  const pkg = await getPackage(name);
  return pkg?.claudeMd;
}

/**
 * Clear the package cache (for testing)
 */
export function clearCache(): void {
  packageCache.clear();
}
