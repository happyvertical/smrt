/** Filesystem-only discovery shared by docs snapshots and knowledge indexing. */
import type { Dirent } from 'node:fs';
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import type { DomainKnowledgeModuleDoc } from '@happyvertical/smrt-types';

export interface ScopedPackageDirectory {
  /** Scope entry name; consumers may select by alias rather than manifest name. */
  name: string;
  /** Original node_modules path, retained for workspace-relative reporting. */
  directory: string;
  /** Resolved path for identity comparisons or absolute snapshot links. */
  realDirectory: string;
}

/**
 * Enumerate scope entries without descending into pnpm's linked dependency graph.
 * Selection, workspace discovery and enrichment remain caller policies.
 */
export function discoverScopedPackageDirectories(
  scopeDirectories: string[],
): ScopedPackageDirectory[] {
  const packages: ScopedPackageDirectory[] = [];
  for (const scopeDirectory of new Set(scopeDirectories)) {
    let entries: Dirent[];
    try {
      entries = readdirSync(scopeDirectory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const directory = join(scopeDirectory, entry.name);
      try {
        packages.push({
          name: entry.name,
          directory,
          realDirectory: realpathSync(directory),
        });
      } catch {
        // Dangling links are not installed packages.
      }
    }
  }
  return packages;
}

/** Read authored docs only; never load artifacts, package code or object scans. */
export function readPackageAgentDoc(
  directory: string,
  options: { inspectAdapter?: boolean } = {},
) {
  const agentsPath = join(directory, 'AGENTS.md');
  const claudePath = join(directory, 'CLAUDE.md');
  const hasAgentsMd = existsSync(agentsPath);
  const hasClaudeMd = existsSync(claudePath);
  const agentsContent = hasAgentsMd ? readFileSync(agentsPath, 'utf8') : '';
  const claudeContent =
    hasClaudeMd && (!hasAgentsMd || options.inspectAdapter)
      ? readFileSync(claudePath, 'utf8')
      : '';
  const hasClaudeShim = hasClaudeMd && claudeContent.trim() === '@AGENTS.md';
  const source: 'AGENTS.md' | 'CLAUDE.md' | null = hasAgentsMd
    ? 'AGENTS.md'
    : hasClaudeMd && !hasClaudeShim
      ? 'CLAUDE.md'
      : null;
  return {
    hasAgentsMd,
    hasClaudeMd,
    hasClaudeShim,
    agentsContent,
    claudeContent,
    source,
    content: hasAgentsMd ? agentsContent : source ? claudeContent : null,
  };
}

const MARKDOWN_MD_LINK =
  /\[[^\]]*\]\(\s*([^)\s#]+\.md)(?:#[^)]*)?(?:\s+"[^"]*")?\s*\)/g;

export const MODULE_DOC_HASH_PREFIX = 'moduleDoc:';
export const AGENT_SURFACE_HASH_PREFIX = 'agentSurface:';

/** Resolve in-package Markdown module docs linked from an authored agent doc. */
export function resolveAgentModuleDocPaths(
  rootDir: string,
  agentDoc: string | undefined,
): string[] {
  if (!agentDoc) return [];
  const root = resolve(rootDir);
  const paths: string[] = [];
  for (const match of agentDoc.matchAll(MARKDOWN_MD_LINK)) {
    const target = match[1];
    if (target.includes('://')) continue;
    const absolute = resolve(root, target);
    if (absolute !== root && !absolute.startsWith(root + sep)) continue;
    const relativePath = relative(root, absolute).split(sep).join('/');
    if (relativePath === 'AGENTS.md' || relativePath === 'CLAUDE.md') continue;
    if (paths.includes(relativePath)) continue;
    if (!existsSync(absolute) || !statSync(absolute).isFile()) continue;
    paths.push(relativePath);
  }
  return paths;
}

/** Read the module docs accepted by {@link resolveAgentModuleDocPaths}. */
export function readAgentModuleDocs(
  rootDir: string,
  agentDoc: string | undefined,
): DomainKnowledgeModuleDoc[] {
  return resolveAgentModuleDocPaths(rootDir, agentDoc).map((path) => ({
    path,
    module: basename(path, '.md'),
    content: readFileSync(join(rootDir, path), 'utf8'),
  }));
}
