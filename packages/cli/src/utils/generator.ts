/**
 * Template Generator Utilities
 *
 * Handles template instantiation:
 * - Run base generators (SvelteKit, Next.js, etc.)
 * - Overlay template files
 * - Merge package.json dependencies
 */

import { spawn } from 'node:child_process';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import glob from 'fast-glob';
import type { TemplateConfig, TemplateSource } from '../loaders/index.js';

export interface SiteGeneratorOptions {
  /** Site location name (e.g., "Bentley, AB") */
  location?: string;
  /** Latitude coordinate */
  latitude?: number;
  /** Longitude coordinate */
  longitude?: number;
  /** IANA timezone (e.g., "America/Edmonton") */
  timezone?: string;
}

export interface GeneratorOptions {
  template: string;
  name: string;
  outputDir: string;
  /** Site-specific options for placeholder substitution */
  site?: SiteGeneratorOptions;
}

/**
 * Generate project from template
 */
export async function generate(
  source: TemplateSource,
  config: TemplateConfig,
  options: GeneratorOptions,
): Promise<void> {
  console.log(`\n🏗️  Creating gnode: ${options.name}`);
  console.log(`📦 Using template: ${config.name} (${config.description})\n`);

  // Step 1: Run base generator if specified
  if (config.baseGenerator) {
    console.log(`📝 Running base generator (${config.framework})...`);
    await runBaseGenerator(config.baseGenerator, options.outputDir);
  } else {
    // Create directory if no base generator
    await mkdir(options.outputDir, { recursive: true });
  }

  // Step 2: Overlay template files
  console.log('📋 Copying template files...');
  await overlayTemplate(source, config, options.outputDir);

  // Step 3: Merge package.json
  console.log('🔧 Configuring package.json...');
  await mergePackageJson(options.outputDir, config, options.name);

  // Step 4: Process placeholders if template defines them
  if (config.placeholders) {
    console.log('🔄 Processing template placeholders...');
    await processPlaceholders(options.outputDir, config, options);
  }

  console.log('\n✅ Gnode created successfully!');
  console.log(`\n📍 Next steps:`);
  console.log(`   cd ${options.name}`);
  console.log(`   pnpm install`);
  console.log(`   pnpm dev\n`);
}

/**
 * Validate base generator configuration to prevent command injection
 */
function validateBaseGenerator(
  baseGen: NonNullable<TemplateConfig['baseGenerator']>,
  outputDir: string,
): void {
  // Whitelist of allowed base generator commands
  const allowedCommands = ['npm', 'npx', 'pnpm', 'yarn', 'bun', 'bunx'];

  if (!allowedCommands.includes(baseGen.command)) {
    throw new Error(
      `Base generator command "${baseGen.command}" not allowed. ` +
        `Allowed commands: ${allowedCommands.join(', ')}`,
    );
  }

  // Validate outputDir doesn't contain shell metacharacters
  const dangerousChars = /[;&|`$(){}[\]<>'"\\]/;
  if (dangerousChars.test(outputDir)) {
    throw new Error(
      `Output directory contains dangerous characters: ${outputDir}. ` +
        `Only alphanumeric, dash, underscore, dot, and forward slash are allowed.`,
    );
  }

  // Validate all arguments after {DIR} replacement
  for (const arg of baseGen.args) {
    // Replace {DIR} placeholder first
    const replacedArg = arg.replace('{DIR}', outputDir);

    // Then check for command injection patterns in the replaced argument
    if (dangerousChars.test(replacedArg)) {
      throw new Error(
        `Base generator argument contains dangerous characters after placeholder replacement: ${replacedArg}`,
      );
    }
  }
}

/**
 * Run base project generator (e.g., create-svelte, create-next-app)
 *
 * Security: Command and arguments are validated to prevent injection attacks.
 * shell: true is NOT used to avoid command injection vulnerabilities.
 */
async function runBaseGenerator(
  baseGen: NonNullable<TemplateConfig['baseGenerator']>,
  outputDir: string,
): Promise<void> {
  // Validate configuration before executing
  validateBaseGenerator(baseGen, outputDir);

  // Replace {DIR} placeholder in arguments
  const args = baseGen.args.map((arg) => arg.replace('{DIR}', outputDir));

  return new Promise((resolve, reject) => {
    // Do NOT use shell: true to prevent command injection
    const proc = spawn(baseGen.command, args, {
      stdio: 'inherit',
      shell: false,
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Base generator exited with code ${code}`));
      }
    });

    proc.on('error', reject);
  });
}

/**
 * Overlay template files onto generated project
 */
