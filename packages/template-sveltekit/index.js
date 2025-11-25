/**
 * SMRT SvelteKit Template
 *
 * Provides the SvelteKit project template for SMRT framework.
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Get the path to the template directory
 */
export function getTemplatePath() {
  return join(__dirname, 'template');
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

  // Copy all template files
  cpSync(templatePath, destination, {
    recursive: true,
    force: options.overwrite || false,
  });

  // Update package.json with project name if provided
  if (options.name) {
    const packageJsonPath = join(destination, 'package.json');
    if (existsSync(packageJsonPath)) {
      const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
      packageJson.name = options.name;
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
  description: 'SvelteKit project with SMRT framework integration',
  features: [
    'SvelteKit 2.x with Svelte 5',
    'Auto-generated REST API routes',
    'SMRT CLI integration',
    'TypeScript support',
    'SQLite database (configurable)',
  ],
};

export default {
  getTemplatePath,
  copyTemplate,
  templateInfo,
};
