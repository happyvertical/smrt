/**
 * docs:claude Command
 *
 * Generates .claude/smrt-framework.md from installed @happyvertical/smrt-* packages.
 * This provides Claude Code with framework context in downstream projects.
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

export interface ClaudeMeta {
  purpose: string;
  readmeSections?: string[];
  patterns?: Array<{
    name: string;
    description: string;
    example?: string;
  }>;
  pitfalls?: string[];
  exports?: string[];
}

export interface PackageInfo {
  name: string;
  version: string;
  meta: ClaudeMeta | null;
  readme: string | null;
}

export interface RootDocInfo {
  filename: string;
  heading: string;
  content: string;
}

export const docsClaudeCommand: CLICommand = {
  name: 'docs:claude',
  description:
    'Generate .claude/smrt-framework.md from installed SMRT packages',
  aliases: ['claude-docs'],
  args: [],
  options: {
    output: {
      type: 'string',
      description: 'Output file path (default: .claude/smrt-framework.md)',
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
      const outputPath = options.output || '.claude/smrt-framework.md';
      const dryRun = options['dry-run'];

      // Detect monorepo and load root docs
      const monorepoRoot = detectMonorepoRoot();
      const rootDocs = monorepoRoot ? loadRootDocs(monorepoRoot) : [];

      // Find installed @happyvertical/smrt-* packages
      const packages = await discoverInstalledPackages();

      if (packages.length === 0) {
        console.log(
          '\n⚠️  No @happyvertical/smrt-* packages found in node_modules',
        );
        console.log(
          '   Make sure packages are installed before running this command.\n',
        );
        process.exit(1);
      }

      // Generate markdown content with optional root docs
      const content = generateMarkdown(
        packages,
        rootDocs.length > 0 ? rootDocs : undefined,
      );

      if (dryRun) {
        console.log(content);
        return;
      }

      // Ensure output directory exists
      const outputDir = dirname(outputPath);
      if (!existsSync(outputDir)) {
        mkdirSync(outputDir, { recursive: true });
      }

      // Write file
      writeFileSync(outputPath, content, 'utf-8');

      console.log(`\n✅ Generated ${outputPath}`);
      console.log(`   ${packages.length} packages documented`);
      console.log(
        `   ${packages.filter((p) => p.meta).length} with .claude-meta.json`,
      );
      if (rootDocs.length > 0) {
        console.log(`   ${rootDocs.length} framework documents included`);
      }
      console.log('');
    } catch (error) {
      console.error('\n❌ Failed to generate Claude documentation:');
      if (error instanceof Error) {
        console.error(`   ${error.message}`);
      }
      process.exit(1);
    }
  },
};

/**
 * Discover installed @happyvertical/smrt-* packages
 * Checks both node_modules and workspace packages directory
 */
async function discoverInstalledPackages(): Promise<PackageInfo[]> {
  const packages: PackageInfo[] = [];
  const { readdirSync } = await import('node:fs');

  // First, try node_modules (for downstream projects)
  const nodeModulesPath = join(process.cwd(), 'node_modules', '@happyvertical');
  if (existsSync(nodeModulesPath)) {
    const entries = readdirSync(nodeModulesPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.name.startsWith('smrt-')) continue;

      // Resolve symlinks for workspace packages
      const entryPath = join(nodeModulesPath, entry.name);
      let packagePath = entryPath;

      try {
        // Use lstatSync to detect symlinks (statSync follows them)
        const stats = lstatSync(entryPath);
        if (stats.isSymbolicLink()) {
          packagePath = realpathSync(entryPath);
        }
      } catch {
        // Not a symlink, use original path
      }

      const pkg = loadPackageInfo(packagePath, entry.name);
      if (pkg) packages.push(pkg);
    }
  }

  // If no packages found, check for workspace packages (for SMRT monorepo)
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
          // Only include @happyvertical/smrt-* packages
          if (!packageJson.name?.startsWith('@happyvertical/smrt-')) continue;

          const pkg = loadPackageInfo(packagePath, entry.name);
          if (pkg) packages.push(pkg);
        } catch {
          // Skip invalid package.json
        }
      }
    }
  }

  // Sort by package name
  return packages.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Load package info from a directory
 */
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
    const metaPath = join(packagePath, '.claude-meta.json');
    const readmePath = join(packagePath, 'README.md');

    const info: PackageInfo = {
      name: packageJson.name,
      version: packageJson.version,
      meta: null,
      readme: null,
    };

    // Load .claude-meta.json if it exists
    if (existsSync(metaPath)) {
      try {
        info.meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
      } catch (e) {
        console.warn(`   ⚠️  Invalid .claude-meta.json in ${dirName}`);
      }
    }

    // Load README.md if it exists
    if (existsSync(readmePath)) {
      info.readme = readFileSync(readmePath, 'utf-8');
    }

    return info;
  } catch (e) {
    console.warn(`   ⚠️  Could not read package.json for ${dirName}`);
    return null;
  }
}

/**
 * Detect if running in the SMRT monorepo
 * Returns the monorepo root path if detected, null otherwise
 * Walks up directory tree to find monorepo root markers
 */
