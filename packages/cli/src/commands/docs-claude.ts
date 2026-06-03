/**
 * docs:agents / docs:claude commands
 *
 * Generates downstream SMRT framework context from installed @happyvertical
 * packages. AGENTS.md is canonical; docs:claude remains a compatibility alias
 * that writes to the historical .claude/smrt-framework.md path.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { CLICommand } from '../cli-generator.js';

export interface PackageInfo {
  name: string;
  version: string;
  readme: string | null;
  agentMd?: string | null;
  /** Backward-compatible alias for older tests/importers. */
  claudeMd?: string | null;
  docSource?: 'AGENTS.md' | 'CLAUDE.md' | null;
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
      'dry-run': {
        type: 'boolean',
        description: 'Print to stdout without writing file',
        default: false,
        short: 'd',
      },
    },
    handler: async (_args: string[], options: any) => {
      try {
        if (config.deprecated) {
          console.warn(
            '⚠️  smrt docs:claude is deprecated; use smrt docs:agents. This command still writes Claude-compatible output.',
          );
        }

        const outputPath = options.output || config.defaultOutput;
        const dryRun = options['dry-run'];
        const monorepoRoot = detectMonorepoRoot();
        const rootDocs = monorepoRoot ? loadRootDocs(monorepoRoot) : [];
        const packages = await discoverInstalledPackages();
        const sdkPackages = await discoverSdkPackages();

        if (packages.length === 0 && sdkPackages.length === 0) {
          console.log('\n⚠️  No @happyvertical packages found in node_modules');
          console.log(
            '   Make sure packages are installed before running this command.\n',
          );
          process.exit(1);
        }

        const content = generateMarkdown(
          packages,
          rootDocs.length > 0 ? rootDocs : undefined,
          sdkPackages.length > 0 ? sdkPackages : undefined,
          config.generatedBy,
        );

        if (dryRun) {
          console.log(content);
          return;
        }

        const outputDir = dirname(outputPath);
        if (!existsSync(outputDir)) {
          mkdirSync(outputDir, { recursive: true });
        }

        writeFileSync(outputPath, content, 'utf-8');

        const totalPackages = packages.length + sdkPackages.length;
        console.log(`\n✅ Generated ${outputPath}`);
        console.log(`   ${totalPackages} packages documented`);
        if (packages.length > 0) {
          console.log(`   ${packages.length} SMRT packages`);
        }
        if (sdkPackages.length > 0) {
          console.log(`   ${sdkPackages.length} SDK packages`);
        }
        const allPackages = [...packages, ...sdkPackages];
        const withAgentDocs = allPackages.filter((p) => p.agentMd).length;
        if (withAgentDocs > 0) {
          console.log(`   ${withAgentDocs} with AGENTS.md`);
        }
        if (rootDocs.length > 0) {
          console.log(`   ${rootDocs.length} framework documents included`);
        }
        console.log('');
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
 * Discover installed @happyvertical/smrt-* packages.
 * Checks both node_modules and workspace packages directory.
 */
async function discoverInstalledPackages(): Promise<PackageInfo[]> {
  const packages: PackageInfo[] = [];
  const { readdirSync } = await import('node:fs');

  const nodeModulesPath = join(process.cwd(), 'node_modules', '@happyvertical');
  if (existsSync(nodeModulesPath)) {
    const entries = readdirSync(nodeModulesPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.name.startsWith('smrt-')) continue;

      const entryPath = join(nodeModulesPath, entry.name);
      let packagePath = entryPath;

      try {
        const stats = lstatSync(entryPath);
        if (stats.isSymbolicLink()) {
          packagePath = realpathSync(entryPath);
        }
      } catch {
        // Not a symlink, use original path.
      }

      const pkg = loadPackageInfo(packagePath, entry.name);
      if (pkg) packages.push(pkg);
    }
  }

  if (packages.length === 0) {
    const workspacePath = join(process.cwd(), 'packages');
    const pnpmWorkspacePath = join(process.cwd(), 'pnpm-workspace.yaml');

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

          const pkg = loadPackageInfo(packagePath, entry.name);
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
async function discoverSdkPackages(): Promise<PackageInfo[]> {
  const packages: PackageInfo[] = [];
  const { readdirSync } = await import('node:fs');

  const nodeModulesPath = join(process.cwd(), 'node_modules', '@happyvertical');
  if (!existsSync(nodeModulesPath)) {
    return packages;
  }

  const entries = readdirSync(nodeModulesPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('smrt-')) continue;
    if (entry.name === 'smrt') continue;

    const entryPath = join(nodeModulesPath, entry.name);
    let packagePath = entryPath;

    try {
      const stats = lstatSync(entryPath);
      if (stats.isSymbolicLink()) {
        packagePath = realpathSync(entryPath);
      }
    } catch {
      // Not a symlink, use original path.
    }

    const pkg = loadPackageInfo(packagePath, entry.name);
    if (pkg) packages.push(pkg);
  }

  return packages.sort((a, b) => a.name.localeCompare(b.name));
}

function loadPackageInfo(
  packagePath: string,
  dirName: string,
): PackageInfo | null {
  const packageJsonPath = join(packagePath, 'package.json');
  if (!existsSync(packageJsonPath)) {
    return null;
  }

  try {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
    const readmePath = join(packagePath, 'README.md');
    const agentsPath = join(packagePath, 'AGENTS.md');
    const claudePath = join(packagePath, 'CLAUDE.md');
    const agentDoc = loadAgentDoc(agentsPath, claudePath);

    const info: PackageInfo = {
      name: packageJson.name,
      version: packageJson.version,
      readme: existsSync(readmePath) ? readFileSync(readmePath, 'utf-8') : null,
      agentMd: agentDoc.content,
      claudeMd: agentDoc.content,
      docSource: agentDoc.source,
    };

    return info;
  } catch {
    console.warn(`   ⚠️  Could not read package.json for ${dirName}`);
    return null;
  }
}

function loadAgentDoc(
  agentsPath: string,
  claudePath: string,
): { content: string | null; source: 'AGENTS.md' | 'CLAUDE.md' | null } {
  if (existsSync(agentsPath)) {
    return {
      content: readFileSync(agentsPath, 'utf-8'),
      source: 'AGENTS.md',
    };
  }

  if (!existsSync(claudePath)) {
    return { content: null, source: null };
  }

  const claude = readFileSync(claudePath, 'utf-8');
  if (claude.trim() === '@AGENTS.md') {
    return { content: null, source: null };
  }

  return { content: claude, source: 'CLAUDE.md' };
}

export function detectMonorepoRoot(): string | null {
  try {
    let currentDir = realpathSync(process.cwd());

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

function loadRootDocs(rootPath: string): RootDocInfo[] {
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

export function generateMarkdown(
  packages: PackageInfo[],
  rootDocs?: RootDocInfo[],
  sdkPackages?: PackageInfo[],
  generatedBy = 'smrt docs:agents',
): string {
  const lines: string[] = [];

  lines.push('# SMRT Framework Context');
  lines.push('');
  lines.push(
    'This project uses the SMRT framework. Below are the conventions and patterns for the installed packages.',
  );
  lines.push('');

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
    lines.push(`| ${pkg.name} | ${pkg.version} |`);
  }
  lines.push('');

  if (sdkPackages && sdkPackages.length > 0) {
    lines.push('## Installed SDK Packages');
    lines.push('');
    lines.push('| Package | Version |');
    lines.push('|---------|---------|');
    for (const pkg of sdkPackages) {
      lines.push(`| ${pkg.name} | ${pkg.version} |`);
    }
    lines.push('');
  }

  for (const pkg of packages) {
    lines.push('---');
    lines.push('');
    lines.push(`## ${pkg.name}`);
    lines.push('');

    const content = pkg.agentMd ?? pkg.claudeMd;
    if (content) {
      lines.push(renderAgentMd(content));
      lines.push('');
    } else {
      lines.push('*No AGENTS.md found for this package.*');
      lines.push('');
    }
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

      const content = pkg.agentMd ?? pkg.claudeMd;
      if (content) {
        lines.push(renderAgentMd(content));
        lines.push('');
      } else {
        lines.push('*No AGENTS.md found for this package.*');
        lines.push('');
      }
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
    `*Generated by \`${generatedBy}\` — regenerate after dependency updates*`,
  );
  lines.push('');

  return lines.join('\n');
}

export const docsCommands: Record<string, CLICommand> = {
  'docs:agents': docsAgentsCommand,
  'docs:claude': docsClaudeCommand,
};
