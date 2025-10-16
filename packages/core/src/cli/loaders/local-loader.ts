/**
 * Local Filesystem Template Loader
 *
 * Loads templates from local directories.
 * Useful for development and testing.
 */

import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { TemplateConfig } from './template-loader.js';

/**
 * Expand home directory (~) in paths
 * Handles both ~/ and ~ patterns
 */
function expandHomeDirectory(path: string): string {
  if (path.startsWith('~/')) {
    return join(homedir(), path.slice(2));
  }
  if (path.startsWith('~')) {
    return join(homedir(), path.slice(1));
  }
  return path;
}

/**
 * Validate resolved path to prevent path traversal attacks
 * Focuses on blocking access to sensitive system directories
 * while allowing legitimate parent directory navigation (e.g., ../sibling-dir)
 */
function validateResolvedPath(
  absolutePath: string,
  originalPath: string,
): void {
  const home = homedir();

  // Check if path contains null bytes (common path traversal technique)
  if (absolutePath.includes('\0') || originalPath.includes('\0')) {
    throw new Error(
      'Path contains null bytes (potential path traversal attempt)',
    );
  }

  // For home directory paths, ensure they stay within home directory
  // This is stricter because ~ explicitly means "home directory"
  if (originalPath.startsWith('~')) {
    const normalizedPath = resolve(absolutePath);
    const normalizedHome = resolve(home);

    if (!normalizedPath.startsWith(normalizedHome)) {
      throw new Error(
        `Path traversal detected: resolved path "${normalizedPath}" escapes home directory "${normalizedHome}"`,
      );
    }
  }

  // Reject paths that resolve to sensitive system directories
  // This is the primary defense against malicious path traversal
  const sensitivePaths = [
    '/etc',
    '/proc',
    '/sys',
    '/dev',
    '/boot',
    '/root',
    '/var/log',
  ];
  const normalizedPath = resolve(absolutePath);

  for (const sensitivePath of sensitivePaths) {
    if (
      normalizedPath === sensitivePath ||
      normalizedPath.startsWith(`${sensitivePath}/`)
    ) {
      throw new Error(
        `Access to sensitive system directory not allowed: ${sensitivePath}`,
      );
    }
  }

  // Block paths that attempt to access system binaries
  if (
    normalizedPath.startsWith('/bin/') ||
    normalizedPath.startsWith('/sbin/') ||
    normalizedPath.startsWith('/usr/bin/') ||
    normalizedPath.startsWith('/usr/sbin/')
  ) {
    throw new Error('Access to system binary directories not allowed');
  }
}

/**
 * Resolve local path to absolute path
 *
 * Handles:
 * - Relative paths (./path, ../path)
 * - Absolute paths (/path)
 * - Home directory (~/)
 *
 * Includes path traversal protection to prevent malicious paths
 */
export async function resolveLocalPath(localPath: string): Promise<string> {
  let absolutePath: string;

  // Expand home directory (~) if present
  if (localPath.startsWith('~')) {
    absolutePath = expandHomeDirectory(localPath);
  } else if (localPath.startsWith('/')) {
    // Already absolute
    absolutePath = localPath;
  } else {
    // Relative to current working directory
    absolutePath = resolve(process.cwd(), localPath);
  }

  // Validate path for traversal attacks
  validateResolvedPath(absolutePath, localPath);

  // Verify directory exists
  try {
    await access(absolutePath);
  } catch {
    throw new Error(`Local template path does not exist: ${absolutePath}`);
  }

  return absolutePath;
}

/**
 * Load template configuration from local directory
 */
export async function loadLocalTemplate(
  resolvedPath: string,
): Promise<TemplateConfig> {
  // Look for template.config.{js,ts}
  let configPath: string | null = null;

  for (const ext of ['js', 'ts']) {
    const testPath = join(resolvedPath, `template.config.${ext}`);
    try {
      await access(testPath);
      configPath = testPath;
      break;
    } catch {
      // Try next extension
    }
  }

  if (!configPath) {
    throw new Error(
      `No template.config.js or template.config.ts found in ${resolvedPath}`,
    );
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
