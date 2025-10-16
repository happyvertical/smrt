/**
 * Git Repository Template Loader
 *
 * Downloads templates from git repositories without full git history.
 * Similar to degit - downloads tarball of latest commit.
 *
 * Supports:
 * - github:user/repo
 * - github:user/repo/subdir#ref
 * - gitlab:user/repo
 * - https://github.com/user/repo.git
 * - https://github.com/user/repo.git#ref:subdir
 * - git@github.com:user/repo.git#ref:subdir
 *
 * Subdirectory syntax:
 * - Shorthand: github:user/repo/path/to/subdir
 * - Full URL: https://github.com/user/repo.git#branch:path/to/subdir
 */

import { mkdir, rm } from 'node:fs/promises';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { extract } from 'tar';
import type { TemplateConfig } from './template-loader.js';

// Track temp directories for cleanup on process exit
const tempDirectories = new Set<string>();
let cleanupHandlersRegistered = false;

/**
 * Register cleanup handlers for temporary directories
 * Ensures temp directories are removed on process termination
 */
function registerCleanupHandlers() {
  if (cleanupHandlersRegistered) return;
  cleanupHandlersRegistered = true;

  const cleanup = async () => {
    if (tempDirectories.size === 0) return;

    const dirs = Array.from(tempDirectories);
    await Promise.all(
      dirs.map(async (dir) => {
        try {
          await rm(dir, { recursive: true, force: true });
          tempDirectories.delete(dir);
        } catch (_error) {
          // Ignore cleanup errors - directory may already be removed
        }
      }),
    );
  };

  // Clean up on normal exit
  process.on('exit', () => {
    // Synchronous cleanup not ideal, but exit is synchronous
    // Most cleanup happens via other handlers
  });

  // Clean up on termination signals
  process.on('SIGINT', async () => {
    await cleanup();
    process.exit(130); // Standard exit code for SIGINT
  });

  process.on('SIGTERM', async () => {
    await cleanup();
    process.exit(143); // Standard exit code for SIGTERM
  });

  // Clean up on uncaught exceptions
  process.on('uncaughtException', async (error) => {
    await cleanup();
    throw error;
  });
}

interface GitRepo {
  host: 'github' | 'gitlab' | 'bitbucket';
  user: string;
  repo: string;
  ref: string; // branch, tag, or commit
  subdir?: string; // subdirectory within repo
}

/**
 * Parse git URL to repository information
 *
 * Supports subdirectories via:
 * - github:user/repo/subdir#ref
 * - https://github.com/user/repo.git#ref:subdir
 * - git@github.com:user/repo.git#ref:subdir
 */
