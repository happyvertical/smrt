/**
 * Ecosystem-aware downstream project review.
 * Advisory only: scans manifests and source files, then reports alignment risks.
 */

import { type Dirent, existsSync, readFileSync } from 'node:fs';
import { access, readdir, readFile } from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type DetectorPackage,
  detectHandRolled,
  type HandRolledFinding,
} from './intent-detector.js';
import { type IntentRow, parseIntentIndex } from './intent-index.js';

interface ReviewSmrtProjectArgs {
  directory?: string;
  rootDir?: string;
  includeSourceEvidence?: boolean;
  maxFindings?: number;
  /**
   * Intent index to drive duplicate detection. Its `regex:` tokens become
   * `RegExp`s, so this is trusted by the caller and never read from the
   * reviewed tree by default. Default: the full index shipped inside the
   * pinned `@happyvertical/smrt-dev-mcp` package (`dist/knowledge/intents`),
   * else `docs/knowledge/intents/index.md` when running from the smrt
   * monorepo checkout. Relative paths resolve against `directory`.
   */
  intentIndexPath?: string;
  /** Set false to skip the intent-driven duplicate-detection pass. */
  detectDuplicates?: boolean;
  /**
   * Test seam: package root used to locate the packaged index instead of this
   * module's own. Not part of the tool schema.
   */
  packageRoot?: string;
}

/** Relative location of the intent index inside this package's `dist/`. */
export const PACKAGED_INTENT_INDEX = join(
  'dist',
  'knowledge',
  'intents',
  'index.md',
);

function findOwnPackageRoot(): string | null {
  let current = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const manifest = join(current, 'package.json');
    if (existsSync(manifest)) {
      try {
        const json = JSON.parse(readFileSync(manifest, 'utf-8')) as {
          name?: string;
        };
        if (json.name === '@happyvertical/smrt-dev-mcp') return current;
      } catch {
        // Keep walking.
      }
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Locations of the trusted default intent index, in resolution order (#4690):
 * the packaged full index, then the monorepo's committed index when this
 * package sits in `<repo>/packages/` of the smrt checkout. The reviewed
 * project's own tree is never consulted.
 */
export function defaultIntentIndexCandidates(packageRoot?: string): string[] {
  const root = packageRoot ?? findOwnPackageRoot();
  if (!root) return [];
  const candidates = [join(root, PACKAGED_INTENT_INDEX)];
  const packagesDir = dirname(root);
  if (basename(packagesDir) === 'packages') {
    const repoRoot = dirname(packagesDir);
    if (existsSync(join(repoRoot, 'pnpm-workspace.yaml'))) {
      candidates.push(
        join(repoRoot, 'docs', 'knowledge', 'intents', 'index.md'),
      );
    }
  }
  return candidates;
}

type Severity = 'high' | 'medium' | 'low';

interface Evidence {
  filePath: string;
  line?: number;
  detail: string;
}

interface Finding {
  severity: Severity;
  area:
    | 'dependencies'
    | 'storage'
    | 'api-shell'
    | 'manifest'
    | 'auth-tenancy'
    | 'ui-shell'
    | 'duplicate-detection';
  code: string;
  title: string;
  evidence: Evidence[];
  recommendation: string;
  suggestedIssueTitle: string;
  /** Duplicate-detection findings only (same anchors as `build-context`). */
  message?: string;
  file?: string;
  packageName?: string;
  intentPage?: string;
  componentPages?: string[];
}

interface PackageInventory {
  name: string;
  path: string;
  private?: boolean;
  scripts: string[];
  declaredHappyVerticalDependencies: string[];
  importedHappyVerticalPackages: string[];
  missingHappyVerticalDependencies: string[];
  hasSvelteKit: boolean;
  hasSmrtSvelte: boolean;
}

interface PackageContext {
  directory: string;
  relativePath: string;
  packageJsonPath: string;
  json: Record<string, unknown>;
  dependencies: Set<string>;
  scripts: Record<string, unknown>;
  imports: Map<string, Evidence[]>;
  sourceFiles: SourceFile[];
}

interface SourceFile {
  path: string;
  packageDir: string;
  content: string;
}

const SOURCE_EXTENSIONS = /\.(tsx?|jsx?|svelte)$/;
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  '.git',
  '.smrt',
  '.svelte-kit',
  'coverage',
]);
const DEPENDENCY_SECTIONS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
];
const SMRT_PACKAGE_PREFIX = '@happyvertical/smrt-';
const HAPPYVERTICAL_PACKAGE_PREFIX = '@happyvertical/';