export function detectMonorepoRoot(): string | null {
  try {
    let currentDir = realpathSync(process.cwd());

    // Walk up the directory tree until we find the monorepo root or hit filesystem root
    // Monorepo root is indicated by the presence of:
    // - pnpm-workspace.yaml
    // - packages/ directory
    // - CLAUDE.md
    for (;;) {
      const pnpmWorkspace = join(currentDir, 'pnpm-workspace.yaml');
      const packagesDir = join(currentDir, 'packages');
      const rootClaudeMd = join(currentDir, 'CLAUDE.md');

      if (
        existsSync(pnpmWorkspace) &&
        existsSync(packagesDir) &&
        existsSync(rootClaudeMd)
      ) {
        return currentDir;
      }

      const parentDir = dirname(currentDir);
      if (parentDir === currentDir) {
        // Reached filesystem root without finding monorepo markers
        break;
      }
      currentDir = parentDir;
    }
  } catch {
    // On any unexpected filesystem error, fall through and report no monorepo detected
  }
  return null;
}

/**
 * Load root documentation files from the monorepo
 */
function loadRootDocs(rootPath: string): RootDocInfo[] {
  const docs: RootDocInfo[] = [];

  const rootDocs = [
    { filename: 'CLAUDE.md', heading: 'Framework Overview' },
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
      } catch (e) {
        console.warn(`   ⚠️  Could not read ${doc.filename}`);
      }
    }
  }
  return docs;
}

/**
 * Extract H2 sections from README content
 */
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

      // Check for H2 heading (## Title)
      const h2Match = line.match(/^##\s+(.+)$/);
      if (h2Match) {
        const headingText = h2Match[1].trim();

        if (inSection) {
          // We hit another H2, end the current section
          sections[targetSection] = sectionContent.join('\n').trim();
          inSection = false;
          sectionContent = [];
        }

        // Check if this is the section we're looking for (case-insensitive)
        if (
          headingText.toLowerCase() === targetLower ||
          headingText.toLowerCase().includes(targetLower)
        ) {
          inSection = true;
          continue;
        }
      }

      // Check for H1 heading (# Title) - this ends H2 sections
      if (line.match(/^#\s+[^#]/) && inSection) {
        sections[targetSection] = sectionContent.join('\n').trim();
        inSection = false;
        sectionContent = [];
        continue;
      }

      if (inSection) {
        sectionContent.push(line);
      }
    }

    // Handle case where section goes to end of file
    if (inSection && sectionContent.length > 0) {
      sections[targetSection] = sectionContent.join('\n').trim();
    }
  }

  return sections;
}

/**
 * Generate the markdown content for .claude/smrt-framework.md
 */
export function generateMarkdown(
  packages: PackageInfo[],
  rootDocs?: RootDocInfo[],
): string {
  const lines: string[] = [];

  // Header
  lines.push('# SMRT Framework Context');
  lines.push('');
  lines.push(
    'This project uses the SMRT framework. Below are the conventions and patterns for the installed packages.',
  );
  lines.push('');

  // Framework Documentation section (if root docs provided)
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

  // Installed packages table
  lines.push('## Installed Packages');
  lines.push('');
  lines.push('| Package | Version |');
  lines.push('|---------|---------|');
  for (const pkg of packages) {
    lines.push(`| ${pkg.name} | ${pkg.version} |`);
  }
  lines.push('');

  // Per-package sections
  for (const pkg of packages) {
    lines.push('---');
    lines.push('');
    lines.push(`## ${pkg.name}`);
    lines.push('');

    if (pkg.meta) {
      // Purpose
      if (pkg.meta.purpose) {
        lines.push(pkg.meta.purpose);
        lines.push('');
      }

      // README sections
      if (pkg.meta.readmeSections && pkg.readme) {
        const sections = extractReadmeSections(
          pkg.readme,
          pkg.meta.readmeSections,
        );
        for (const sectionName of pkg.meta.readmeSections) {
          if (sections[sectionName]) {
            lines.push(`### ${sectionName}`);
            lines.push('');
            lines.push(sections[sectionName]);
            lines.push('');
          }
        }
      }

      // Patterns
      if (pkg.meta.patterns && pkg.meta.patterns.length > 0) {
        lines.push('### Patterns');
        lines.push('');
        for (const pattern of pkg.meta.patterns) {
          lines.push(`#### ${pattern.name}`);
          lines.push('');
          lines.push(pattern.description);
          if (pattern.example) {
            lines.push('```typescript');
            lines.push(pattern.example);
            lines.push('```');
          }
          lines.push('');
        }
      }

      // Pitfalls
      if (pkg.meta.pitfalls && pkg.meta.pitfalls.length > 0) {
        lines.push('### Pitfalls');
        lines.push('');
        for (const pitfall of pkg.meta.pitfalls) {
          lines.push(`- ${pitfall}`);
        }
        lines.push('');
      }

      // Key exports
      if (pkg.meta.exports && pkg.meta.exports.length > 0) {
        lines.push('### Key Exports');
        lines.push('');
        lines.push(`\`${pkg.meta.exports.join('`, `')}\``);
        lines.push('');
      }
    } else {
      lines.push('*No .claude-meta.json found for this package.*');
      lines.push('');
    }
  }

  // Contributing section
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

  // Footer
  lines.push('---');
  lines.push(
    '*Generated by `smrt docs:claude` — regenerate after dependency updates*',
  );
  lines.push('');

  return lines.join('\n');
}

export const docsCommands: Record<string, CLICommand> = {
  'docs:claude': docsClaudeCommand,
};
