/**
 * Template Loader - Resolves and loads templates from various sources
 *
 * Supports:
 * - npm packages (@org/pkg/templates/name)
 * - Git repositories (github:user/repo, https://github.com/user/repo.git)
 * - Local filesystem paths (../path/to/template, /absolute/path)
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGitTemplate } from './git-loader.js';
import { loadLocalTemplate, resolveLocalPath } from './local-loader.js';
import {
  findTemplateInPackages,
  loadNpmTemplate,
  resolveNpmPackage,
} from './npm-loader.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface TemplateConfig {
  name: string;
  description: string;
  framework: string;
  baseGenerator?: {
    command: string;
    args: string[];
    skipPrompts?: boolean;
  };
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
}

export interface TemplateSource {
  type: 'npm' | 'git' | 'local';
  location: string;
  resolved: string;
}

/**
 * Resolve a template name to a specific source
 *
 * @param name - Template name or path
 *   - @org/pkg/templates/name (npm package)
 *   - github:user/repo (git shorthand)
 *   - https://github.com/user/repo.git (git URL)
 *   - ../path/to/template (local path)
 *   - short-name (searches installed packages)
 *
 * @returns Template source information
 */
export async function resolveTemplate(name: string): Promise<TemplateSource> {
  // Check for git repository first (most specific)
  if (
    name.startsWith('github:') ||
    name.startsWith('gitlab:') ||
    name.startsWith('git@') ||
    name.endsWith('.git') ||
    name.startsWith('https://github.com') ||
    name.startsWith('https://gitlab.com')
  ) {
    return {
      type: 'git',
      location: name,
      resolved: name,
    };
  }

  // Check for local filesystem path (before npm to avoid matching ./ and ~/)
  if (name.startsWith('/') || name.startsWith('.') || name.startsWith('~')) {
    return {
      type: 'local',
      location: name,
      resolved: await resolveLocalPath(name),
    };
  }

  // Check for npm package (contains @ or /)
  if (name.includes('@') || name.includes('/')) {
    return {
      type: 'npm',
      location: name,
      resolved: await resolveNpmPackage(name),
    };
  }

  // Short name - search installed packages
  const npmPath = await findTemplateInPackages(name);
  if (npmPath) {
    return {
      type: 'npm',
      location: npmPath,
      resolved: await resolveNpmPackage(npmPath),
    };
  }

  // Check for bundled templates in the CLI package
  const bundledPath = await findBundledTemplate(name);
  if (bundledPath) {
    return {
      type: 'local',
      location: bundledPath,
      resolved: bundledPath,
    };
  }

  throw new Error(
    `Template '${name}' not found. Tried:\n` +
      `  - npm package: @*/${name}, @*/templates/${name}\n` +
      `  - bundled template: ${name}\n` +
      `  - local path: ./${name}, ../${name}\n` +
      `\n` +
      `Use one of:\n` +
      `  - npm package: @org/pkg/templates/name\n` +
      `  - git repo: github:user/repo\n` +
      `  - local path: ../path/to/template`,
  );
}

/**
 * Find bundled template by name
 *
 * Looks for templates in sibling packages under @happyvertical/smrt-template-*
 */
async function findBundledTemplate(name: string): Promise<string | null> {
  const { existsSync } = await import('node:fs');
  const { resolve } = await import('node:path');

  // Map short names to package directories
  const bundledTemplates: Record<string, string> = {
    sveltekit: 'template-sveltekit',
    'smrt-sveltekit': 'template-sveltekit',
  };

  const packageDir = bundledTemplates[name.toLowerCase()];
  if (!packageDir) {
    return null;
  }

  // Look for the template package relative to CLI package
  // __dirname is packages/cli/src/loaders or packages/cli/dist/
  // Template is at packages/template-sveltekit
  const possiblePaths = [
    // When running from dist (built): dist/ -> cli -> packages -> template-sveltekit
    resolve(__dirname, '..', '..', packageDir),
    // When running from src (development): src/loaders -> src -> cli -> packages -> template-sveltekit
    resolve(__dirname, '..', '..', '..', packageDir),
    // Monorepo root: packages/cli/dist or src/loaders -> smrt repo -> packages/template-sveltekit
    resolve(__dirname, '..', '..', '..', 'packages', packageDir),
  ];

  for (const templatePath of possiblePaths) {
    const configPath = join(templatePath, 'template.config.js');
    if (existsSync(configPath)) {
      return templatePath;
    }
  }

  // Try resolving as npm package (@happyvertical/smrt-template-sveltekit)
  try {
    const npmPackage = `@happyvertical/smrt-${packageDir}`;
    const resolved = require.resolve(`${npmPackage}/template.config.js`, {
      paths: [process.cwd(), ...module.paths],
    });
    return dirname(resolved);
  } catch {
    // Package not installed
  }

  return null;
}

/**
 * Load template configuration from resolved source
 */
export async function loadTemplate(
  source: TemplateSource,
): Promise<TemplateConfig> {
  switch (source.type) {
    case 'npm':
      return loadNpmTemplate(source.resolved);
    case 'git':
      return loadGitTemplate(source.resolved);
    case 'local':
      return loadLocalTemplate(source.resolved);
    default:
      throw new Error(`Unknown template type: ${source.type}`);
  }
}