function parseGitUrl(url: string): GitRepo {
  let host: 'github' | 'gitlab' | 'bitbucket';
  let user: string;
  let repo: string;
  let ref = 'HEAD'; // default to latest
  let subdir: string | undefined;

  // Handle shorthand: github:user/repo/subdir#ref
  if (url.startsWith('github:')) {
    host = 'github';
    const parts = url.slice(7).split('/');
    user = parts[0];

    // Check for ref in second part
    const repoAndRef = parts[1]?.split('#') || ['', ''];
    repo = repoAndRef[0];
    if (repoAndRef[1]) ref = repoAndRef[1];

    // Remaining parts are subdirectory
    if (parts.length > 2) {
      subdir = parts.slice(2).join('/');
    }
  } else if (url.startsWith('gitlab:')) {
    host = 'gitlab';
    const parts = url.slice(7).split('/');
    user = parts[0];

    const repoAndRef = parts[1]?.split('#') || ['', ''];
    repo = repoAndRef[0];
    if (repoAndRef[1]) ref = repoAndRef[1];

    if (parts.length > 2) {
      subdir = parts.slice(2).join('/');
    }
  } else if (url.startsWith('bitbucket:')) {
    host = 'bitbucket';
    const parts = url.slice(10).split('/');
    user = parts[0];

    const repoAndRef = parts[1]?.split('#') || ['', ''];
    repo = repoAndRef[0];
    if (repoAndRef[1]) ref = repoAndRef[1];

    if (parts.length > 2) {
      subdir = parts.slice(2).join('/');
    }
  }
  // Handle HTTPS URLs
  else if (url.includes('github.com')) {
    host = 'github';
    const match = url.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
    if (!match) throw new Error(`Invalid GitHub URL: ${url}`);
    user = match[1];
    repo = match[2].replace(/\.git$/, '');

    // Extract ref and subdir from hash: #ref:subdir or #ref
    const refMatch = url.match(/#(.+)$/);
    if (refMatch) {
      const refParts = refMatch[1].split(':');
      ref = refParts[0];
      if (refParts[1]) subdir = refParts[1];
    }
  } else if (url.includes('gitlab.com')) {
    host = 'gitlab';
    const match = url.match(/gitlab\.com[:/]([^/]+)\/([^/.]+)/);
    if (!match) throw new Error(`Invalid GitLab URL: ${url}`);
    user = match[1];
    repo = match[2].replace(/\.git$/, '');

    const refMatch = url.match(/#(.+)$/);
    if (refMatch) {
      const refParts = refMatch[1].split(':');
      ref = refParts[0];
      if (refParts[1]) subdir = refParts[1];
    }
  } else if (url.includes('bitbucket.org')) {
    host = 'bitbucket';
    const match = url.match(/bitbucket\.org[:/]([^/]+)\/([^/.]+)/);
    if (!match) throw new Error(`Invalid Bitbucket URL: ${url}`);
    user = match[1];
    repo = match[2].replace(/\.git$/, '');

    const refMatch = url.match(/#(.+)$/);
    if (refMatch) {
      const refParts = refMatch[1].split(':');
      ref = refParts[0];
      if (refParts[1]) subdir = refParts[1];
    }
  } else {
    throw new Error(`Unsupported git URL: ${url}`);
  }

  return { host, user, repo, ref, subdir };
}

/**
 * Get tarball URL for repository
 */
function getTarballUrl(repo: GitRepo): string {
  switch (repo.host) {
    case 'github':
      return `https://github.com/${repo.user}/${repo.repo}/archive/${repo.ref}.tar.gz`;
    case 'gitlab':
      return `https://gitlab.com/${repo.user}/${repo.repo}/-/archive/${repo.ref}/${repo.repo}-${repo.ref}.tar.gz`;
    case 'bitbucket':
      return `https://bitbucket.org/${repo.user}/${repo.repo}/get/${repo.ref}.tar.gz`;
    default:
      throw new Error(`Unsupported git host: ${repo.host}`);
  }
}

/**
 * Validate redirect URL to prevent SSRF attacks
 * Only allow redirects to trusted git hosting services
 */
function validateRedirectUrl(redirectUrl: string): void {
  try {
    const url = new URL(redirectUrl);

    // Only allow HTTPS protocol
    if (url.protocol !== 'https:') {
      throw new Error(
        `Invalid redirect protocol: ${url.protocol} (only https: allowed)`,
      );
    }

    // Only allow trusted git hosting services
    const trustedHosts = [
      'github.com',
      'www.github.com',
      'codeload.github.com',
      'gitlab.com',
      'www.gitlab.com',
      'bitbucket.org',
      'www.bitbucket.org',
    ];

    if (!trustedHosts.includes(url.hostname)) {
      throw new Error(`Redirect to untrusted host: ${url.hostname}`);
    }

    // Reject redirects to localhost or internal IPs
    if (
      url.hostname === 'localhost' ||
      url.hostname === '127.0.0.1' ||
      url.hostname.startsWith('192.168.') ||
      url.hostname.startsWith('10.') ||
      url.hostname.startsWith('172.')
    ) {
      throw new Error(
        `Redirect to internal/local address not allowed: ${url.hostname}`,
      );
    }
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error(`Invalid redirect URL format: ${redirectUrl}`);
    }
    throw error;
  }
}

/**
 * Download and extract git repository tarball
 */
async function downloadTarball(url: string, dest: string): Promise<string> {
  const REQUEST_TIMEOUT = 30000; // 30 seconds
  const MAX_TARBALL_SIZE = 100 * 1024 * 1024; // 100 MB

  return new Promise((resolve, reject) => {
    let timedOut = false;
    let receivedBytes = 0;

    const req = https.get(url, (response) => {
      // Handle redirects
      if (response.statusCode === 301 || response.statusCode === 302) {
        const redirectUrl = response.headers.location;
        if (!redirectUrl) {
          return reject(new Error('Redirect without location header'));
        }

        // Validate redirect URL before following
        try {
          validateRedirectUrl(redirectUrl);
        } catch (error) {
          return reject(error);
        }

        return downloadTarball(redirectUrl, dest).then(resolve, reject);
      }

      if (response.statusCode !== 200) {
        return reject(
          new Error(`Failed to download tarball: HTTP ${response.statusCode}`),
        );
      }

      // Monitor response size
      response.on('data', (chunk) => {
        receivedBytes += chunk.length;
        if (receivedBytes > MAX_TARBALL_SIZE) {
          response.destroy(new Error('Tarball size exceeds limit'));
        }
      });

      // Extract tarball to destination
      const extractStream = extract({
        cwd: dest,
        strip: 1, // Remove top-level directory from tarball
      });

      response.pipe(extractStream);

      extractStream.on('finish', () => resolve(dest));
      extractStream.on('error', (err) => {
        response.destroy();
        reject(err);
      });
    });

    req.setTimeout(REQUEST_TIMEOUT, () => {
      timedOut = true;
      req.destroy(new Error('Request timed out'));
    });

    req.on('error', (err) => {
      if (timedOut) {
        reject(new Error('Request timed out'));
      } else {
        reject(err);
      }
    });
  });
}

/**
 * Load template from git repository
 */
export async function loadGitTemplate(gitUrl: string): Promise<TemplateConfig> {
  // Register cleanup handlers (only once)
  registerCleanupHandlers();

  // Parse git URL
  const repo = parseGitUrl(gitUrl);

  // Create temporary directory
  const tempDir = join(
    tmpdir(),
    `smrt-template-${repo.user}-${repo.repo}-${Date.now()}`,
  );
  await mkdir(tempDir, { recursive: true });

  // Track temp directory for cleanup
  tempDirectories.add(tempDir);

  try {
    // Download and extract tarball
    const tarballUrl = getTarballUrl(repo);
    console.log(
      `Downloading template from ${repo.host}:${repo.user}/${repo.repo}...`,
    );
    await downloadTarball(tarballUrl, tempDir);

    // Load template config
    const templateDir = repo.subdir ? join(tempDir, repo.subdir) : tempDir;
    const configPath = join(templateDir, 'template.config.js');

    // Try to load config
    try {
      const configUrl = pathToFileURL(configPath).href;
      const module = await import(configUrl);
      const config = module.default || module;

      // Validate
      validateTemplateConfig(config, configPath);

      // Store temp directory in config for later cleanup
      (config as any).__tempDir = tempDir;

      return config;
    } catch (_error) {
      // Try .ts extension
      try {
        const tsConfigPath = join(templateDir, 'template.config.ts');
        const configUrl = pathToFileURL(tsConfigPath).href;
        const module = await import(configUrl);
        const config = module.default || module;

        validateTemplateConfig(config, tsConfigPath);
        (config as any).__tempDir = tempDir;

        return config;
      } catch {
        throw new Error(
          `No template.config.js or template.config.ts found in ${gitUrl}`,
        );
      }
    }
  } catch (error) {
    // Cleanup temp directory on error
    await rm(tempDir, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Get the template directory path (for copying overlay files)
 */
export function getGitTemplateDir(config: TemplateConfig): string {
  const tempDir = (config as any).__tempDir;
  if (!tempDir) {
    throw new Error('Template was not loaded from git repository');
  }
  return tempDir;
}

/**
 * Cleanup temporary directory after template is used
 */
export async function cleanupGitTemplate(
  config: TemplateConfig,
): Promise<void> {
  const tempDir = (config as any).__tempDir;
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
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
