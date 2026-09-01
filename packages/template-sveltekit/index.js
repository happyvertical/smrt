/**
 * SMRT SvelteKit Template
 *
 * Provides the SvelteKit project template for SMRT framework.
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Paths inside `template/` that are not part of the scaffold output. These
 * exist only to support test-time tooling at the monorepo level (e.g. the
 * vendored `.svelte-kit/tsconfig.json` stub that lets the template's own
 * tests typecheck without first running `svelte-kit sync`).
 */
const COPY_SKIP = new Set(['.svelte-kit', '__tests__', 'test', 'tests']);

/**
 * Get the path to the template directory
 */
export function getTemplatePath() {
  return join(__dirname, 'template');
}

function packageNameForProject(name) {
  const normalized = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return name.startsWith('@') ? name : `@smrt-app/${normalized}`;
}

/**
 * Copy the template to a destination directory
 *
 * @param {string} destination - Destination directory path
 * @param {object} options - Options for template copying
 * @param {string} [options.name] - Project name (updates package.json)
 * @param {boolean} [options.overwrite=false] - Overwrite existing files
 */
export function copyTemplate(destination, options = {}) {
  const templatePath = getTemplatePath();

  if (!existsSync(templatePath)) {
    throw new Error('Template directory not found');
  }

  // Create destination if it doesn't exist
  if (!existsSync(destination)) {
    mkdirSync(destination, { recursive: true });
  }

  // Copy all template files, skipping internal-only directories
  cpSync(templatePath, destination, {
    recursive: true,
    force: options.overwrite || false,
    filter: (src) => {
      const relative = src.slice(templatePath.length + 1);
      if (!relative) return true;
      const topLevel = relative.split(/[\\/]/)[0];
      return !COPY_SKIP.has(topLevel);
    },
  });

  // Update package.json with project name if provided
  if (options.name) {
    const packageJsonPath = join(destination, 'package.json');
    if (existsSync(packageJsonPath)) {
      const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
      // s-m-r-t runtime identities use scoped package-qualified class names.
      // Keep a friendly directory/project name while making the generated
      // package identity valid for isolated runtime registration.
      packageJson.name = packageNameForProject(options.name);
      writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2));
    }
  }

  return destination;
}

/**
 * Template metadata
 */
export const templateInfo = {
  name: 'sveltekit',
  description: 'Profile-aware installable SvelteKit project with s-m-r-t integration',
  features: [
    'SvelteKit 2.x with Svelte 5',
    'Auto-generated REST API routes',
    's-m-r-t CLI integration',
    'TypeScript support',
    'SQLite database (configurable)',
    'Local, self-hosted, and cloud runtime profiles',
    'Deterministic install, diagnostics, and portability commands',
    'Production Node container and separate worker entry points',
    'Session-authorized tenancy with separate subdomain selection',
  ],
};

export default {
  getTemplatePath,
  copyTemplate,
  templateInfo,
};