export async function reviewSmrtProject(
  args: ReviewSmrtProjectArgs,
): Promise<string> {
  const projectPath = resolve(args.directory ?? args.rootDir ?? process.cwd());
  if (!(await pathExists(projectPath))) {
    return JSON.stringify(
      {
        projectPath,
        packageCount: 0,
        packages: [],
        findings: [],
        summary: { high: 0, medium: 0, low: 0 },
        diagnostics: [
          {
            severity: 'warning',
            message: `Project directory does not exist: ${projectPath}`,
          },
        ],
      },
      null,
      2,
    );
  }

  const packageContexts = await buildPackageContexts(projectPath);
  const sourceFiles = await listSourceFiles(projectPath, packageContexts);
  await attachSourceFiles(sourceFiles, packageContexts, projectPath);

  const duplicates = await runDuplicateDetection(
    args,
    projectPath,
    packageContexts,
  );

  const findings = limitFindings(
    [
      ...duplicates.findings,
      ...findMissingHappyVerticalDependencies(packageContexts),
      ...findCustomManifestGeneration(sourceFiles, projectPath),
      ...findDirectStorageBypasses(sourceFiles, packageContexts, projectPath),
      ...findCustomHttpShells(sourceFiles, packageContexts, projectPath),
      ...findLocalAuthTenancy(sourceFiles, packageContexts, projectPath),
      ...findUiShellDrift(packageContexts, projectPath),
      ...findMissingManifestArtifacts(
        sourceFiles,
        packageContexts,
        projectPath,
      ),
    ],
    args.maxFindings,
  );

  const packages = packageContexts
    .map(packageInventory)
    .sort((left, right) => left.path.localeCompare(right.path));
  const summary = summarizeFindings(findings);

  return JSON.stringify(
    {
      projectPath,
      packageCount: packages.length,
      packages,
      findings:
        args.includeSourceEvidence === false
          ? findings.map(({ evidence: _evidence, ...finding }) => finding)
          : findings,
      summary,
      duplicateDetection: duplicates.status,
      referenceChecks: [
        'Prefer SMRT scanner/runtime manifests over custom manifest builders.',
        'Prefer SvelteKit plus @happyvertical/smrt-svelte for app shells.',
        'Prefer @happyvertical/sql and @happyvertical/files/assets/content over direct durable node:fs storage.',
        'Prefer smrt-users, smrt-tenancy, and profile/audit packages over local static auth seams.',
      ],
      suggestedFollowUpIssues: findings.map((finding) => ({
        title: finding.suggestedIssueTitle,
        severity: finding.severity,
        area: finding.area,
      })),
    },
    null,
    2,
  );
}

async function buildPackageContexts(
  projectPath: string,
): Promise<PackageContext[]> {
  const packageJsonPaths = await listPackageJsonFiles(projectPath);
  const contexts = await Promise.all(
    packageJsonPaths.map(async (packageJsonPath) => {
      const json = JSON.parse(
        await readFile(packageJsonPath, 'utf-8'),
      ) as Record<string, unknown>;
      const directory = dirname(packageJsonPath);
      return {
        directory,
        relativePath: relative(projectPath, directory) || '.',
        packageJsonPath,
        json,
        dependencies: collectDependencies(json),
        scripts: isRecord(json.scripts)
          ? (json.scripts as Record<string, unknown>)
          : {},
        imports: new Map<string, Evidence[]>(),
        sourceFiles: [],
      };
    }),
  );

  if (contexts.length === 0) {
    contexts.push({
      directory: projectPath,
      relativePath: '.',
      packageJsonPath: join(projectPath, 'package.json'),
      json: {},
      dependencies: new Set(),
      scripts: {},
      imports: new Map(),
      sourceFiles: [],
    });
  }

  return contexts.sort(
    (left, right) => left.directory.length - right.directory.length,
  );
}

async function listPackageJsonFiles(projectPath: string): Promise<string[]> {
  const files: string[] = [];
  await visit(projectPath, async (filePath, entryName) => {
    if (entryName === 'package.json') files.push(filePath);
  });
  return files;
}

