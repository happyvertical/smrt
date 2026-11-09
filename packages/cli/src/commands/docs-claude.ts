/**
 * docs:agents / docs:claude commands
 *
 * Generates downstream SMRT framework context from installed @happyvertical
 * packages. AGENTS.md is canonical; docs:claude remains a compatibility alias
 * that writes to the historical .claude/smrt-framework.md path.
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  readAgentModuleDocs,
  readPackageAgentDoc,
  resolveAgentModuleDocPaths,
} from '@happyvertical/smrt-core/knowledge';
import { compareVersions } from '@happyvertical/smrt-dev-mcp/knowledge';
import type { DomainKnowledgeModuleDoc } from '@happyvertical/smrt-types';
import type { CLICommand } from '../cli-generator.js';
import {
  collectWorkspacePackageEntries,
  type DocsRoot,
  type WorkspacePackageEntry,
} from './docs-workspace.js';

export interface PackageInfo {
  name: string;
  version: string;
  readme: string | null;
  agentMd?: string | null;
  /** Backward-compatible alias for older tests/importers. */
  claudeMd?: string | null;
  docSource?: 'AGENTS.md' | 'CLAUDE.md' | null;
  /** Linked module bodies, loaded only for complete snapshots. */
  moduleDocs?: DomainKnowledgeModuleDoc[];
  /** Package directory for resolving authored documentation from the snapshot. */
  directory?: string;
  /** Module paths without loading their bodies in the default snapshot. */
  moduleDocPaths?: string[];
  /**
   * Installed specifier (`node_modules/<scope>/<entry>`), which differs from
   * `name` under an `npm:` alias install. Module-doc links use it so they
   * resolve from the consumer's `node_modules`.
   */
  specifier?: string;
  /**
   * Set only when pnpm workspace members install different versions of this
   * package: every distinct version (ascending) with the install roots (relative
   * to the docs root, `.` for the root) that hold it. `version` is then the
   * highest, and the exported knowledge page is that version's.
   */
  versionLocations?: Array<{ version: string; locations: string[] }>;
}

export interface RootDocInfo {
  filename: string;
  heading: string;
  content: string;
}

interface DocsCommandOptions {
  commandName: 'docs:agents' | 'docs:claude';
  description: string;
  defaultOutput: string;
  generatedBy: string;
  deprecated?: boolean;
}

/**
 * Parsed option bag for the docs:agents / docs:claude handler. The CLI parser
 * produces `Record<string, unknown>`; this narrows the flags the command reads.
 */
interface DocsHandlerOptions {
  output?: string;
  'dry-run'?: boolean;
  complete?: boolean;
  'no-install-skills'?: boolean;
  'no-agents-block'?: boolean;
  here?: boolean;
}

function createDocsCommand(config: DocsCommandOptions): CLICommand {
  return {
    name: config.commandName,
    description: config.description,
    aliases:
      config.commandName === 'docs:agents' ? ['agents-docs'] : ['claude-docs'],
    args: [],
    options: {
      output: {
        type: 'string',
        description: `Output file path (default: ${config.defaultOutput})`,
        short: 'o',
      },
      complete: {
        type: 'boolean',
        description: 'Include every linked module document in the snapshot',
        default: false,
      },
      'no-install-skills': {
        type: 'boolean',
        description:
          'Do not install the smrt agent skills into .claude/skills and .agents/skills (installed by default)',
        default: false,
      },
      'no-agents-block': {
        type: 'boolean',
        description:
          'Do not insert or refresh the smrt block (between <!-- smrt:agents:begin --> markers) in AGENTS.md',
        default: false,
      },
      here: {
        type: 'boolean',
        description:
          'Run in the current directory only; do not resolve a pnpm workspace root',
        default: false,
      },
      'dry-run': {
        type: 'boolean',
        description: 'Print to stdout without writing file',
        default: false,
        short: 'd',
      },
    },
    handler: async (_args: string[], options: DocsHandlerOptions) => {
      try {
        if (config.deprecated) {
          console.warn(
            '⚠️  smrt docs:claude is deprecated; use smrt docs:agents. This command still writes Claude-compatible output.',
          );
        }

        // Loaded lazily: docs-refresh imports this module's generators.
        const { refreshAgentDocs } = await import('./docs-refresh.js');
        const result = await refreshAgentDocs({
          cwd: process.cwd(),
          mode: 'write',
          dryRun: options['dry-run'],
          here: options.here,
          complete: options.complete,
          skills: !options['no-install-skills'],
          agentsBlock: !options['no-agents-block'],
          output: options.output,
          defaultOutput: config.defaultOutput,
          generatedBy: config.generatedBy,
        });

        if (result.status === 'skipped-nothing-installed') {
          console.log('\n⚠️  No @happyvertical packages found in node_modules');
          console.log(
            '   Make sure packages are installed before running this command.\n',
          );
          process.exit(1);
        }
        if (result.status === 'failed' && result.failure) {
          console.error(`\n❌ ${result.failure.message}`);
          for (const line of result.failure.details ?? []) {
            console.error(`   ${line}`);
          }
          process.exit(1);
        }
      } catch (error) {
        console.error('\n❌ Failed to generate agent documentation:');
        if (error instanceof Error) {
          console.error(`   ${error.message}`);
        }
        process.exit(1);
      }
    },
  };
}