async function overlayTemplate(
  source: TemplateSource,
  config: TemplateConfig,
  outputDir: string,
): Promise<void> {
  const { existsSync } = await import('node:fs');

  // Determine base directory for template files
  let baseDir: string;

  switch (source.type) {
    case 'npm':
      baseDir = dirname(source.resolved);
      break;
    case 'git': {
      // For git templates the temp directory is stored on the config. Prefer
      // the subdir-resolved `__templateRoot` so `github:user/repo/subdir`
      // overlays from the subdir, not the repo root (#1385); fall back to
      // `__tempDir` for the non-subdir case / older configs. These internal
      // fields are attached by the git loader and are not part of the public
      // TemplateConfig shape.
      const gitConfig = config as TemplateConfig & {
        __templateRoot?: string;
        __tempDir?: string;
      };
      const baseGitDir = gitConfig.__templateRoot ?? gitConfig.__tempDir;
      if (!baseGitDir) {
        throw new Error('Git template temp directory not found');
      }
      baseDir = baseGitDir;
      break;
    }
    case 'local':
      baseDir = source.resolved;
      break;
    default:
      throw new Error(`Unknown source type: ${source.type}`);
  }

  // Check for template directory first (full project templates)
  // Then fall back to overlay directory (overlay on base generator output)
  // Also check templateDir from config
  const templateDir = config.templateDir
    ? join(baseDir, config.templateDir)
    : null;

  let sourceDir: string | null = null;

  // Priority: config.templateDir > template/ > overlay/
  if (templateDir && existsSync(templateDir)) {
    sourceDir = templateDir;
  } else if (existsSync(join(baseDir, 'template'))) {
    sourceDir = join(baseDir, 'template');
  } else if (existsSync(join(baseDir, 'overlay'))) {
    sourceDir = join(baseDir, 'overlay');
  }

  if (!sourceDir) {
    // No template files to copy - this is okay if there's a base generator
    if (config.baseGenerator) {
      return;
    }
    throw new Error(
      `No template files found in ${baseDir}. Expected 'template/' or 'overlay/' directory.`,
    );
  }

  // Find all files in source directory
  const files = await glob('**/*', {
    cwd: sourceDir,
    dot: true,
    onlyFiles: true,
    ignore: ['**/.gitkeep'],
  });

  // Copy each file
  for (const file of files) {
    const src = join(sourceDir, file);
    const dest = join(outputDir, file);

    // Ensure directory exists
    await mkdir(dirname(dest), { recursive: true });

    // Copy file
    await cp(src, dest);
  }

  console.log(`   Copied ${files.length} template files`);
}

/**
 * Merge template dependencies into package.json
 */
async function mergePackageJson(
  outputDir: string,
  config: TemplateConfig,
  projectName: string,
): Promise<void> {
  const pkgPath = join(outputDir, 'package.json');

  /** Minimal package.json shape touched by this merge step. */
  interface MergeablePackageJson {
    name?: string;
    version?: string;
    private?: boolean;
    // Optional: a parsed package.json commonly omits these (only the
    // generated-from-scratch fallback below sets them all). Normalized to
    // {} after load so the downstream merges/access stay safe.
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    [key: string]: unknown;
  }

  let pkg: MergeablePackageJson;
  try {
    const content = await readFile(pkgPath, 'utf-8');
    pkg = JSON.parse(content) as MergeablePackageJson;
  } catch {
    // If no package.json exists, create one
    pkg = {
      name: projectName,
      version: '0.1.0',
      private: true,
      scripts: {},
      dependencies: {},
      devDependencies: {},
    };
  }

  // Normalize optional maps so the merges/access below are safe even when a
  // parsed package.json omitted them.
  pkg.scripts ??= {};
  pkg.dependencies ??= {};
  pkg.devDependencies ??= {};

  // Update name
  pkg.name = projectName;

  // Merge dependencies
  pkg.dependencies = {
    ...pkg.dependencies,
    ...config.dependencies,
  };

  pkg.devDependencies = {
    ...pkg.devDependencies,
    ...config.devDependencies,
  };

  // Add gnode-specific scripts if not present
  if (!pkg.scripts['workflow:research']) {
    pkg.scripts = {
      ...pkg.scripts,
      'workflow:research': 'tsx src/workflows/research.ts',
      'workflow:report': 'tsx src/workflows/report.ts',
    };
  }

  // Write back
  await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
}

/**
 * Context object passed to placeholder functions
 */
export interface PlaceholderContext {
  /** Project name (e.g., "my-town-site") */
  name: string;
  /** Pretty site name derived from project name (e.g., "My Town Site") */
  siteName: string;
  /** Location name (e.g., "Bentley, AB") */
  location: string;
  /** Latitude coordinate */
  latitude: number;
  /** Longitude coordinate */
  longitude: number;
  /** IANA timezone */
  timezone: string;
}

/**
 * Process template placeholders in all files
 *
 * Placeholders are defined in template.config.js as:
 * placeholders: {
 *   '{{SITE_NAME}}': (ctx) => ctx.siteName,
 *   '{{LATITUDE}}': (ctx) => String(ctx.latitude),
 * }
 */
async function processPlaceholders(
  outputDir: string,
  config: TemplateConfig,
  options: GeneratorOptions,
): Promise<void> {
  const placeholders = config.placeholders;
  if (!placeholders || Object.keys(placeholders).length === 0) {
    return;
  }

  // Build context from options
  const ctx: PlaceholderContext = {
    name: options.name,
    siteName: options.name
      .replace(/[-_]/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase()),
    location: options.site?.location || options.name,
    latitude: options.site?.latitude || 0,
    longitude: options.site?.longitude || 0,
    timezone: options.site?.timezone || 'America/Edmonton',
  };

  // Build replacement map
  const replacements: Record<string, string> = {};
  for (const [placeholder, replacer] of Object.entries(placeholders)) {
    if (typeof replacer === 'function') {
      replacements[placeholder] = String(replacer(ctx));
    } else {
      replacements[placeholder] = String(replacer);
    }
  }

  // Find all text files to process
  const files = await glob(
    '**/*.{ts,js,mjs,cjs,json,svelte,html,css,md,txt,yml,yaml}',
    {
      cwd: outputDir,
      onlyFiles: true,
      ignore: ['**/node_modules/**', '**/dist/**', '**/.svelte-kit/**'],
    },
  );

  let replacedCount = 0;

  for (const file of files) {
    const filePath = join(outputDir, file);
    let content = await readFile(filePath, 'utf-8');
    let modified = false;

    // Replace all placeholders
    for (const [placeholder, value] of Object.entries(replacements)) {
      if (content.includes(placeholder)) {
        content = content.replaceAll(placeholder, value);
        modified = true;
      }
    }

    if (modified) {
      await writeFile(filePath, content);
      replacedCount++;
    }
  }

  console.log(`   Processed placeholders in ${replacedCount} files`);
}