async function listSourceFiles(
  projectPath: string,
  packages: PackageContext[],
): Promise<SourceFile[]> {
  const files: SourceFile[] = [];
  await visit(projectPath, async (filePath, entryName) => {
    if (!SOURCE_EXTENSIONS.test(entryName)) return;
    if (
      entryName.endsWith('.d.ts') ||
      entryName.endsWith('.test.ts') ||
      entryName.endsWith('.spec.ts')
    ) {
      return;
    }

    const packageDir = findOwningPackage(filePath, packages).directory;
    const content = await readFile(filePath, 'utf-8');
    files.push({ path: filePath, packageDir, content });
  });
  return files;
}

async function attachSourceFiles(
  sourceFiles: SourceFile[],
  packages: PackageContext[],
  projectPath: string,
): Promise<void> {
  for (const sourceFile of sourceFiles) {
    const owner = packages.find(
      (pkg) => pkg.directory === sourceFile.packageDir,
    );
    if (!owner) continue;
    owner.sourceFiles.push(sourceFile);
    for (const importedPackage of extractImports(sourceFile.content)) {
      if (!importedPackage.startsWith(HAPPYVERTICAL_PACKAGE_PREFIX)) continue;
      const evidence = {
        filePath: relative(projectPath, sourceFile.path),
        line: lineNumber(sourceFile.content, importedPackage),
        detail: `Imports ${importedPackage}`,
      };
      const existing = owner.imports.get(importedPackage) ?? [];
      existing.push(evidence);
      owner.imports.set(importedPackage, existing);
    }
  }
}

function findMissingHappyVerticalDependencies(
  packages: PackageContext[],
): Finding[] {
  return packages.flatMap((pkg) => {
    const ownName =
      typeof pkg.json.name === 'string' ? pkg.json.name : undefined;
    const missing = Array.from(pkg.imports.keys()).filter(
      (importedPackage) =>
        importedPackage !== ownName && !pkg.dependencies.has(importedPackage),
    );
    if (missing.length === 0) return [];

    const hasSmrtMissing = missing.some((name) =>
      name.startsWith(SMRT_PACKAGE_PREFIX),
    );
    return [
      {
        severity: hasSmrtMissing ? 'high' : 'medium',
        area: 'dependencies',
        code: 'missing-happyvertical-dependencies',
        title: `${packageLabel(pkg)} imports HappyVertical packages that package.json does not declare`,
        evidence: missing.flatMap((name) => pkg.imports.get(name) ?? []),
        recommendation:
          'Declare every imported @happyvertical package in the owning package manifest so downstream installs and generated knowledge stay reproducible.',
        suggestedIssueTitle: `Declare missing HappyVertical dependencies in ${packageLabel(pkg)}`,
      },
    ];
  });
}

function findCustomManifestGeneration(
  sourceFiles: SourceFile[],
  projectPath: string,
): Finding[] {
  return sourceFiles
    .filter(
      (file) =>
        /manifest\.json/.test(file.content) &&
        /objects\s*:/.test(file.content) &&
        /\b(writeFile|writeFileSync)\b/.test(file.content) &&
        !/@happyvertical\/smrt-scanner/.test(file.content),
    )
    .map((file) => ({
      severity: 'high',
      area: 'manifest',
      code: 'custom-object-manifest-generation',
      title: 'Custom SMRT object manifest generation detected',
      evidence: [
        {
          filePath: relative(projectPath, file.path),
          line: lineNumber(file.content, 'manifest.json'),
          detail:
            'Writes a manifest.json object inventory outside the SMRT scanner/runtime path.',
        },
      ],
      recommendation:
        'Use the SMRT scanner/runtime manifest path so defaults, relationships, schemas, tenant fields, and cross-package references match framework behavior.',
      suggestedIssueTitle:
        'Replace custom object manifest generation with SMRT scanner/runtime manifest generation',
    }));
}