export const docsAgentsCommand: CLICommand = createDocsCommand({
  commandName: 'docs:agents',
  description:
    'Generate .agents/smrt-framework.md from installed SMRT packages',
  defaultOutput: '.agents/smrt-framework.md',
  generatedBy: 'smrt docs:agents',
});

export const docsClaudeCommand: CLICommand = createDocsCommand({
  commandName: 'docs:claude',
  description:
    'Deprecated alias for docs:agents that writes .claude/smrt-framework.md',
  defaultOutput: '.claude/smrt-framework.md',
  generatedBy: 'smrt docs:claude',
  deprecated: true,
});

/**
 * Resolves the packages `docs:agents` documents: every installed
 * `@happyvertical/*` package across the docs root's install roots (the cwd
 * alone outside a pnpm workspace; the workspace root plus every member inside
 * one). Reusable by later steps that already hold a resolved {@link DocsRoot}.
 */
export async function collectWorkspacePackages(
  docsRoot: Pick<DocsRoot, 'root' | 'installRoots'>,
  complete = false,
): Promise<{ packages: PackageInfo[]; sdkPackages: PackageInfo[] }> {
  const entries = collectWorkspacePackageEntries(docsRoot);
  return {
    packages: await discoverInstalledPackages(entries, complete, docsRoot.root),
    sdkPackages: discoverSdkPackages(entries, complete),
  };
}

/**
 * Discover installed @happyvertical/smrt-* packages.
 * Checks both node_modules and workspace packages directory.
 */
