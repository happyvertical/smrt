/**
 * Workspace-root resolution for `docs:agents` (#4734).
 *
 * pnpm installs per workspace member, so the root of a consumer monorepo has no
 * `node_modules/@happyvertical`. The command therefore resolves a documentation
 * root (where the framework file, the bundle and the skills are written) and the
 * set of directories whose `node_modules` are searched.
 *
 * Not `detectMonorepoRoot()`: that is the smrt repository's own detector (root
 * AGENTS.md plus `packages/`). A consumer workspace root is any ancestor with a
 * `pnpm-workspace.yaml` that is not the smrt repository itself.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { discoverScopedPackageDirectories } from '@happyvertical/smrt-core/knowledge';
import { listConsumerWorkspaceInstallRoots } from '@happyvertical/smrt-dev-mcp/knowledge';

export interface DocsRoot {
  /** Directory the framework file, bundle and skills are written under. */
  root: string;
  /** Directories whose `node_modules/@happyvertical` are searched, root first. */
  installRoots: string[];
  /** True when `root` is a consumer pnpm workspace root. */
  workspace: boolean;
  /** True when the command ran below the workspace root and was lifted to it. */
  liftedFromMember: boolean;
}

/**
 * Resolves where `docs:agents` operates.
 *
 * - `here` keeps today's behaviour: `cwd` alone.
 * - Otherwise the nearest ancestor of `cwd` (inclusive) holding
 *   `pnpm-workspace.yaml` is the root, unless it is the smrt repository, whose
 *   existing cwd-relative behaviour is unchanged, or `cwd` is neither that root
 *   nor inside one of its members (a stray directory under a workspace that
 *   does not include it stays local).
 * - With no workspace, `cwd` alone.
 */
export function resolveDocsRoot(options: {
  cwd: string;
  here?: boolean;
}): DocsRoot {
  const local: DocsRoot = {
    root: options.cwd,
    installRoots: [options.cwd],
    workspace: false,
    liftedFromMember: false,
  };
  if (options.here) return local;

  let start: string;
  try {
    start = realpathSync(options.cwd);
  } catch {
    return local;
  }
  for (let dir = start; ; ) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) {
      if (isSmrtRepositoryRoot(dir)) return local;
      const installRoots = listConsumerWorkspaceInstallRoots(dir);
      // A workspace file only claims directories that belong to it.
      if (!isWorkspaceMember(start, dir, installRoots)) return local;
      return {
        root: dir,
        installRoots,
        workspace: true,
        liftedFromMember: dir !== start,
      };
    }
    const parent = dirname(dir);
    if (parent === dir) return local;
    dir = parent;
  }
}

/** True when `start` is `root`, a member, or nested inside a member (up to `root`). */
function isWorkspaceMember(
  start: string,
  root: string,
  installRoots: string[],
): boolean {
  if (start === root) return true;
  const members = new Set<string>();
  for (const installRoot of installRoots) {
    try {
      if (installRoot === root) continue;
      members.add(realpathSync(installRoot));
    } catch {
      // A member that cannot be resolved cannot contain cwd.
    }
  }
  for (let dir = start; ; ) {
    if (members.has(dir)) return true;
    if (dir === root) return false;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

function isSmrtRepositoryRoot(dir: string): boolean {
  try {
    return (
      JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8')).name ===
      '@happyvertical/smrt'
    );
  } catch {
    return false;
  }
}

/** One `@happyvertical/*` scope entry found under a single install root. */
export interface WorkspacePackageEntry {
  /** Scope entry name (`smrt-core`), which differs from the manifest under an alias. */
  name: string;
  realDirectory: string;
  /** Install root it was found under, relative to the docs root (`.` for the root). */
  location: string;
}

/**
 * Lists `@happyvertical/*` scope entries from every install root, in install
 * root order. The same package reached from several members appears once per
 * member; merging by name and version is the caller's job.
 */
export function collectWorkspacePackageEntries(
  docsRoot: Pick<DocsRoot, 'root' | 'installRoots'>,
): WorkspacePackageEntry[] {
  const entries: WorkspacePackageEntry[] = [];
  for (const installRoot of docsRoot.installRoots) {
    const location = relative(docsRoot.root, installRoot) || '.';
    for (const entry of discoverScopedPackageDirectories([
      join(installRoot, 'node_modules', '@happyvertical'),
    ])) {
      entries.push({
        name: entry.name,
        realDirectory: entry.realDirectory,
        location,
      });
    }
  }
  return entries;
}