function findDirectStorageBypasses(
  sourceFiles: SourceFile[],
  packages: PackageContext[],
  projectPath: string,
): Finding[] {
  return sourceFiles.flatMap((file) => {
    const owner = findOwningPackage(file.path, packages);
    const usesFs =
      /from\s+['"](?:node:fs|node:fs\/promises|fs|fs\/promises)['"]|require\(['"](?:node:fs|node:fs\/promises|fs|fs\/promises)['"]\)/.test(
        file.content,
      );
    const writesDurableData =
      /\b(writeFile|appendFile|mkdir|rm|rename)\b/.test(file.content) &&
      /(\.json|data|storage|persist|cache|db)/i.test(file.content);
    const usesDirectSql =
      /from\s+['"](?:better-sqlite3|sqlite3|pg|mysql2?|knex|drizzle-orm)['"]/.test(
        file.content,
      );
    if ((!usesFs || !writesDurableData) && !usesDirectSql) return [];

    const hasApprovedStorage =
      owner.dependencies.has('@happyvertical/sql') ||
      owner.dependencies.has('@happyvertical/files') ||
      owner.dependencies.has('@happyvertical/smrt-assets') ||
      owner.dependencies.has('@happyvertical/smrt-content');

    if (hasApprovedStorage) return [];

    return [
      {
        severity: 'medium',
        area: 'storage',
        code: 'direct-storage-bypass',
        title: `${packageLabel(owner)} appears to bypass HappyVertical storage packages`,
        evidence: [
          {
            filePath: relative(projectPath, file.path),
            line: lineNumber(
              file.content,
              usesDirectSql ? 'sqlite' : 'writeFile',
            ),
            detail: usesDirectSql
              ? 'Imports a direct SQL/storage library without @happyvertical/sql.'
              : 'Uses node:fs-style durable writes without @happyvertical/files/assets/content.',
          },
        ],
        recommendation:
          'Route durable data through @happyvertical/sql, @happyvertical/files, SMRT assets, or SMRT content unless this is explicitly build-only tooling.',
        suggestedIssueTitle: `Review direct storage usage in ${packageLabel(owner)}`,
      },
    ];
  });
}

function findCustomHttpShells(
  sourceFiles: SourceFile[],
  packages: PackageContext[],
  projectPath: string,
): Finding[] {
  const evidenceByPackage = new Map<PackageContext, Evidence[]>();

  for (const pkg of packages) {
    if (pkg.dependencies.has('@sveltejs/kit')) continue;

    const routerDependencies = ['express', 'fastify', 'hono', 'koa'].filter(
      (dep) => pkg.dependencies.has(dep),
    );
    if (routerDependencies.length === 0) continue;

    appendEvidence(evidenceByPackage, pkg, {
      filePath: relative(projectPath, pkg.packageJsonPath),
      detail: `Declares custom router package(s): ${routerDependencies.join(', ')}.`,
    });
  }

  for (const file of sourceFiles) {
    const owner = findOwningPackage(file.path, packages);
    if (owner.dependencies.has('@sveltejs/kit')) continue;

    const usesNodeHttp =
      /from\s+['"](?:node:http|http|node:https|https)['"]|createServer\s*\(/.test(
        file.content,
      );
    if (!usesNodeHttp) continue;

    appendEvidence(evidenceByPackage, owner, {
      filePath: relative(projectPath, file.path),
      line: lineNumber(file.content, 'createServer'),
      detail:
        'Custom HTTP routing found without the SvelteKit/SMRT app-shell dependency pattern.',
    });
  }

  return Array.from(evidenceByPackage.entries()).map(([owner, evidence]) => ({
    severity: 'medium',
    area: 'api-shell',
    code: 'custom-http-shell',
    title: `${packageLabel(owner)} uses a custom HTTP shell`,
    evidence,
    recommendation:
      'Compare the app shell against the Anytown/Ergot SvelteKit + SMRT shell pattern before adding custom HTTP infrastructure.',
    suggestedIssueTitle: `Align ${packageLabel(owner)} app shell with SMRT/SvelteKit conventions`,
  }));
}

function appendEvidence(
  evidenceByPackage: Map<PackageContext, Evidence[]>,
  pkg: PackageContext,
  evidence: Evidence,
): void {
  const existing = evidenceByPackage.get(pkg);
  if (existing) {
    existing.push(evidence);
    return;
  }

  evidenceByPackage.set(pkg, [evidence]);
}