async function discoverInstalledPackages(
  installedDirectories: WorkspacePackageEntry[],
  complete = false,
  root = process.cwd(),
): Promise<PackageInfo[]> {
  const found: Array<{ pkg: PackageInfo; location: string }> = [];
  const { readdirSync } = await import('node:fs');

  for (const entry of installedDirectories) {
    if (!entry.name.startsWith('smrt-')) continue;
    const pkg = loadPackageInfo(
      entry.realDirectory,
      entry.name,
      complete,
      `@happyvertical/${entry.name}`,
    );
    if (pkg) found.push({ pkg, location: entry.location });
  }
  const packages = mergePackageVersions(found);

  if (packages.length === 0) {
    const workspacePath = join(root, 'packages');
    const pnpmWorkspacePath = join(root, 'pnpm-workspace.yaml');

    if (existsSync(workspacePath) && existsSync(pnpmWorkspacePath)) {
      const entries = readdirSync(workspacePath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const packagePath = join(workspacePath, entry.name);
        const packageJsonPath = join(packagePath, 'package.json');
        if (!existsSync(packageJsonPath)) continue;

        try {
          const packageJson = JSON.parse(
            readFileSync(packageJsonPath, 'utf-8'),
          );
          if (!packageJson.name?.startsWith('@happyvertical/smrt-')) continue;

          const pkg = loadPackageInfo(packagePath, entry.name, complete);
          if (pkg) packages.push(pkg);
        } catch {
          // Skip invalid package.json.
        }
      }
    }
  }

  return packages.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Discover installed @happyvertical/* SDK packages (non-smrt).
 */
function discoverSdkPackages(
  installedDirectories: WorkspacePackageEntry[],
  complete = false,
): PackageInfo[] {
  const found: Array<{ pkg: PackageInfo; location: string }> = [];
  for (const entry of installedDirectories) {
    if (entry.name.startsWith('smrt-') || entry.name === 'smrt') continue;
    const pkg = loadPackageInfo(
      entry.realDirectory,
      entry.name,
      complete,
      `@happyvertical/${entry.name}`,
    );
    if (pkg) found.push({ pkg, location: entry.location });
  }
  return mergePackageVersions(found);
}

/**
 * Collapses one package installed in several workspace members into a single
 * entry. Identical name+version (same specifier) dedupe; differing versions keep
 * one entry carrying the highest version, with every version and the install
 * roots holding it in `versionLocations`. Output is sorted by name.
 */
function mergePackageVersions(
  found: Array<{ pkg: PackageInfo; location: string }>,
): PackageInfo[] {
  const groups = new Map<
    string,
    Map<string, { pkg: PackageInfo; locations: Set<string> }>
  >();
  for (const { pkg, location } of found) {
    const key = `${pkg.name}\0${pkg.specifier ?? pkg.name}`;
    const versions = groups.get(key) ?? new Map();
    const existing = versions.get(pkg.version);
    if (existing) existing.locations.add(location);
    else versions.set(pkg.version, { pkg, locations: new Set([location]) });
    groups.set(key, versions);
  }

  const merged: PackageInfo[] = [];
  for (const versions of groups.values()) {
    const ascending = [...versions.entries()].sort(([a], [b]) =>
      compareVersions(a, b),
    );
    const primary = ascending[ascending.length - 1][1].pkg;
    if (ascending.length > 1) {
      primary.versionLocations = ascending.map(([version, entry]) => ({
        version,
        locations: [...entry.locations].sort(),
      }));
    }
    merged.push(primary);
  }
  return merged.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Version cell of the package tables: the plain version, or under workspace
 * version skew `1.2.0 (apps/a), 1.3.0 (apps/b, apps/c)` (ascending versions,
 * sorted install roots, `.` for the workspace root).
 */
export function formatPackageVersion(pkg: PackageInfo): string {
  if (!pkg.versionLocations) return pkg.version;
  return pkg.versionLocations
    .map(({ version, locations }) => `${version} (${locations.join(', ')})`)
    .join(', ');
}

function loadPackageInfo(
  packagePath: string,
  dirName: string,
  complete: boolean,
  specifier?: string,
): PackageInfo | null {
  const packageJsonPath = join(packagePath, 'package.json');
  if (!existsSync(packageJsonPath)) {
    return null;
  }

  try {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
    const readmePath = join(packagePath, 'README.md');
    const agentDoc = readPackageAgentDoc(packagePath);

    const info: PackageInfo = {
      name: packageJson.name,
      version: packageJson.version,
      readme: existsSync(readmePath) ? readFileSync(readmePath, 'utf-8') : null,
      agentMd: agentDoc.content,
      claudeMd: agentDoc.content,
      docSource: agentDoc.source,
      directory: packagePath,
      specifier: specifier ?? packageJson.name,
      moduleDocPaths:
        agentDoc.source === 'AGENTS.md'
          ? resolveAgentModuleDocPaths(
              packagePath,
              agentDoc.content ?? undefined,
            )
          : [],
      moduleDocs:
        complete && agentDoc.source === 'AGENTS.md'
          ? readAgentModuleDocs(packagePath, agentDoc.content ?? undefined)
          : [],
    };

    return info;
  } catch {
    console.warn(`   ⚠️  Could not read package.json for ${dirName}`);
    return null;
  }
}

/**
 * Whether `root` is the smrt repository itself (not just any pnpm monorepo):
 * only its root package is named `@happyvertical/smrt`.
 */
export function isSmrtRepository(root: string | null): boolean {
  if (!root) return false;
  try {
    return (
      JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')).name ===
      '@happyvertical/smrt'
    );
  } catch {
    return false;
  }
}

export function detectMonorepoRoot(start = process.cwd()): string | null {
  try {
    let currentDir = realpathSync(start);

    for (;;) {
      const pnpmWorkspace = join(currentDir, 'pnpm-workspace.yaml');
      const packagesDir = join(currentDir, 'packages');
      const rootAgentsMd = join(currentDir, 'AGENTS.md');

      if (
        existsSync(pnpmWorkspace) &&
        existsSync(packagesDir) &&
        existsSync(rootAgentsMd)
      ) {
        return currentDir;
      }

      const parentDir = dirname(currentDir);
      if (parentDir === currentDir) break;
      currentDir = parentDir;
    }
  } catch {
    // On filesystem errors, report no monorepo detected.
  }
  return null;
}

export function loadRootDocs(rootPath: string): RootDocInfo[] {
  const docs: RootDocInfo[] = [];

  const rootDocs = [
    { filename: 'AGENTS.md', heading: 'Framework Overview' },
    { filename: 'TESTING_STANDARD.md', heading: 'Testing Guide' },
    { filename: 'CONTRIBUTING.md', heading: 'Contributing' },
    { filename: 'WORKFLOW.md', heading: 'Development Workflow' },
  ];

  for (const doc of rootDocs) {
    const filePath = join(rootPath, doc.filename);
    if (existsSync(filePath)) {
      try {
        docs.push({
          filename: doc.filename,
          heading: doc.heading,
          content: readFileSync(filePath, 'utf-8'),
        });
      } catch {
        console.warn(`   ⚠️  Could not read ${doc.filename}`);
      }
    }
  }
  return docs;
}

export function extractReadmeSections(
  readme: string,
  sectionNames: string[],
): Record<string, string> {
  const sections: Record<string, string> = {};
  const lines = readme.split('\n');

  for (const targetSection of sectionNames) {
    const targetLower = targetSection.toLowerCase();
    let inSection = false;
    let sectionContent: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const h2Match = line.match(/^##\s+(.+)$/);
      if (h2Match) {
        const headingText = h2Match[1].trim();

        if (inSection) {
          sections[targetSection] = sectionContent.join('\n').trim();
          inSection = false;
          sectionContent = [];
        }

        if (
          headingText.toLowerCase() === targetLower ||
          headingText.toLowerCase().includes(targetLower)
        ) {
          inSection = true;
          continue;
        }
      }

      if (line.match(/^#\s+[^#]/) && inSection) {
        sections[targetSection] = sectionContent.join('\n').trim();
        inSection = false;
        sectionContent = [];
        continue;
      }

      if (inSection) sectionContent.push(line);
    }

    if (inSection && sectionContent.length > 0) {
      sections[targetSection] = sectionContent.join('\n').trim();
    }
  }

  return sections;
}

function renderAgentMd(content: string): string {
  const h1Match = content.match(/^#\s+.+\n/);
  if (h1Match) {
    content = content.slice(h1Match[0].length);
  }
  return content.trim();
}

/** Keep package orientation inline; load module bodies only on explicit request. */
function renderPackageDoc(
  pkg: PackageInfo,
  lines: string[],
  complete: boolean,
): void {
  const content = pkg.agentMd ?? pkg.claudeMd;
  if (!content) {
    lines.push('*No AGENTS.md found for this package.*', '');
    return;
  }

  lines.push(renderAgentMd(content), '');
  const paths =
    pkg.moduleDocPaths ?? pkg.moduleDocs?.map((doc) => doc.path) ?? [];
  if (!complete && paths.length > 0) {
    lines.push('#### Module documentation', '');
    lines.push(
      'Resolve each link under `node_modules/` (for example `node_modules/@happyvertical/smrt-core/agents/object-runtime.md`) and read it on demand, or regenerate with `--complete`.',
      '',
    );
    for (const path of paths) {
      // Link by bare package specifier, never by the installed realpath: the
      // generated file is committed by consumers, and an absolute pnpm-store
      // path embeds the checkout directory and store hash, so it churns on
      // every install in another worktree or machine.
      const relative = path.replace(/\\/g, '/');
      const specifier = pkg.specifier ?? pkg.name;
      lines.push(`- [${relative}](<${specifier}/${relative}>)`);
    }
    lines.push('');
  }
  if (complete) {
    for (const doc of pkg.moduleDocs ?? []) {
      lines.push(`#### ${doc.path}`, '', renderAgentMd(doc.content), '');
    }
  }
}

export function generateMarkdown(
  packages: PackageInfo[],
  rootDocs?: RootDocInfo[],
  sdkPackages?: PackageInfo[],
  generatedBy = 'smrt docs:agents',
  options: { complete?: boolean; intentSection?: string[] } = {},
): string {
  const lines: string[] = [];

  lines.push('# SMRT Framework Context');
  lines.push('');
  lines.push(
    'This project uses the SMRT framework. Below are the conventions and patterns for the installed packages.',
  );
  lines.push('');

  if (options.intentSection && options.intentSection.length > 0) {
    lines.push(...options.intentSection);
  }

  if (rootDocs && rootDocs.length > 0) {
    lines.push('## Framework Documentation');
    lines.push('');

    for (const doc of rootDocs) {
      lines.push('---');
      lines.push('');
      lines.push(`### ${doc.heading}`);
      lines.push('');
      lines.push(`*Source: ${doc.filename}*`);
      lines.push('');
      lines.push(doc.content);
      lines.push('');
    }

    lines.push('---');
    lines.push('');
    lines.push('## Package Documentation');
    lines.push('');
  }

  lines.push('## Installed SMRT Packages');
  lines.push('');
  lines.push('| Package | Version |');
  lines.push('|---------|---------|');
  for (const pkg of packages) {
    lines.push(`| ${pkg.name} | ${formatPackageVersion(pkg)} |`);
  }
  lines.push('');

  if (sdkPackages && sdkPackages.length > 0) {
    lines.push('## Installed SDK Packages');
    lines.push('');
    lines.push('| Package | Version |');
    lines.push('|---------|---------|');
    for (const pkg of sdkPackages) {
      lines.push(`| ${pkg.name} | ${formatPackageVersion(pkg)} |`);
    }
    lines.push('');
  }

  for (const pkg of packages) {
    lines.push('---');
    lines.push('');
    lines.push(`## ${pkg.name}`);
    lines.push('');

    renderPackageDoc(pkg, lines, options.complete === true);
  }

  if (sdkPackages && sdkPackages.length > 0) {
    lines.push('---');
    lines.push('');
    lines.push('## SDK Package Details');
    lines.push('');

    for (const pkg of sdkPackages) {
      lines.push('---');
      lines.push('');
      lines.push(`### ${pkg.name}`);
      lines.push('');

      renderPackageDoc(pkg, lines, options.complete === true);
    }
  }

  lines.push('---');
  lines.push('');
  lines.push('## Contributing to This Documentation');
  lines.push('');
  lines.push(
    'If you discover gotchas, patterns, or information that should be included in the SMRT framework documentation, please submit an issue:',
  );
  lines.push('');
  lines.push('**https://github.com/happyvertical/smrt/issues**');
  lines.push('');
  lines.push('Include:');
  lines.push('- The package name (e.g., `@happyvertical/smrt-core`)');
  lines.push('- Description of the gotcha or pattern');
  lines.push('- Example code if applicable');
  lines.push('');

  lines.push('---');
  lines.push(
    `*Generated by \`${generatedBy}${options.complete ? ' --complete' : ''}\` — regenerate after dependency updates*`,
  );
  lines.push('');

  return lines.join('\n');
}

export const docsCommands: Record<string, CLICommand> = {
  'docs:agents': docsAgentsCommand,
  'docs:claude': docsClaudeCommand,
};
