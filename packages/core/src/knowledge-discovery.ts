/** Filesystem-only discovery shared by docs snapshots and knowledge indexing. */
import type { Dirent } from 'node:fs';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

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