function findLocalAuthTenancy(
  sourceFiles: SourceFile[],
  packages: PackageContext[],
  projectPath: string,
): Finding[] {
  return sourceFiles.flatMap((file) => {
    const owner = findOwningPackage(file.path, packages);
    const pathSignal = /(auth|tenant|audit|session|rbac|user)/i.test(file.path);
    const codeSignal =
      /\b(tenantId|tenant|role|permission|session|auditLog|apiKey)\b/.test(
        file.content,
      );
    if (!pathSignal || !codeSignal) return [];

    const hasApprovedPackages =
      owner.dependencies.has('@happyvertical/smrt-users') ||
      owner.dependencies.has('@happyvertical/smrt-tenancy') ||
      owner.dependencies.has('@happyvertical/smrt-profiles');
    if (hasApprovedPackages) return [];

    return [
      {
        severity: 'medium',
        area: 'auth-tenancy',
        code: 'local-auth-tenancy',
        title: `${packageLabel(owner)} contains local auth/tenancy/audit logic`,
        evidence: [
          {
            filePath: relative(projectPath, file.path),
            line: lineNumber(file.content, 'tenant'),
            detail:
              'Auth, tenancy, session, role, or audit terminology appears without smrt-users/smrt-tenancy/smrt-profiles dependencies.',
          },
        ],
        recommendation:
          'Add explicit adapters to smrt-users, smrt-tenancy, and profile/audit models or document why this local implementation is intentionally isolated.',
        suggestedIssueTitle: `Review auth and tenancy adapters in ${packageLabel(owner)}`,
      },
    ];
  });
}

function findUiShellDrift(
  packages: PackageContext[],
  projectPath: string,
): Finding[] {
  return packages.flatMap((pkg) => {
    const hasUiSource = pkg.sourceFiles.some((file) =>
      file.path.endsWith('.svelte'),
    );
    const likelyUiPackage =
      hasUiSource ||
      /(?:web|ui|app|site|frontend)/i.test(packageLabel(pkg)) ||
      pkg.dependencies.has('svelte') ||
      pkg.dependencies.has('vite');
    if (!likelyUiPackage) return [];
    if (pkg.dependencies.has('@happyvertical/smrt-svelte')) return [];

    return [
      {
        severity: 'low',
        area: 'ui-shell',
        code: 'missing-smrt-svelte-shell',
        title: `${packageLabel(pkg)} looks like UI work without @happyvertical/smrt-svelte`,
        evidence: [
          {
            filePath: relative(projectPath, pkg.packageJsonPath),
            detail:
              'UI-facing package does not declare @happyvertical/smrt-svelte.',
          },
        ],
        recommendation:
          'Use @happyvertical/smrt-svelte and the SvelteKit shell pattern for downstream app UI unless this package is intentionally framework-agnostic.',
        suggestedIssueTitle: `Check SMRT Svelte shell alignment for ${packageLabel(pkg)}`,
      },
    ];
  });
}

function findMissingManifestArtifacts(
  sourceFiles: SourceFile[],
  packages: PackageContext[],
  projectPath: string,
): Finding[] {
  return packages.flatMap((pkg) => {
    const hasSmrtSource = pkg.sourceFiles.some((file) =>
      /@smrt\s*\(/.test(file.content),
    );
    if (!hasSmrtSource) return [];
    const hasManifest =
      sourceFiles.some(
        (file) =>
          file.packageDir === pkg.directory &&
          /@happyvertical\/smrt-scanner/.test(file.content),
      ) ||
      pathExistsSyncHint(join(pkg.directory, '.smrt', 'manifest.json')) ||
      pathExistsSyncHint(join(pkg.directory, 'dist', 'manifest.json'));
    if (hasManifest) return [];

    return [
      {
        severity: 'low',
        area: 'manifest',
        code: 'missing-generated-manifest-artifact',
        title: `${packageLabel(pkg)} has @smrt objects but no generated manifest artifact was found`,
        evidence: [
          {
            filePath: relative(projectPath, pkg.packageJsonPath),
            detail:
              'No .smrt/manifest.json or dist/manifest.json was visible during review.',
          },
        ],
        recommendation:
          'Run the package build/test manifest generation path and verify it uses the SMRT scanner/runtime manifest pipeline.',
        suggestedIssueTitle: `Verify SMRT manifest generation for ${packageLabel(pkg)}`,
      },
    ];
  });
}

async function visit(
  dir: string,
  onFile: (filePath: string, entryName: string) => Promise<void> | void,
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await visit(fullPath, onFile);
      continue;
    }
    if (entry.isFile()) await onFile(fullPath, entry.name);
  }
}

