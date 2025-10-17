/**
 * NPM Package Template Loader
 *
 * Loads templates from installed npm packages.
 * Supports package exports for template discovery.
 */

import { access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import glob from 'fast-glob';
import type { TemplateConfig } from './template-loader.js';

/**
 * Resolve npm package path to template configuration
 *
 * Examples:
 * - @happyvertical/praeco/templates/sveltekit
 * - @org/templates
 * - my-template-package
 */
export async function resolveNpmPackage(packagePath: string): Promise<string> {
  // Try to resolve as module
  try {
    const resolved = require.resolve(packagePath, {
      paths: [process.cwd(), ...module.paths],
    });
    return resolved;
  } catch {
    // If not found, try looking in node_modules directly
    const nodeModulesPath = join(process.cwd(), 'node_modules', packagePath);
    try {
      await access(nodeModulesPath);
      return nodeModulesPath;
    } catch {
      throw new Error(
        `npm package '${packagePath}' not found. Install with: npm install ${packagePath.split('/')[0]}`,
      );
    }
  }
}

/**
 * Load template configuration from npm package
 */
export async function loadNpmTemplate(
  resolvedPath: string,
): Promise<TemplateConfig> {
  let configPath: string;

  // Check if resolved path is a template.config.js/ts file
  if (
    resolvedPath.endsWith('template.config.js') ||
    resolvedPath.endsWith('template.config.ts')
  ) {
    configPath = resolvedPath;
  } else {
    // Look for template.config.{js,ts} in the resolved directory
    const dir = resolvedPath.endsWith('.js')
      ? dirname(resolvedPath)
      : resolvedPath;

    try {
      configPath = join(dir, 'template.config.js');
      await access(configPath);
    } catch {
      try {
        configPath = join(dir, 'template.config.ts');
        await access(configPath);
      } catch {
        throw new Error(
          `No template.config.js or template.config.ts found in ${dir}`,
        );
      }
    }
  }

  // Load the configuration
  try {
    const configUrl = pathToFileURL(configPath).href;
    const module = await import(configUrl);
    const config = module.default || module;

    // Validate required fields
    validateTemplateConfig(config, configPath);

    return config;
  } catch (error) {
    throw new Error(
      `Failed to load template config from ${configPath}: ${error instanceof Error ? error.message : 'Unknown error'}`,
    );
  }
}

/**
 * Find template by short name in installed packages
 *
 * Searches for:
 * - Scoped packages with templates directory
 * - Scoped packages direct
 * - Unscoped packages
 */
export async function findTemplateInPackages(
  shortName: string,
): Promise<string | null> {
  const nodeModulesPath = join(process.cwd(), 'node_modules');

  // Search patterns
  const patterns = [
    // Scoped packages with templates directory
    `${nodeModulesPath}/@*/templates/${shortName}/template.config.{js,ts}`,
    // Scoped packages direct
    `${nodeModulesPath}/@*/${shortName}/template.config.{js,ts}`,
    // Unscoped packages
    `${nodeModulesPath}/${shortName}/template.config.{js,ts}`,
    // Templates subdirectory in any package
    `${nodeModulesPath}/*/templates/${shortName}/template.config.{js,ts}`,
  ];

  for (const pattern of patterns) {
    const matches = await glob(pattern, { absolute: true });
    if (matches.length > 0) {
      // Return the package path, not the template.config path
      const configPath = matches[0];
      return dirname(configPath);
    }
  }

  return null;
}

/**
 * Discover all templates in installed packages
 *
 * Useful for `smrt gnode list-templates` command
 */
export async function discoverInstalledTemplates(): Promise<
  Array<{ name: string; source: string; config: TemplateConfig }>
> {
  const nodeModulesPath = join(process.cwd(), 'node_modules');

  const patterns = [
    `${nodeModulesPath}/@*/templates/*/template.config.{js,ts}`,
    `${nodeModulesPath}/*/template.config.{js,ts}`,
  ];

  const templates: Array<{
    name: string;
    source: string;
    config: TemplateConfig;
  }> = [];

  for (const pattern of patterns) {
    const matches = await glob(pattern, { absolute: true });

    for (const configPath of matches) {
      try {
        const configUrl = pathToFileURL(configPath).href;
        const module = await import(configUrl);
        const config = module.default || module;

        // Extract package name from path
        const relativePath = configPath.replace(`${nodeModulesPath}/`, '');
        const source = relativePath.substring(
          0,
          relativePath.indexOf('/template.config'),
        );

        templates.push({
          name: config.name || 'unknown',
          source,
          config,
        });
      } catch (error) {
        // Skip templates that fail to load
        console.warn(`Failed to load template at ${configPath}:`, error);
      }
    }
  }

  return templates;
}

/**
 * Validate template configuration has required fields
 */
function validateTemplateConfig(config: any, source: string): void {
  const required = ['name', 'description', 'dependencies'];

  for (const field of required) {
    if (!config[field]) {
      throw new Error(
        `Invalid template config at ${source}: missing required field '${field}'`,
      );
    }
  }

  if (typeof config.dependencies !== 'object') {
    throw new Error(
      `Invalid template config at ${source}: 'dependencies' must be an object`,
    );
  }

  if (config.devDependencies && typeof config.devDependencies !== 'object') {
    throw new Error(
      `Invalid template config at ${source}: 'devDependencies' must be an object`,
    );
  }
}
