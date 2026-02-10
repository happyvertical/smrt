/**
 * Server-side manifest utilities for SMRT agents
 *
 * Provides functions to extract and register agent manifests on the server,
 * where the Vite virtual module (`virtual:smrt-agent-registrations`) doesn't run.
 *
 * @module @happyvertical/smrt-agents/server
 */

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { type AgentManifestInfo, AgentUIRegistry } from '../ui.js';

/**
 * Shape of a package manifest's `objects` entry
 */
interface ManifestObject {
  className: string;
  agent?: AgentManifestInfo;
  [key: string]: unknown;
}

/**
 * Shape of a package manifest JSON file
 */
export interface PackageManifest {
  objects: Record<string, ManifestObject>;
  [key: string]: unknown;
}

/**
 * Extract the AgentManifestInfo from a package manifest by class name.
 *
 * Iterates `manifest.objects` looking for the entry whose `className` matches
 * and has an `agent` metadata block.
 *
 * @param manifest - Parsed manifest JSON from a package
 * @param agentClass - Agent class name to search for (e.g., 'Praeco')
 * @returns The agent manifest info, or null if not found
 */
export function extractAgentManifest(
  manifest: PackageManifest,
  agentClass: string,
): AgentManifestInfo | null {
  for (const obj of Object.values(manifest.objects)) {
    if (obj.className === agentClass && obj.agent) {
      return obj.agent;
    }
  }
  return null;
}

/**
 * Load and register agent manifests from a list of package names.
 *
 * For each package, resolves its `<package>/manifest` export via `createRequire`,
 * reads the manifest JSON, extracts the agent class and metadata, and registers
 * with `AgentUIRegistry`.
 *
 * @param packages - Array of package names (e.g., ['@happyvertical/praeco'])
 * @param projectRoot - Absolute path to the project root (for require resolution)
 * @returns Map of agentClass -> AgentManifestInfo for successfully loaded agents
 */
export function loadManifestsFromPackages(
  packages: string[],
  projectRoot: string,
): Map<string, AgentManifestInfo> {
  const result = new Map<string, AgentManifestInfo>();
  const localRequire = createRequire(resolve(projectRoot, 'package.json'));

  for (const pkg of packages) {
    try {
      const manifestPath = localRequire.resolve(`${pkg}/manifest`);
      const manifestContent = readFileSync(manifestPath, 'utf-8');
      const manifest: PackageManifest = JSON.parse(manifestContent);

      // Find the agent object (one with agent metadata)
      for (const obj of Object.values(manifest.objects)) {
        if (obj.agent) {
          const agentClass = obj.className;
          AgentUIRegistry.registerManifest(agentClass, obj.agent);
          result.set(agentClass, obj.agent);
          break;
        }
      }
    } catch {
      console.warn(
        `[smrt-agents/server] Could not load manifest for ${pkg} — skipping`,
      );
    }
  }

  return result;
}

/**
 * Extract agent package names from a smrt.config.js file.
 *
 * Reads the file, finds the `agents: [...]` array, strips comments,
 * and extracts quoted package names. Same logic as the Vite plugin.
 *
 * @param configPath - Absolute path to smrt.config.js
 * @returns Array of package name strings
 */
export function extractAgentPackagesFromConfig(configPath: string): string[] {
  const configContent = readFileSync(configPath, 'utf-8');
  const agentMatches = configContent.match(/agents\s*:\s*\[([^\]]*)\]/s);
  if (!agentMatches) return [];

  const agentsBlock = agentMatches[1];
  const withoutComments = agentsBlock.replace(/\/\/.*$/gm, '');
  return [...withoutComments.matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
}

/**
 * Load and register agent manifests by reading smrt.config.js.
 *
 * One-call setup: reads the config file to discover agent packages,
 * then loads and registers manifests for each. Idempotent — safe to
 * call from multiple server load functions.
 *
 * @param configPath - Path to smrt.config.js (default: `<projectRoot>/smrt.config.js`)
 * @param projectRoot - Project root for require resolution (default: `process.cwd()`)
 * @returns Map of agentClass -> AgentManifestInfo
 */
export function loadManifestsFromConfig(
  configPath?: string,
  projectRoot?: string,
): Map<string, AgentManifestInfo> {
  const root = projectRoot || process.cwd();
  const resolvedConfigPath = configPath || resolve(root, 'smrt.config.js');

  if (!existsSync(resolvedConfigPath)) {
    console.warn(
      `[smrt-agents/server] Config file not found: ${resolvedConfigPath}`,
    );
    return new Map();
  }

  const packages = extractAgentPackagesFromConfig(resolvedConfigPath);
  if (packages.length === 0) {
    console.warn(
      `[smrt-agents/server] No agents found in config: ${resolvedConfigPath}`,
    );
    return new Map();
  }

  return loadManifestsFromPackages(packages, root);
}