function collectDependencies(
  packageJson: Record<string, unknown>,
): Set<string> {
  const dependencies = new Set<string>();
  for (const sectionName of DEPENDENCY_SECTIONS) {
    const section = packageJson[sectionName];
    if (!isRecord(section)) continue;
    for (const dependencyName of Object.keys(section)) {
      dependencies.add(dependencyName);
    }
  }
  return dependencies;
}

function extractImports(content: string): string[] {
  const imports = new Set<string>();
  const patterns = [
    /(?:import|export)\s+(?:type\s+)?(?:[^'"]+\s+from\s+)?['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      const imported = normalizePackageImport(match[1]);
      if (imported) imports.add(imported);
    }
  }
  return Array.from(imports);
}

function normalizePackageImport(value: string | undefined): string | undefined {
  if (!value || value.startsWith('.') || value.startsWith('/'))
    return undefined;
  if (value.startsWith('@')) {
    const [scope, name] = value.split('/');
    return scope && name ? `${scope}/${name}` : value;
  }
  return value.split('/')[0];
}

function findOwningPackage(
  filePath: string,
  packages: PackageContext[],
): PackageContext {
  const normalized = resolve(filePath);
  const matches = packages
    .filter(
      (pkg) =>
        normalized === pkg.directory ||
        normalized.startsWith(`${pkg.directory}${sep}`),
    )
    .sort((left, right) => right.directory.length - left.directory.length);
  return matches[0] ?? packages[0];
}

function packageInventory(pkg: PackageContext): PackageInventory {
  const declaredHappyVerticalDependencies = Array.from(pkg.dependencies)
    .filter((dependency) => dependency.startsWith(HAPPYVERTICAL_PACKAGE_PREFIX))
    .sort();
  const importedHappyVerticalPackages = Array.from(pkg.imports.keys()).sort();
  const ownName = typeof pkg.json.name === 'string' ? pkg.json.name : undefined;
  return {
    name: packageLabel(pkg),
    path: pkg.relativePath,
    private:
      typeof pkg.json.private === 'boolean' ? pkg.json.private : undefined,
    scripts: Object.keys(pkg.scripts).sort(),
    declaredHappyVerticalDependencies,
    importedHappyVerticalPackages,
    missingHappyVerticalDependencies: importedHappyVerticalPackages.filter(
      (name) => name !== ownName && !pkg.dependencies.has(name),
    ),
    hasSvelteKit: pkg.dependencies.has('@sveltejs/kit'),
    hasSmrtSvelte: pkg.dependencies.has('@happyvertical/smrt-svelte'),
  };
}

function summarizeFindings(findings: Finding[]): Record<Severity, number> {
  return findings.reduce(
    (summary, finding) => {
      summary[finding.severity]++;
      return summary;
    },
    { high: 0, medium: 0, low: 0 },
  );
}

function limitFindings(
  findings: Finding[],
  maxFindings: number | undefined,
): Finding[] {
  const sorted = findings.sort(
    (left, right) =>
      severityRank(left.severity) - severityRank(right.severity) ||
      left.area.localeCompare(right.area) ||
      left.title.localeCompare(right.title),
  );
  return maxFindings && maxFindings > 0 ? sorted.slice(0, maxFindings) : sorted;
}

function severityRank(severity: Severity): number {
  return severity === 'high' ? 0 : severity === 'medium' ? 1 : 2;
}

function packageLabel(pkg: PackageContext): string {
  return typeof pkg.json.name === 'string' ? pkg.json.name : pkg.relativePath;
}

function lineNumber(content: string, needle: string): number | undefined {
  const index = content.indexOf(needle);
  if (index < 0) return undefined;
  return content.slice(0, index).split('\n').length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function pathExistsSyncHint(path: string): boolean {
  return existsSync(path);
}

interface DuplicateDetectionStatus {
  enabled: boolean;
  indexPath: string | null;
  intentCount: number;
  notes: string[];
}

async function runDuplicateDetection(
  args: ReviewSmrtProjectArgs,
  projectPath: string,
  packageContexts: PackageContext[],
): Promise<{ findings: Finding[]; status: DuplicateDetectionStatus }> {
  const status: DuplicateDetectionStatus = {
    enabled: args.detectDuplicates !== false,
    indexPath: null,
    intentCount: 0,
    notes: [],
  };
  if (!status.enabled) return { findings: [], status };

  const explicit = args.intentIndexPath
    ? isAbsolute(args.intentIndexPath)
      ? args.intentIndexPath
      : resolve(projectPath, args.intentIndexPath)
    : undefined;
  const candidates = explicit
    ? [explicit]
    : defaultIntentIndexCandidates(args.packageRoot);
  const indexPath = candidates.find((candidate) => existsSync(candidate));
  if (!indexPath) {
    status.notes.push(
      `No intent index found (tried ${candidates.join(', ') || 'none'}); duplicate detection skipped. Reinstall @happyvertical/smrt-dev-mcp or pass intentIndexPath.`,
    );
    return { findings: [], status };
  }

  const rows: IntentRow[] = parseIntentIndex(
    await readFile(indexPath, 'utf-8'),
  );
  status.indexPath = indexPath;
  status.intentCount = rows.length;
  if (rows.length === 0) {
    status.notes.push(`Intent index ${indexPath} has no parsable rows.`);
    return { findings: [], status };
  }

  // Only SMRT consumers get advice: a project with no @happyvertical/smrt-*
  // dependency or import has no installed home package to prefer.
  const isSmrtConsumer = packageContexts.some(
    (pkg) =>
      Array.from(pkg.dependencies).some((name) =>
        name.startsWith(SMRT_PACKAGE_PREFIX),
      ) ||
      Array.from(pkg.imports.keys()).some((name) =>
        name.startsWith(SMRT_PACKAGE_PREFIX),
      ),
  );
  if (!isSmrtConsumer) {
    status.notes.push(
      'No @happyvertical/smrt-* dependency or import found; duplicate detection skipped.',
    );
    return { findings: [], status };
  }

  const homeNames = new Set(
    rows.flatMap((row) => row.homePackages.map((home) => home.packageName)),
  );
  const packages: DetectorPackage[] = packageContexts.map((pkg) => ({
    name: typeof pkg.json.name === 'string' ? pkg.json.name : undefined,
    relativePath: pkg.relativePath,
    installed: new Set(
      Array.from(homeNames).filter(
        (name) =>
          pkg.dependencies.has(name) ||
          existsSync(join(pkg.directory, 'node_modules', name)) ||
          existsSync(join(projectPath, 'node_modules', name)),
      ),
    ),
    files: pkg.sourceFiles.map((file) => ({
      relativePath: relative(projectPath, file.path),
      content: file.content,
      imports: extractImports(file.content),
    })),
  }));

  const detected = detectHandRolled(rows, packages, {
    onNote: (note) => {
      status.notes.push(note);
      process.stderr.write(`[smrt-dev-mcp] ${note}\n`);
    },
  });
  return { findings: detected.map(duplicateFinding), status };
}

function duplicateFinding(found: HandRolledFinding): Finding {
  const first = found.evidence[0];
  const installedUnused = found.installedHomePackages.length > 0;
  const homeList = found.homePackages.join(', ');
  const title = `${found.packageName} appears to hand-roll "${found.intent}"`;
  return {
    severity: installedUnused ? 'medium' : 'low',
    area: 'duplicate-detection',
    code: found.code,
    title,
    message: `${title} (signals: ${found.matchedSignals.join(', ')}); ${
      installedUnused
        ? `${found.installedHomePackages.join(', ')} is installed but never imported`
        : `none of ${homeList} is imported`
    }. Intent page ${found.intentPage}; component pages ${found.componentPages.join(', ')}.`,
    file: `${first.filePath}:${first.line}`,
    packageName: found.packageName,
    intentPage: found.intentPage,
    componentPages: found.componentPages,
    evidence: found.evidence.map((item) => ({
      filePath: item.filePath,
      line: item.line,
      detail: item.detail,
    })),
    recommendation: `Read ${found.intentPage} before keeping this implementation; the framework entry point is ${found.entryPoint} (${found.componentPages.join(', ')}). Advisory only: keep the hand-rolled code if it covers a case the package does not.`,
    suggestedIssueTitle: `Evaluate ${homeList} instead of hand-rolled ${found.intent.toLowerCase()} in ${found.packageName}`,
  };
}
