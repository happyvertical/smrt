import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import {
  MODULE_DOC_HASH_PREFIX,
  readAgentModuleDocs,
} from '@happyvertical/smrt-core/knowledge';
import { ManifestAdapter, OxcScanner } from '@happyvertical/smrt-scanner';
import type {
  DomainKnowledgeManifest,
  DomainKnowledgeModuleDoc,
} from '@happyvertical/smrt-types';

export type KnowledgePackageKind = 'smrt' | 'sdk' | 'workspace';
export type KnowledgeIssueSeverity = 'error' | 'warning';
export type KnowledgeScope = 'project' | 'local' | 'package' | 'sdk';

/**
 * Where a package's objects actually came from (#2143). Recording provenance is
 * what makes an empty answer distinguishable from an unseen one: `none` means
 * discovery failed or the package has no SMRT model, and only the recorded
 * reason says which.
 */
export type KnowledgeObjectSource =
  | 'domain-artifact'
  | 'manifest'
  | 'scanner'
  | 'none';

/**
 * `summary` keeps prompt bundles inside tool-result budgets by listing authored
 * docs by path instead of embedding them; `full` restores embedding (#2143).
 */
export type KnowledgeDetail = 'summary' | 'full';

/** Where the workspace package globs were read from. */
export type WorkspaceGlobSource =
  | 'pnpm-workspace.yaml'
  | 'package.json#workspaces'
  | 'fallback';

export interface KnowledgeField {
  name: string;
  type: string;
  required?: boolean;
  related?: string;
  columnType?: string;
}

export interface KnowledgeObject {
  className: string;
  qualifiedName?: string;
  filePath?: string;
  extends?: string;
  collection?: string;
  mcpOperations: string[];
  tableName?: string;
  idColumnType?: string;
  fields: KnowledgeField[];
  relationships: KnowledgeField[];
  methods: string[];
}

export interface KnowledgePrompt {
  filePath: string;
  key?: string;
}

export interface KnowledgeMcpTool {
  name: string;
  sourceObject: string;
  operation: string;
}

export type KnowledgeModuleDoc = DomainKnowledgeModuleDoc;

export interface KnowledgePackage {
  name: string;
  version: string;
  kind: KnowledgePackageKind;
  directory: string;
  relativeDirectory: string;
  files: string[];
  exportKeys: string[];
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
  smrtDependencies: string[];
  sdkDependencies: string[];
  hasAgentsMd: boolean;
  hasClaudeMd: boolean;
  hasClaudeShim: boolean;
  docSource: 'AGENTS.md' | 'CLAUDE.md' | null;
  agentDoc?: string;
  /**
   * Sibling module docs linked from the package's `AGENTS.md` (#2108). Oversized
   * package docs are split by module into `agents/<module>.md` rather than nested
   * `AGENTS.md` files (chains are additive), so this prose is only reachable
   * through the links — and it is curated, not regenerable from the manifest.
   */
  moduleDocs: KnowledgeModuleDoc[];
  hasDomainKnowledge: boolean;
  domainKnowledgePath?: string;
  domainKnowledge?: DomainKnowledgeManifest;
  manifestPath?: string;
  manifestVersion?: string;
  objects: KnowledgeObject[];
  prompts: KnowledgePrompt[];
  mcpTools: KnowledgeMcpTool[];
  relationshipFeatures: string[];
  /** True for the workspace root itself, which is not a publishable package. */
  isWorkspaceRoot: boolean;
  /** `private: true` packages publish nothing, so packaging rules do not apply. */
  isPrivate: boolean;
  objectSource: KnowledgeObjectSource;
  /**
   * Machine-readable reason a package produced no objects, or a note about
   * objects rejected during ownership validation.
   */
  objectSourceReason?: string;
  /** Artifact paths consulted while resolving objects, relative to the root. */
  checkedObjectPaths: string[];
}

/** A package the index looked at but got no objects from, and why (#2143). */
export interface KnowledgeCoverageGap {
  name: string;
  reason: string;
  checkedPaths: string[];
  remedy: string;
}

/**
 * What the index actually saw. Without this, a caller cannot tell "this project
 * has no relationships" from "I could not see this project" (#2143).
 */
export interface KnowledgeCoverage {
  workspaceGlobs: string[];
  workspaceGlobSource: WorkspaceGlobSource;
  packageDirs: string[];
  packagesWithObjects: string[];
  packagesWithoutObjects: KnowledgeCoverageGap[];
}

/**
 * A discovery-quality signal, kept separate from `KnowledgeIssue` so coverage
 * reporting never feeds the `dev:knowledge-check` freshness gate.
 */
export interface KnowledgeDiagnostic {
  severity: KnowledgeIssueSeverity;
  code: string;
  message: string;
  packageName?: string;
  checkedPaths?: string[];
  remedy?: string;
}

export interface SmrtKnowledgeIndex {
  /** 2 adds `coverage` and `diagnostics` (additive, #2143). */
  schemaVersion: 2;
  generatedAt: string;
  rootDir: string;
  packages: KnowledgePackage[];
  smrtPackages: KnowledgePackage[];
  sdkPackages: KnowledgePackage[];
  relationshipsV2: {
    foreignKeyFields: number;
    crossPackageRefFields: number;
    junctionCollections: number;
    hierarchicalObjects: number;
    polymorphicAssociations: number;
    uuidColumns: number;
  };
  coverage: KnowledgeCoverage;
  diagnostics: KnowledgeDiagnostic[];
}

export interface KnowledgeIssue {
  severity: KnowledgeIssueSeverity;
  code: string;
  message: string;
  file?: string;
  packageName?: string;
}

export interface KnowledgeFreshnessResult {
  ok: boolean;
  checkedAt: string;
  rootDir: string;
  issueCount: number;
  errorCount: number;
  warningCount: number;
  issues: KnowledgeIssue[];
}

export interface KnowledgePromptBundle {
  title: string;
  instructions: string;
  contextMarkdown: string;
  selectedPackages: string[];
  selectedSdkPackages: string[];
  sourceFiles: string[];
}

export interface ReviewContextResult {
  selectedPackages: KnowledgePackage[];
  selectedSdkPackages: KnowledgePackage[];
  deterministicFindings: KnowledgeIssue[];
  promptBundle: KnowledgePromptBundle;
  coverage: KnowledgeCoverage;
  diagnostics: KnowledgeDiagnostic[];
}

export interface ArchitectureContextResult {
  selectedPackages: KnowledgePackage[];
  selectedSdkPackages: KnowledgePackage[];
  promptBundle: KnowledgePromptBundle;
  coverage: KnowledgeCoverage;
  diagnostics: KnowledgeDiagnostic[];
}

export interface SmrtReviewResult {
  mode: 'findings' | 'prompt-bundle' | 'both';
  selectedPackages: KnowledgePackage[];
  selectedSdkPackages: KnowledgePackage[];
  deterministicFindings?: KnowledgeIssue[];
  promptBundle?: KnowledgePromptBundle;
  coverage: KnowledgeCoverage;
  diagnostics: KnowledgeDiagnostic[];
}

export interface SmrtArchitectureResult extends ArchitectureContextResult {
  recommendations: {
    smrtPackages: string[];
    sdkPackages: string[];
    objectModelSketch: string[];
    risks: string[];
    questions: string[];
    notes: string[];
  };
}

interface BuildKnowledgeIndexOptions {
  rootDir?: string;
  includeDocs?: boolean;
  scope?: KnowledgeScope;
  package?: string;
  packageName?: string;
}

interface CheckKnowledgeFreshnessOptions extends BuildKnowledgeIndexOptions {
  changed?: boolean;
  strict?: boolean;
}

/**
 * Signals used to narrow which module docs a prompt bundle embeds (#2108).
 * Absent or non-matching hints mean "embed everything" — see `selectModuleDocs`.
 */
interface ModuleDocHints {
  changedFiles?: string[];
  text?: string;
}

interface ContextSelectorOptions {
  rootDir?: string;
  changedFiles?: string[];
  idea?: string;
  documentation?: string;
  focus?: string;
  scope?: KnowledgeScope;
  package?: string;
  packageName?: string;
  /**
   * Defaults to `summary` so MCP callers stay inside tool-result budgets. CLI
   * consumers pass `full` to keep the #2108 module-doc embedding contract.
   */
  detail?: KnowledgeDetail;
}

const SDK_PACKAGE_NAMES = new Set([
  '@happyvertical/ai',
  '@happyvertical/cache',
  '@happyvertical/documents',
  '@happyvertical/email',
  '@happyvertical/encryption',
  '@happyvertical/files',
  '@happyvertical/geo',
  '@happyvertical/images',
  '@happyvertical/jobs',
  '@happyvertical/json',
  '@happyvertical/logger',
  '@happyvertical/messages',
  '@happyvertical/ocr',
  '@happyvertical/pdf',
  '@happyvertical/projects',
  '@happyvertical/repos',
  '@happyvertical/secrets',
  '@happyvertical/spider',
  '@happyvertical/sql',
  '@happyvertical/utils',
]);

const RELATIONSHIP_FIELD_TYPES = new Set([
  'foreignKey',
  'crossPackageRef',
  'oneToMany',
  'manyToMany',
]);

const WALK_SKIP_DIRS = new Set([
  '.git',
  '.svelte-kit',
  '.turbo',
  'coverage',
  'dist',
  'node_modules',
]);

/** Used only when neither pnpm-workspace.yaml nor package.json#workspaces exists. */
const WORKSPACE_GLOB_FALLBACK = ['packages/*'];

/** Bounds `**` expansion so a stray glob cannot walk an entire disk. */
const MAX_GLOB_DEPTH = 6;

/** Caps the downstream package fallback so a large product stays in budget. */
const MAX_FALLBACK_PACKAGES = 8;

/** Kept in sync with `tools/introspect-project.ts` so both paths see one corpus. */
const SCAN_INCLUDE = ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'];

const SCAN_EXCLUDE = [
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/.git/**',
  '**/.smrt/**',
  '**/*.d.ts',
  '**/*.test.ts',
  '**/*.spec.ts',
  '**/__tests__/**',
];

const STALE_PATTERNS: Array<{
  code: string;
  pattern: RegExp;
  message: string;
}> = [
  {
    code: 'stale-have-namespace',
    pattern: new RegExp(`@${'have'}/`),
    message: 'Stale HappyVertical legacy namespace reference found',
  },
  {
    code: 'stale-smrt-core-namespace',
    pattern: new RegExp(`@${'smrt'}/core`),
    message: 'Stale SMRT core namespace reference found',
  },
  {
    code: 'stale-field-helper-import',
    pattern: /@happyvertical\/smrt-core\/fields/,
    message: 'Stale field-helper import path found',
  },
  {
    code: 'stale-docs-codex-command',
    pattern: new RegExp(
      `docs:${'codex'}|docs-${'codex'}|\\.${'codex'}|${'codex'}-command`,
      'i',
    ),
    message: 'Stale Codex-specific downstream-doc reference found',
  },
];

export async function buildKnowledgeIndex(
  options: BuildKnowledgeIndexOptions = {},
): Promise<SmrtKnowledgeIndex> {
  const rootDir = findProjectRoot(options.rootDir ?? process.cwd());
  const includeDocs = options.includeDocs ?? true;
  const {
    globs,
    globSource,
    dirs: packageDirs,
  } = discoverProjectPackageDirs(rootDir);
  const packages = packageDirs.map((dir) =>
    readKnowledgePackage(rootDir, dir, includeDocs),
  );

  // A monorepo root would otherwise scan every member package and claim all of
  // their objects as its own; members resolve themselves below.
  const rootDelegates = packageDirs.length > 1;
  await Promise.all(
    packages.map((pkg) => {
      if (pkg.isWorkspaceRoot && rootDelegates) {
        if (pkg.objectSource === 'none') {
          pkg.objectSourceReason =
            'workspace-root-delegates-to-member-packages';
        }
        return Promise.resolve();
      }
      return applyScannerFallback(pkg);
    }),
  );

  packages.push(
    ...discoverInstalledSdkPackages(rootDir, packageDirs, includeDocs),
  );

  const uniquePackages = dedupePackages(packages);
  const scopedPackages = filterKnowledgePackages(uniquePackages, options);
  const smrtPackages = scopedPackages.filter((pkg) => pkg.kind === 'smrt');
  const sdkPackages = scopedPackages.filter((pkg) => pkg.kind === 'sdk');
  const coverage = buildCoverage({
    rootDir,
    globs,
    globSource,
    packageDirs,
    packages: scopedPackages,
  });

  return {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    rootDir,
    packages: scopedPackages,
    smrtPackages,
    sdkPackages,
    relationshipsV2: summarizeRelationshipsV2(scopedPackages),
    coverage,
    diagnostics: buildIndexDiagnostics(rootDir, scopedPackages, coverage),
  };
}

function buildCoverage(options: {
  rootDir: string;
  globs: string[];
  globSource: WorkspaceGlobSource;
  packageDirs: string[];
  packages: KnowledgePackage[];
}): KnowledgeCoverage {
  return {
    workspaceGlobs: options.globs,
    workspaceGlobSource: options.globSource,
    packageDirs: options.packageDirs.map(
      (dir) => relative(options.rootDir, dir) || '.',
    ),
    packagesWithObjects: options.packages
      .filter((pkg) => pkg.objects.length > 0)
      .map((pkg) => `${pkg.name} (${pkg.objects.length}, ${pkg.objectSource})`),
    packagesWithoutObjects: options.packages
      .filter((pkg) => pkg.objects.length === 0)
      .map((pkg) => ({
        name: pkg.name,
        reason: pkg.objectSourceReason ?? pkg.objectSource,
        checkedPaths: pkg.checkedObjectPaths,
        remedy: remedyForReason(pkg),
      })),
  };
}

function remedyForReason(pkg: KnowledgePackage): string {
  const reason = pkg.objectSourceReason ?? '';
  if (reason.startsWith('manifest-objects-owned-by-other-packages')) {
    return `${pkg.relativeDirectory || '.'} has an aggregate or stale manifest owned by other packages. Regenerate it (pnpm build in that package) so it declares this package's own objects.`;
  }
  if (reason.startsWith('scanner-failed')) {
    return `Source scanning failed for ${pkg.relativeDirectory || '.'}; fix the parse error or generate a manifest with pnpm build.`;
  }
  if (reason === 'no-smrt-objects-in-sources') {
    return 'No @smrt() classes were found in this package. Expected if it is a UI, contract, or tooling package.';
  }
  if (reason === 'workspace-root-delegates-to-member-packages') {
    return 'Expected: the workspace root delegates object discovery to its member packages.';
  }
  return `Add @smrt() classes, or run pnpm build in ${pkg.relativeDirectory || '.'} to emit .smrt/manifest.json.`;
}

/**
 * Turns a discovery failure into an explicit signal.
 *
 * A zero-object index used to be indistinguishable from a project with no
 * relationships, so callers acted on empty context as if it were an answer
 * (#2143). The zero case is therefore error-grade and names what was checked.
 */
function buildIndexDiagnostics(
  rootDir: string,
  packages: KnowledgePackage[],
  coverage: KnowledgeCoverage,
): KnowledgeDiagnostic[] {
  const diagnostics: KnowledgeDiagnostic[] = [];
  const totalObjects = packages.reduce(
    (total, pkg) => total + pkg.objects.length,
    0,
  );

  if (totalObjects === 0) {
    diagnostics.push({
      severity: 'error',
      code: 'no-smrt-objects-discovered',
      message: [
        `No SMRT objects were discovered under ${rootDir}.`,
        `Workspace globs (${coverage.workspaceGlobSource}): ${coverage.workspaceGlobs.join(', ') || '(none)'}.`,
        `Package directories checked (${coverage.packageDirs.length}): ${coverage.packageDirs.join(', ') || '(none)'}.`,
        'Treat this as a discovery failure, not as evidence that the project has no SMRT model.',
      ].join(' '),
      checkedPaths: [
        ...new Set(packages.flatMap((pkg) => pkg.checkedObjectPaths)),
      ],
      remedy: [
        'Confirm rootDir is the workspace root;',
        'confirm pnpm-workspace.yaml `packages:` covers the directories that hold @smrt() classes (for example apps/*);',
        'run `pnpm build` in the owning package to emit .smrt/manifest.json;',
        'then re-run. Cross-check with introspect-project on the same root.',
      ].join(' '),
    });
  }

  for (const pkg of packages) {
    const reason = pkg.objectSourceReason ?? '';
    if (reason.startsWith('manifest-objects-owned-by-other-packages')) {
      diagnostics.push({
        severity: 'warning',
        code: 'foreign-manifest-objects',
        message: `${pkg.name}: every object in the discovered manifest is owned by another package (${reason}); it was rejected instead of being counted as this package's.`,
        packageName: pkg.name,
        checkedPaths: pkg.checkedObjectPaths,
        remedy: remedyForReason(pkg),
      });
      continue;
    }
    if (reason.startsWith('rejected ')) {
      diagnostics.push({
        severity: 'warning',
        code: 'partial-foreign-manifest-objects',
        message: `${pkg.name}: ${reason}.`,
        packageName: pkg.name,
        checkedPaths: pkg.checkedObjectPaths,
        remedy: remedyForReason(pkg),
      });
      continue;
    }
    if (reason.startsWith('scanner-failed')) {
      diagnostics.push({
        severity: 'warning',
        code: 'scanner-fallback-failed',
        message: `${pkg.name}: ${reason}`,
        packageName: pkg.name,
        checkedPaths: pkg.checkedObjectPaths,
        remedy: remedyForReason(pkg),
      });
    }
  }

  diagnostics.push(...buildDuplicateIdentityDiagnostics(packages));
  return diagnostics;
}

/**
 * Reports one table claimed by more than one package. Relationships-v2 already
 * counts it once, but the duplication itself usually means a stale or
 * re-qualified generated artifact, which the caller should know about (#2143).
 */
function buildDuplicateIdentityDiagnostics(
  packages: KnowledgePackage[],
): KnowledgeDiagnostic[] {
  const owners = new Map<string, string[]>();
  for (const pkg of packages) {
    for (const object of pkg.objects) {
      const identity = objectIdentity(object);
      const current = owners.get(identity) ?? [];
      if (!current.includes(pkg.name)) current.push(pkg.name);
      owners.set(identity, current);
    }
  }

  const duplicates = [...owners.entries()].filter(
    ([, names]) => names.length > 1,
  );
  if (duplicates.length === 0) return [];

  const sample = duplicates
    .slice(0, 5)
    .map(([identity, names]) => `${identity} (${names.join(' + ')})`)
    .join('; ');

  return [
    {
      severity: 'warning',
      code: 'duplicate-object-identity',
      message: `${duplicates.length} object identit${duplicates.length === 1 ? 'y is' : 'ies are'} reported by more than one package: ${sample}${duplicates.length > 5 ? '; …' : ''}. Relationships-v2 counts each once.`,
      remedy:
        "Usually a stale or aggregate generated artifact in a consuming package that re-qualifies its dependencies' objects. Regenerate it (pnpm build) so each package reports only the objects it declares.",
    },
  ];
}

export async function checkKnowledgeFreshness(
  options: CheckKnowledgeFreshnessOptions = {},
): Promise<KnowledgeFreshnessResult> {
  const index = await buildKnowledgeIndex(options);
  return checkKnowledgeFreshnessFromIndex(index, options);
}

export async function checkKnowledgeFreshnessFromIndex(
  index: SmrtKnowledgeIndex,
  options: CheckKnowledgeFreshnessOptions = {},
): Promise<KnowledgeFreshnessResult> {
  const issues: KnowledgeIssue[] = [];
  const changedFiles = options.changed
    ? getChangedFiles(index.rootDir)
    : undefined;

  // Keep these structured MCP/CLI checks in sync with
  // scripts/check-standards.mjs, which enforces the same package docs rules.
  // The workspace root is not a publishable package, so the packaging rules
  // (files allowlist, shipped docs) do not apply to it — it only became visible
  // to this loop when discovery stopped gating root inclusion (#2143).
  for (const pkg of index.packages.filter(
    (item) => item.kind !== 'sdk' && !item.isWorkspaceRoot,
  )) {
    const packageJsonPath = join(pkg.directory, 'package.json');

    if (!pkg.hasAgentsMd) {
      issues.push({
        severity: 'error',
        code: 'missing-agents-md',
        message: 'Workspace package is missing canonical AGENTS.md',
        file: relative(index.rootDir, join(pkg.directory, 'AGENTS.md')),
        packageName: pkg.name,
      });
    }

    if (!pkg.hasClaudeMd) {
      issues.push({
        severity: 'error',
        code: 'missing-claude-shim',
        message: 'Workspace package is missing CLAUDE.md compatibility shim',
        file: relative(index.rootDir, join(pkg.directory, 'CLAUDE.md')),
        packageName: pkg.name,
      });
    } else if (!pkg.hasClaudeShim) {
      issues.push({
        severity: 'error',
        code: 'claude-not-shim',
        message: 'CLAUDE.md must contain only @AGENTS.md',
        file: relative(index.rootDir, join(pkg.directory, 'CLAUDE.md')),
        packageName: pkg.name,
      });
    }

    for (const entry of pkg.files) {
      if (
        entry === 'dist' ||
        entry.startsWith('dist/') ||
        entry.includes('*')
      ) {
        continue;
      }
      const entryPath = join(pkg.directory, entry);
      if (!existsSync(entryPath)) {
        issues.push({
          severity: 'error',
          code: 'package-files-entry-missing',
          message: `package.json files entry "${entry}" does not exist`,
          file: relative(index.rootDir, packageJsonPath),
          packageName: pkg.name,
        });
      }
    }

    // The `files` allowlist governs what ships to npm, so it is meaningless for
    // a `private: true` package. Authored docs are still required above —
    // agents read those regardless of publishing.
    if (pkg.isPrivate) continue;

    if (!pkg.files.includes('AGENTS.md')) {
      issues.push({
        severity: 'error',
        code: 'package-files-missing-agents',
        message: 'package.json files allowlist must include AGENTS.md',
        file: relative(index.rootDir, packageJsonPath),
        packageName: pkg.name,
      });
    }

    if (!pkg.files.includes('CLAUDE.md')) {
      issues.push({
        severity: 'error',
        code: 'package-files-missing-claude-shim',
        message: 'package.json files allowlist must include CLAUDE.md shim',
        file: relative(index.rootDir, packageJsonPath),
        packageName: pkg.name,
      });
    }
  }

  for (const pkg of index.packages) {
    issues.push(...checkDomainKnowledgeArtifact(index.rootDir, pkg));
  }

  issues.push(...findStalePatternIssues(index.rootDir, changedFiles));

  const effectiveIssues = issues.map((issue) =>
    issue.code.startsWith('stale-')
      ? {
          ...issue,
          severity: options.strict ? ('error' as const) : ('warning' as const),
        }
      : issue,
  );
  const errorCount = effectiveIssues.filter(
    (i) => i.severity === 'error',
  ).length;
  const warningCount = effectiveIssues.filter(
    (i) => i.severity === 'warning',
  ).length;

  return {
    ok: errorCount === 0,
    checkedAt: new Date().toISOString(),
    rootDir: index.rootDir,
    issueCount: effectiveIssues.length,
    errorCount,
    warningCount,
    issues: effectiveIssues,
  };
}

function checkDomainKnowledgeArtifact(
  rootDir: string,
  pkg: KnowledgePackage,
): KnowledgeIssue[] {
  const issues: KnowledgeIssue[] = [];
  if (
    pkg.exportKeys.includes('./smrt-knowledge.json') &&
    !pkg.hasDomainKnowledge
  ) {
    issues.push({
      severity: 'error',
      code: 'missing-domain-knowledge',
      message:
        'package exports ./smrt-knowledge.json but no domain knowledge artifact was found',
      file: relative(rootDir, join(pkg.directory, 'package.json')),
      packageName: pkg.name,
    });
  }

  if (!pkg.domainKnowledge || !pkg.domainKnowledgePath) {
    return issues;
  }

  const hashes = pkg.domainKnowledge.sourceHashes ?? {};
  const checks: Array<{
    key: string;
    filePath: string | undefined;
    kind: 'raw' | 'json';
    label: string;
  }> = [
    {
      key: 'packageJson',
      filePath: join(pkg.directory, 'package.json'),
      kind: 'raw',
      label: 'package.json',
    },
    {
      key: 'agents',
      filePath: existsSync(join(pkg.directory, 'AGENTS.md'))
        ? join(pkg.directory, 'AGENTS.md')
        : undefined,
      kind: 'raw',
      label: 'AGENTS.md',
    },
    {
      key: 'manifest',
      filePath: domainSourceManifestPath(rootDir, pkg),
      kind: 'json',
      label: 'manifest',
    },
    // Module docs linked from AGENTS.md are authored sources too (#2108), so an
    // edit to one must mark the artifact stale exactly like an AGENTS.md edit.
    ...Object.keys(hashes)
      .filter((key) => key.startsWith(MODULE_DOC_HASH_PREFIX))
      .sort()
      .map((key) => {
        const docPath = key.slice(MODULE_DOC_HASH_PREFIX.length);
        const filePath = join(pkg.directory, docPath);
        return {
          key,
          filePath: existsSync(filePath) ? filePath : undefined,
          kind: 'raw' as const,
          label: docPath,
        };
      }),
  ];

  for (const check of checks) {
    const expected = hashes[check.key];
    if (!expected) continue;
    if (!check.filePath || !existsSync(check.filePath)) {
      issues.push({
        severity: 'error',
        code: 'domain-knowledge-source-missing',
        message: `${check.label} source for smrt-knowledge.json is missing`,
        file: pkg.domainKnowledgePath,
        packageName: pkg.name,
      });
      continue;
    }

    const actual =
      check.kind === 'json'
        ? hashJsonFile(check.filePath)
        : hashFile(check.filePath);
    if (actual !== expected) {
      issues.push({
        severity: 'error',
        code: 'stale-domain-knowledge',
        message: `${check.label} changed since smrt-knowledge.json was generated`,
        file: pkg.domainKnowledgePath,
        packageName: pkg.name,
      });
    }
  }

  return issues;
}

function domainSourceManifestPath(
  rootDir: string,
  pkg: KnowledgePackage,
): string | undefined {
  if (pkg.domainKnowledge?.sourceManifestPath) {
    return join(pkg.directory, pkg.domainKnowledge.sourceManifestPath);
  }
  if (pkg.manifestPath) {
    return join(rootDir, pkg.manifestPath);
  }
  return undefined;
}

export async function diffKnowledgeIndex(
  options: {
    rootDir?: string;
    base?: string;
    scope?: KnowledgeScope;
    package?: string;
    packageName?: string;
  } = {},
): Promise<{
  base: string;
  changedFiles: string[];
  changedPackages: string[];
  index: SmrtKnowledgeIndex;
}> {
  const index = await buildKnowledgeIndex({ rootDir: options.rootDir });
  const base = options.base ?? 'HEAD';
  const changedFiles = getChangedFiles(index.rootDir, base);
  const packageQuery = options.packageName ?? options.package;
  const selected = selectPackagesForFiles(index, changedFiles)
    .filter((pkg) => scopeAllowsPackage(pkg, options.scope))
    .filter((pkg) =>
      packageQuery ? packageMatches(pkg, packageQuery.toLowerCase()) : true,
    );
  const changedPackages = selected.map((pkg) => pkg.name);
  return { base, changedFiles, changedPackages, index };
}

export async function buildReviewContext(
  options: ContextSelectorOptions = {},
): Promise<ReviewContextResult> {
  const index = await buildKnowledgeIndex({ rootDir: options.rootDir });
  const changedFiles = options.changedFiles ?? getChangedFiles(index.rootDir);
  const selectedPackages = selectPackages(index, {
    changedFiles,
    text: [options.focus, options.documentation].filter(Boolean).join('\n'),
    scope: options.scope,
    packageName: options.packageName ?? options.package,
  });
  const selectedSdkPackages = selectSdkPackages(
    index,
    selectedPackages,
    [
      options.focus,
      options.documentation,
      options.packageName ?? options.package,
    ],
    {
      scope: options.scope,
      packageName: options.packageName ?? options.package,
    },
  );
  const deterministicFindings = findStalePatternIssues(
    index.rootDir,
    changedFiles.length > 0 ? changedFiles : undefined,
  ).concat(buildReviewFindings(index, changedFiles, selectedPackages));

  return {
    selectedPackages,
    selectedSdkPackages,
    deterministicFindings,
    promptBundle: buildPromptBundle({
      title: 'SMRT code review',
      task: 'Review the changed SMRT code. Prioritize correctness, relationships-v2 invariants, tenancy, SDK usage, prompt/data safety, and stale documentation.',
      index,
      packages: selectedPackages,
      sdkPackages: selectedSdkPackages,
      sourceFiles: changedFiles,
      extraContext: options.focus,
      detail: options.detail,
      moduleDocHints: {
        changedFiles,
        text: [options.focus, options.documentation].filter(Boolean).join('\n'),
      },
    }),
    coverage: index.coverage,
    diagnostics: index.diagnostics,
  };
}

export async function smrtReview(
  options: ContextSelectorOptions & {
    mode?: 'findings' | 'prompt-bundle' | 'both';
  } = {},
): Promise<SmrtReviewResult> {
  const context = await buildReviewContext(options);
  const mode = options.mode ?? 'both';
  return {
    mode,
    selectedPackages: context.selectedPackages,
    selectedSdkPackages: context.selectedSdkPackages,
    ...(mode !== 'prompt-bundle'
      ? { deterministicFindings: context.deterministicFindings }
      : {}),
    ...(mode !== 'findings' ? { promptBundle: context.promptBundle } : {}),
    coverage: context.coverage,
    diagnostics: context.diagnostics,
  };
}

export async function buildArchitectureContext(
  options: ContextSelectorOptions = {},
): Promise<ArchitectureContextResult> {
  const index = await buildKnowledgeIndex({ rootDir: options.rootDir });
  const text = [options.idea, options.documentation, options.focus]
    .filter(Boolean)
    .join('\n');
  const selectedPackages = selectPackages(index, {
    text,
    scope: options.scope,
    packageName: options.packageName ?? options.package,
  });
  const selectedSdkPackages = selectSdkPackages(
    index,
    selectedPackages,
    [text, options.packageName ?? options.package],
    {
      scope: options.scope,
      packageName: options.packageName ?? options.package,
    },
  );

  return {
    selectedPackages,
    selectedSdkPackages,
    promptBundle: buildPromptBundle({
      title: 'SMRT architecture planning',
      task: 'Suggest the SMRT packages, HappyVertical SDK packages, object model, integration points, risks, and implementation slices for this project idea.',
      index,
      packages: selectedPackages,
      sdkPackages: selectedSdkPackages,
      sourceFiles: [],
      extraContext: text,
      detail: options.detail,
      // `--package @happyvertical/smrt-sales` alone must NOT narrow: the package
      // selector is not a module selector, so a bare package request still gets
      // every module doc. Only idea/focus text narrows.
      moduleDocHints: { text },
    }),
    coverage: index.coverage,
    diagnostics: index.diagnostics,
  };
}

export async function smrtArchitecture(
  options: ContextSelectorOptions = {},
): Promise<SmrtArchitectureResult> {
  const context = await buildArchitectureContext(options);
  const ideaText = [options.idea, options.documentation, options.focus]
    .filter(Boolean)
    .join('\n');
  return {
    ...context,
    recommendations: buildArchitectureRecommendations(context, ideaText),
  };
}

export function renderKnowledgeIndexMarkdown(
  index: SmrtKnowledgeIndex,
): string {
  const lines: string[] = [
    '# SMRT Knowledge Index',
    '',
    `Generated: ${index.generatedAt}`,
    `Root: ${index.rootDir}`,
    '',
    '## Summary',
    '',
    `- SMRT packages: ${index.smrtPackages.length}`,
    `- SDK packages: ${index.sdkPackages.length}`,
    `- foreignKey fields: ${index.relationshipsV2.foreignKeyFields}`,
    `- crossPackageRef fields: ${index.relationshipsV2.crossPackageRefFields}`,
    `- junction collections: ${index.relationshipsV2.junctionCollections}`,
    `- hierarchical objects: ${index.relationshipsV2.hierarchicalObjects}`,
    `- polymorphic associations: ${index.relationshipsV2.polymorphicAssociations}`,
    `- UUID columns: ${index.relationshipsV2.uuidColumns}`,
    '',
    // Only rendered when something is actually wrong, so healthy output is
    // byte-for-byte unchanged for existing CLI consumers.
    ...renderDiagnosticsSection(index.diagnostics),
    '## Packages',
    '',
  ];

  for (const pkg of index.packages) {
    lines.push(`### ${pkg.name}`);
    lines.push('');
    lines.push(`- kind: ${pkg.kind}`);
    lines.push(`- version: ${pkg.version}`);
    lines.push(`- objects: ${pkg.objects.length}`);
    lines.push(`- SMRT deps: ${pkg.smrtDependencies.join(', ') || '(none)'}`);
    lines.push(`- SDK deps: ${pkg.sdkDependencies.join(', ') || '(none)'}`);
    lines.push(`- exports: ${pkg.exportKeys.join(', ') || '(none)'}`);
    lines.push(`- MCP tools: ${pkg.mcpTools.length}`);
    lines.push(
      `- domain knowledge: ${pkg.domainKnowledgePath ?? '(manifest fallback)'}`,
    );
    lines.push(
      `- docs: ${pkg.docSource ?? '(none)'}${pkg.hasClaudeShim ? ' + CLAUDE.md shim' : ''}`,
    );
    if (pkg.moduleDocs.length > 0) {
      lines.push(
        `- module docs: ${pkg.moduleDocs.map((doc) => doc.path).join(', ')}`,
      );
    }
    if (pkg.relationshipFeatures.length > 0) {
      lines.push(`- relationships-v2: ${pkg.relationshipFeatures.join(', ')}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

export function renderFreshnessResult(
  result: KnowledgeFreshnessResult,
): string {
  const lines = [
    result.ok ? '✓ SMRT knowledge is fresh' : '✗ SMRT knowledge has issues',
    '',
    `Root: ${result.rootDir}`,
    `Errors: ${result.errorCount}`,
    `Warnings: ${result.warningCount}`,
    '',
  ];

  for (const issue of result.issues) {
    const location = issue.file ? ` (${issue.file})` : '';
    lines.push(
      `- [${issue.severity.toUpperCase()}] ${issue.code}: ${issue.message}${location}`,
    );
  }

  return lines.join('\n');
}

/**
 * Nearest ancestor that declares a workspace (#2143).
 *
 * The old rule also required a literal `packages/` directory, which silently
 * mis-rooted every `apps/*`-shaped product. A workspace declaration is the
 * actual signal; `startDir` is the fallback so single-package repos still work.
 */
function findProjectRoot(startDir: string): string {
  let current = resolve(startDir);
  for (;;) {
    if (existsSync(join(current, 'pnpm-workspace.yaml'))) return current;
    if (readPackageJsonWorkspaceGlobs(current).length > 0) return current;
    const parent = dirname(current);
    if (parent === current) return resolve(startDir);
    current = parent;
  }
}

function readPackageJsonWorkspaceGlobs(dir: string): string[] {
  const packageJson = objectRecord(readJson(join(dir, 'package.json')));
  const workspaces = packageJson.workspaces;
  return Array.isArray(workspaces)
    ? stringArray(workspaces)
    : stringArray(objectRecord(workspaces).packages);
}

function readWorkspaceGlobs(rootDir: string): {
  globs: string[];
  source: WorkspaceGlobSource;
} {
  const pnpmWorkspacePath = join(rootDir, 'pnpm-workspace.yaml');
  if (existsSync(pnpmWorkspacePath)) {
    const globs = parseYamlStringList(
      readFileSync(pnpmWorkspacePath, 'utf8'),
      'packages',
    );
    if (globs.length > 0) return { globs, source: 'pnpm-workspace.yaml' };
  }

  const packageJsonGlobs = readPackageJsonWorkspaceGlobs(rootDir);
  if (packageJsonGlobs.length > 0) {
    return { globs: packageJsonGlobs, source: 'package.json#workspaces' };
  }

  return { globs: [...WORKSPACE_GLOB_FALLBACK], source: 'fallback' };
}

/**
 * Reads a top-level `key:` string list out of `pnpm-workspace.yaml`.
 *
 * Deliberately dependency-free: the shape consumed here is a fixed, tiny list
 * of globs, and a read-only dev server should not pull in a YAML parser for it.
 * Handles both block sequences and a single-line flow sequence.
 */
function parseYamlStringList(content: string, key: string): string[] {
  const keyPattern = new RegExp(`^${escapeRegExp(key)}\\s*:\\s*(.*)$`);
  const values: string[] = [];
  let inBlock = false;

  for (const line of content.split(/\r?\n/)) {
    if (!inBlock) {
      const match = line.match(keyPattern);
      if (!match) continue;
      const rest = (match[1] ?? '').trim();
      if (rest.startsWith('[')) {
        return rest
          .replace(/^\[/, '')
          .replace(/\]\s*$/, '')
          .split(',')
          .map((entry) => unquoteYamlScalar(entry))
          .filter(Boolean);
      }
      // A scalar value on the key line is not a list; only an empty remainder
      // (or a trailing comment) opens a block sequence.
      if (rest !== '' && !rest.startsWith('#')) continue;
      inBlock = true;
      continue;
    }

    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const item = line.match(/^\s+-\s*(.+?)\s*$/);
    if (!item) break; // dedented back to the next top-level key
    const value = unquoteYamlScalar(item[1] ?? '');
    if (value) values.push(value);
  }

  return values;
}

function unquoteYamlScalar(value: string): string {
  const trimmed = value.trim();
  const quoted = trimmed.match(/^(['"])([\s\S]*?)\1/);
  if (quoted) return (quoted[2] ?? '').trim();
  return trimmed.replace(/\s+#.*$/, '').trim();
}

/**
 * Expands workspace globs to package directories.
 *
 * Supports the shapes pnpm workspaces actually use in these repos: literals,
 * single-star directory globs (`packages/*`, `apps/*`), recursive `**`, and `!`
 * negations. Expansion walks the tree with `readdir` rather than adding a glob
 * dependency.
 */
function expandWorkspaceGlobs(rootDir: string, globs: string[]): string[] {
  const negations = globs
    .filter((glob) => glob.trim().startsWith('!'))
    .map((glob) => globToRegExp(normalizeGlob(glob.trim().slice(1))));
  const matched = new Set<string>();

  for (const glob of globs.filter((entry) => !entry.trim().startsWith('!'))) {
    for (const dir of expandGlob(rootDir, normalizeGlob(glob))) {
      matched.add(dir);
    }
  }

  return [...matched]
    .filter((dir) => existsSync(join(dir, 'package.json')))
    .filter((dir) => {
      const rel = relative(rootDir, dir).replaceAll('\\', '/');
      return rel !== '' && !negations.some((pattern) => pattern.test(rel));
    })
    .sort();
}

function normalizeGlob(glob: string): string {
  return glob
    .trim()
    .replaceAll('\\', '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '');
}

function expandGlob(rootDir: string, glob: string): string[] {
  const segments = glob.split('/').filter((segment) => segment !== '');
  if (segments.length === 0) return [];

  let current = [rootDir];
  for (const segment of segments) {
    const next: string[] = [];
    for (const dir of current) {
      if (segment === '**') {
        next.push(...descendantDirs(dir, MAX_GLOB_DEPTH));
        continue;
      }
      if (segment.includes('*')) {
        const pattern = globToRegExp(segment);
        next.push(
          ...childDirs(dir).filter((child) => pattern.test(basename(child))),
        );
        continue;
      }
      const literal = join(dir, segment);
      if (isDirectory(literal)) next.push(literal);
    }
    current = [...new Set(next)];
    if (current.length === 0) break;
  }

  return current;
}

function childDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !WALK_SKIP_DIRS.has(entry.name))
      .map((entry) => join(dir, entry.name));
  } catch {
    return [];
  }
}

function descendantDirs(dir: string, depth: number): string[] {
  if (depth <= 0) return [];
  const children = childDirs(dir);
  return children.flatMap((child) => [
    child,
    ...descendantDirs(child, depth - 1),
  ]);
}

function isDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Translates a workspace glob into an anchored regular expression. `*` stays
 * within one path segment; `**` spans any depth (and collapses so `a/**` also
 * matches `a`).
 */
function globToRegExp(glob: string): RegExp {
  // Tokenize before escaping so the escape pass cannot damage the placeholders.
  const ANY_DEPTH = '\u0000';
  const ANY_SEGMENT = '\u0001';
  const tokenized = glob
    .replace(/\*\*/g, ANY_DEPTH)
    .replace(/\*/g, ANY_SEGMENT);
  const escaped = tokenized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const source = escaped
    .replaceAll(`/${ANY_DEPTH}`, '(?:/.*)?')
    .replaceAll(`${ANY_DEPTH}/`, '(?:.*/)?')
    .replaceAll(ANY_DEPTH, '.*')
    .replaceAll(ANY_SEGMENT, '[^/]*');
  return new RegExp(`^${source}$`);
}

function discoverProjectPackageDirs(rootDir: string): {
  globs: string[];
  globSource: WorkspaceGlobSource;
  dirs: string[];
} {
  const { globs, source } = readWorkspaceGlobs(rootDir);
  const workspaceDirs = expandWorkspaceGlobs(rootDir, globs);
  // A single-package repo is its own package, and a workspace root can also own
  // objects. Coverage reporting makes an empty root visible instead of hiding
  // it behind the old "only if it already has an artifact" gate (#2143).
  const dirs = existsSync(join(rootDir, 'package.json'))
    ? [rootDir, ...workspaceDirs.filter((dir) => dir !== rootDir)]
    : workspaceDirs;
  return { globs, globSource: source, dirs };
}

function discoverInstalledSdkPackages(
  rootDir: string,
  packageDirs: string[],
  includeDocs: boolean,
): KnowledgePackage[] {
  const scopeDirs = [
    join(rootDir, 'node_modules', '@happyvertical'),
    ...packageDirs.map((dir) => join(dir, 'node_modules', '@happyvertical')),
  ];

  return scopeDirs
    .filter(
      (scopeDir, index, all) =>
        existsSync(scopeDir) && all.indexOf(scopeDir) === index,
    )
    .flatMap((scopeDir) =>
      readdirSync(scopeDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
        .map((entry) => {
          const entryPath = join(scopeDir, entry.name);
          try {
            return lstatSync(entryPath).isSymbolicLink()
              ? realpathSync(entryPath)
              : entryPath;
          } catch {
            return entryPath;
          }
        }),
    )
    .filter((dir) => {
      const pkg = objectRecord(readJson(join(dir, 'package.json')));
      return (
        typeof pkg.name === 'string' &&
        SDK_PACKAGE_NAMES.has(pkg.name) &&
        !pkg.name.startsWith('@happyvertical/smrt-')
      );
    })
    .map((dir) => readKnowledgePackage(rootDir, dir, includeDocs));
}

function filterKnowledgePackages(
  packages: KnowledgePackage[],
  options: BuildKnowledgeIndexOptions,
): KnowledgePackage[] {
  const packageQuery = options.packageName ?? options.package;
  return packages.filter((pkg) => {
    if (packageQuery && !packageMatches(pkg, packageQuery.toLowerCase())) {
      return false;
    }

    switch (options.scope) {
      case 'local':
        return (
          pkg.kind !== 'sdk' && !pkg.relativeDirectory.includes('node_modules')
        );
      case 'package':
        return pkg.kind !== 'sdk';
      case 'sdk':
        return pkg.kind === 'sdk';
      case 'project':
      case undefined:
        return true;
      default:
        return true;
    }
  });
}

function readKnowledgePackage(
  rootDir: string,
  directory: string,
  includeDocs: boolean,
): KnowledgePackage {
  const packageJson = objectRecord(readJson(join(directory, 'package.json')));
  const dependencies = stringRecord(packageJson.dependencies);
  const devDependencies = stringRecord(packageJson.devDependencies);
  const peerDependencies = stringRecord(packageJson.peerDependencies);
  const allDeps = { ...dependencies, ...devDependencies, ...peerDependencies };
  const name = String(packageJson.name ?? directory);
  const agentsPath = join(directory, 'AGENTS.md');
  const claudePath = join(directory, 'CLAUDE.md');
  const hasAgentsMd = existsSync(agentsPath);
  const hasClaudeMd = existsSync(claudePath);
  const claudeContent = hasClaudeMd ? readFileSync(claudePath, 'utf8') : '';
  const agentsContent = hasAgentsMd ? readFileSync(agentsPath, 'utf8') : '';
  const fallbackClaudeDoc =
    hasClaudeMd && claudeContent.trim() !== '@AGENTS.md' ? claudeContent : '';
  const domainKnowledge = readDomainKnowledge(directory);
  const docSource = hasAgentsMd
    ? 'AGENTS.md'
    : fallbackClaudeDoc
      ? 'CLAUDE.md'
      : null;
  const manifest = readManifest(directory);
  const resolvedObjects = resolvePackageObjects({
    packageName: name,
    directory,
    rootDir,
    domainKnowledge,
    manifest,
  });
  const objects = resolvedObjects.objects;
  const prompts = domainKnowledge
    ? readDomainKnowledgePrompts(domainKnowledge.content, directory, rootDir)
    : readPrompts(directory, rootDir);
  const smrtDependencies = Object.keys(allDeps)
    .filter((dep) => dep.startsWith('@happyvertical/smrt-'))
    .sort();
  const sdkDependencies = Object.keys(allDeps)
    .filter((dep) => SDK_PACKAGE_NAMES.has(dep))
    .sort();

  return {
    name,
    version: String(packageJson.version ?? '0.0.0'),
    kind: packageKind(name),
    directory,
    relativeDirectory: relative(rootDir, directory),
    files: stringArray(packageJson.files),
    exportKeys: exportKeys(packageJson.exports),
    dependencies,
    devDependencies,
    peerDependencies,
    smrtDependencies,
    sdkDependencies,
    hasAgentsMd,
    hasClaudeMd,
    hasClaudeShim: claudeContent.trim() === '@AGENTS.md',
    docSource,
    agentDoc: includeDocs
      ? domainKnowledge?.content.agentDoc ||
        (hasAgentsMd ? agentsContent : fallbackClaudeDoc || undefined)
      : undefined,
    // Prefer the built artifact, but fall back to resolving the links straight
    // from AGENTS.md so a package without a generated smrt-knowledge.json still
    // surfaces its module docs.
    moduleDocs: includeDocs
      ? (domainKnowledge?.content.moduleDocs ??
        readAgentModuleDocs(directory, agentsContent || undefined))
      : [],
    hasDomainKnowledge: Boolean(domainKnowledge),
    domainKnowledgePath: domainKnowledge?.path
      ? relative(rootDir, domainKnowledge.path)
      : undefined,
    domainKnowledge: domainKnowledge?.content,
    manifestPath: manifest?.path ? relative(rootDir, manifest.path) : undefined,
    manifestVersion:
      typeof manifest?.content.version === 'string'
        ? manifest.content.version
        : undefined,
    objects,
    prompts,
    mcpTools: domainKnowledge
      ? domainMcpTools(domainKnowledge.content)
      : mcpTools(objects),
    relationshipFeatures: relationshipFeatures(objects),
    isWorkspaceRoot: resolve(directory) === resolve(rootDir),
    isPrivate: packageJson.private === true,
    objectSource: resolvedObjects.source,
    objectSourceReason: resolvedObjects.reason,
    checkedObjectPaths: resolvedObjects.checkedPaths,
  };
}

/** Artifact paths consulted for a package's objects, in precedence order. */
function objectArtifactCandidates(directory: string): string[] {
  return [
    join(directory, '.smrt', 'smrt-knowledge.json'),
    join(directory, 'dist', 'smrt-knowledge.json'),
    join(directory, 'src', 'manifest', 'smrt-knowledge.json'),
    join(directory, 'src', 'manifest', 'manifest.json'),
    join(directory, '.smrt', 'manifest.json'),
    join(directory, 'dist', 'manifest.json'),
  ];
}

function resolvePackageObjects(options: {
  packageName: string;
  directory: string;
  rootDir: string;
  domainKnowledge: { path: string; content: DomainKnowledgeManifest } | null;
  manifest: { path: string; content: Record<string, unknown> } | null;
}): {
  objects: KnowledgeObject[];
  source: KnowledgeObjectSource;
  reason?: string;
  checkedPaths: string[];
} {
  const checkedPaths = objectArtifactCandidates(options.directory).map((path) =>
    relativeOrAbsolute(options.rootDir, path),
  );

  if (options.domainKnowledge) {
    return {
      objects: readDomainKnowledgeObjects(options.domainKnowledge.content),
      source: 'domain-artifact',
      checkedPaths,
    };
  }

  if (!options.manifest) {
    return { objects: [], source: 'none', reason: 'no-artifact', checkedPaths };
  }

  const { owned, foreignCount } = partitionOwnedObjects(
    options.manifest.content,
    options.packageName,
  );
  const objects = readManifestObjects({ objects: owned });

  if (objects.length === 0) {
    return {
      objects: [],
      source: 'none',
      reason:
        foreignCount > 0
          ? `manifest-objects-owned-by-other-packages (${foreignCount} rejected)`
          : 'manifest-has-no-objects',
      checkedPaths,
    };
  }

  return {
    objects,
    source: 'manifest',
    reason:
      foreignCount > 0
        ? `rejected ${foreignCount} manifest object(s) owned by other packages`
        : undefined,
    checkedPaths,
  };
}

function relativeOrAbsolute(rootDir: string, path: string): string {
  const rel = relative(rootDir, path);
  return rel && !rel.startsWith('..') ? rel : path;
}

/**
 * Resolves objects from source when no artifact could supply them (#2143).
 *
 * `introspect-project` already reports `manifestSource: "scanner"` and works on
 * an unbuilt checkout. Without the same fallback here, an unbuilt package
 * silently contributed nothing and the two tools disagreed about one root —
 * which was the defect underneath every symptom in #2143.
 *
 * Mutates in place because `mcpTools` and `relationshipFeatures` are derived
 * from `objects` and have to be recomputed together.
 */
async function applyScannerFallback(pkg: KnowledgePackage): Promise<void> {
  if (pkg.objectSource !== 'none') return;
  if (!hasScannableSources(pkg.directory)) {
    pkg.objectSourceReason = `${pkg.objectSourceReason ?? 'no-artifact'}; no-typescript-sources`;
    return;
  }

  try {
    const objects = await scanPackageObjects(pkg.directory, pkg.name);
    if (objects.length === 0) {
      pkg.objectSourceReason = 'no-smrt-objects-in-sources';
      return;
    }
    pkg.objects = objects;
    pkg.objectSource = 'scanner';
    pkg.objectSourceReason = undefined;
    pkg.mcpTools = mcpTools(objects);
    pkg.relationshipFeatures = relationshipFeatures(objects);
  } catch (error) {
    pkg.objectSourceReason = `scanner-failed: ${messageFromError(error)}`;
  }
}

/** Cheap bounded probe — stops at the first candidate instead of walking a whole tree. */
function hasScannableSources(directory: string, depth = 4): boolean {
  if (depth < 0) return false;
  let entries: Dirent[];
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return false;
  }

  const subdirectories: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!WALK_SKIP_DIRS.has(entry.name)) {
        subdirectories.push(join(directory, entry.name));
      }
      continue;
    }
    if (
      entry.isFile() &&
      /\.(tsx?|jsx?)$/.test(entry.name) &&
      !entry.name.endsWith('.d.ts') &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.spec.ts')
    ) {
      return true;
    }
  }

  return subdirectories.some((child) => hasScannableSources(child, depth - 1));
}

async function scanPackageObjects(
  directory: string,
  packageName: string,
): Promise<KnowledgeObject[]> {
  const scanner = new OxcScanner({
    cwd: directory,
    include: SCAN_INCLUDE,
    exclude: SCAN_EXCLUDE,
  });
  const { results, resolved } = await scanner.scanAndResolve();
  const decorated = resolved.filter((classDef) => classDef.hasSmartDecorator);
  if (decorated.length === 0) return [];

  const adapter = new ManifestAdapter();
  const manifest = adapter.toManifest(decorated, {
    packageName,
    typeAliases: results.typeAliases,
  }) as unknown as Record<string, unknown>;

  // Deliberately no ManifestGenerator schema enrichment here. Fields and
  // relationships are what this projection needs, and `generateSchemas` writes
  // progress lines to stdout through the SDK logger — which is the MCP server's
  // JSON-RPC channel, so invoking it here would corrupt the protocol stream.
  // Consequence: scanner-provenance packages report no `columnType`, so they
  // contribute 0 to the `uuidColumns` fact. `objectSource` makes that visible.
  return readManifestObjects(manifest);
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readDomainKnowledge(
  directory: string,
): { path: string; content: DomainKnowledgeManifest } | null {
  for (const path of [
    join(directory, '.smrt', 'smrt-knowledge.json'),
    join(directory, 'dist', 'smrt-knowledge.json'),
    join(directory, 'src', 'manifest', 'smrt-knowledge.json'),
  ]) {
    const content = readJson(path);
    if (isDomainKnowledgeManifest(content)) {
      return { path, content };
    }
  }
  return null;
}

function isDomainKnowledgeManifest(
  value: unknown,
): value is DomainKnowledgeManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return record.schemaVersion === 1 && Array.isArray(record.objects);
}

function readManifest(
  directory: string,
): { path: string; content: Record<string, unknown> } | null {
  for (const path of [
    join(directory, 'src', 'manifest', 'manifest.json'),
    join(directory, '.smrt', 'manifest.json'),
    join(directory, 'dist', 'manifest.json'),
  ]) {
    const content = readJson(path);
    if (content) return { path, content: objectRecord(content) };
  }
  return null;
}

/**
 * Rejects objects a manifest does not own (#2143).
 *
 * A runtime `.smrt/manifest.json` is frequently an *aggregate*: it registers
 * every object reachable from the app, including its dependencies'. Counting
 * those as the package's own doubles Relationships-v2 (a stale 759KB
 * `packages/cli/.smrt/manifest.json` reported 200 foreignKey / 413 UUID against
 * a real 89 / 206). Ownership is decided per object, so an aggregate still
 * contributes the objects it genuinely owns.
 */
function partitionOwnedObjects(
  manifest: Record<string, unknown>,
  packageName: string,
): { owned: Record<string, unknown>; foreignCount: number } {
  const objects = objectRecord(manifest.objects);
  const owned: Record<string, unknown> = {};
  let foreignCount = 0;

  for (const [key, raw] of Object.entries(objects)) {
    if (manifestObjectIsOwned(objectRecord(raw), packageName)) {
      owned[key] = raw;
      continue;
    }
    foreignCount += 1;
  }

  return { owned, foreignCount };
}

function manifestObjectIsOwned(
  object: Record<string, unknown>,
  packageName: string,
): boolean {
  const declared =
    typeof object.packageName === 'string' ? object.packageName : undefined;
  if (declared) return declared === packageName;

  const qualifiedName =
    typeof object.qualifiedName === 'string' ? object.qualifiedName : undefined;
  const qualifier = qualifiedName?.includes(':')
    ? qualifiedName.slice(0, qualifiedName.lastIndexOf(':'))
    : undefined;
  if (qualifier) return qualifier === packageName;

  // Neither marker present: a package-local manifest cannot be attributed
  // elsewhere, so ownership is assumed rather than silently dropping objects.
  return true;
}

function readManifestObjects(
  manifest: Record<string, unknown>,
): KnowledgeObject[] {
  const objects = objectRecord(manifest.objects);
  return Object.values(objects).map((raw) => {
    const item = objectRecord(raw);
    const schema = objectRecord(item.schema);
    const fields = objectRecord(item.fields);
    const schemaColumns = objectRecord(schema.columns);
    const decoratorConfig = objectRecord(item.decoratorConfig);
    const knowledgeFields = Object.entries(fields).map(([fieldName, field]) => {
      const fieldInfo = objectRecord(field);
      const columnName = camelToSnake(fieldName);
      const column = objectRecord(schemaColumns[columnName]);
      return {
        name: fieldName,
        type: String(fieldInfo.type ?? 'unknown'),
        required:
          typeof fieldInfo.required === 'boolean'
            ? fieldInfo.required
            : undefined,
        related:
          typeof fieldInfo.related === 'string' ? fieldInfo.related : undefined,
        columnType: typeof column.type === 'string' ? column.type : undefined,
      };
    });

    return {
      className: String(item.className ?? item.name ?? 'Unknown'),
      qualifiedName:
        typeof item.qualifiedName === 'string' ? item.qualifiedName : undefined,
      filePath: typeof item.filePath === 'string' ? item.filePath : undefined,
      extends: typeof item.extends === 'string' ? item.extends : undefined,
      collection:
        typeof item.collection === 'string' ? item.collection : undefined,
      mcpOperations: mcpOperations(decoratorConfig.mcp),
      tableName:
        typeof decoratorConfig.tableName === 'string'
          ? decoratorConfig.tableName
          : typeof schema.tableName === 'string'
            ? schema.tableName
            : undefined,
      idColumnType:
        typeof objectRecord(schemaColumns.id).type === 'string'
          ? (objectRecord(schemaColumns.id).type as string)
          : undefined,
      fields: knowledgeFields,
      relationships: knowledgeFields.filter((field) =>
        RELATIONSHIP_FIELD_TYPES.has(field.type),
      ),
      methods: Object.keys(objectRecord(item.methods)).sort(),
    };
  });
}

function readDomainKnowledgeObjects(
  manifest: DomainKnowledgeManifest,
): KnowledgeObject[] {
  return manifest.objects.map((object) => ({
    className: object.name,
    qualifiedName: object.qualifiedName,
    extends: object.extends,
    collection: object.collection,
    mcpOperations: object.surfaces
      .filter((surface) => surface.kind === 'mcp')
      .map((surface) => surface.operation)
      .sort(),
    tableName: object.tableName,
    idColumnType: object.fields.find((field) => field.name === 'id')
      ?.columnType,
    fields: object.fields.map((field) => ({
      name: field.name,
      type: field.type,
      required: field.required,
      related: field.related,
      columnType: field.columnType,
    })),
    relationships: object.relationships.map((field) => ({
      name: field.name,
      type: field.type,
      required: field.required,
      related: field.related,
      columnType: field.columnType,
    })),
    methods: object.methods,
  }));
}

function readDomainKnowledgePrompts(
  manifest: DomainKnowledgeManifest,
  directory: string,
  rootDir: string,
): KnowledgePrompt[] {
  return manifest.prompts.map((prompt) => ({
    filePath: relative(rootDir, join(directory, prompt.filePath)),
    key: prompt.key,
  }));
}

function readPrompts(directory: string, rootDir: string): KnowledgePrompt[] {
  const srcDir = join(directory, 'src');
  if (!existsSync(srcDir)) return [];
  const prompts: KnowledgePrompt[] = [];
  for (const filePath of walkFiles(srcDir)) {
    if (!filePath.endsWith('.ts')) continue;
    const content = readFileSync(filePath, 'utf8');
    if (!content.includes('definePrompt')) continue;
    const keyMatch = content.match(/definePrompt\s*\(\s*['"`]([^'"`]+)['"`]/);
    prompts.push({
      filePath: relative(rootDir, filePath),
      key: keyMatch?.[1],
    });
  }
  return prompts;
}

function walkFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (WALK_SKIP_DIRS.has(entry.name)) continue;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(fullPath));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

function packageKind(name: string): KnowledgePackageKind {
  if (name.startsWith('@happyvertical/smrt-')) return 'smrt';
  if (SDK_PACKAGE_NAMES.has(name)) return 'sdk';
  return 'workspace';
}

function exportKeys(exportsField: unknown): string[] {
  if (typeof exportsField === 'string') return ['.'];
  if (
    typeof exportsField !== 'object' ||
    exportsField === null ||
    Array.isArray(exportsField)
  ) {
    return [];
  }
  return Object.keys(exportsField).sort();
}

function mcpOperations(config: unknown): string[] {
  if (config === false) return [];
  const defaultOperations = ['list', 'get', 'create', 'update', 'delete'];
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    return defaultOperations;
  }

  const record = config as Record<string, unknown>;
  const include = Array.isArray(record.include)
    ? record.include.filter((item): item is string => typeof item === 'string')
    : defaultOperations;
  const exclude = new Set(
    Array.isArray(record.exclude)
      ? record.exclude.filter(
          (item): item is string => typeof item === 'string',
        )
      : [],
  );

  return include.filter((operation) => !exclude.has(operation));
}

function mcpTools(objects: KnowledgeObject[]): KnowledgeMcpTool[] {
  return objects
    .flatMap((object) => {
      const collection = object.collection ?? object.className.toLowerCase();
      return object.mcpOperations.map((operation) => ({
        name: `${operation}_${collection}`,
        sourceObject: object.qualifiedName ?? object.className,
        operation,
      }));
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function domainMcpTools(manifest: DomainKnowledgeManifest): KnowledgeMcpTool[] {
  return manifest.surfaces
    .filter((surface) => surface.kind === 'mcp')
    .map((surface) => ({
      name: surface.name,
      sourceObject: surface.objectName ?? '',
      operation: surface.operation,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Identity of the table an object maps to, used to avoid counting one table
 * twice (#2143).
 *
 * A consuming app's generated artifact can re-qualify a dependency's objects
 * under the app's own package name (observed: 18 of `apps/work-web`'s 21
 * artifact objects are classes declared in `packages/work`, same tables). Name
 * prefixes cannot detect that, so corpus-level facts are keyed by class plus
 * table instead.
 */
function objectIdentity(object: KnowledgeObject): string {
  return `${object.className}::${object.tableName ?? object.collection ?? ''}`;
}

function dedupeObjectsByIdentity(
  packages: KnowledgePackage[],
): KnowledgeObject[] {
  const seen = new Map<string, KnowledgeObject>();
  for (const pkg of packages) {
    for (const object of pkg.objects) {
      const identity = objectIdentity(object);
      // Keep the first (packages are name-sorted) so the count is stable.
      if (!seen.has(identity)) seen.set(identity, object);
    }
  }
  return [...seen.values()];
}

function summarizeRelationshipsV2(packages: KnowledgePackage[]) {
  // Relationships-v2 describes the project's model, so one table must
  // contribute its fields once even when two packages both report it.
  const objects = dedupeObjectsByIdentity(packages);
  const fields = objects.flatMap((object) => object.fields);
  return {
    foreignKeyFields: fields.filter((field) => field.type === 'foreignKey')
      .length,
    crossPackageRefFields: fields.filter(
      (field) => field.type === 'crossPackageRef',
    ).length,
    junctionCollections: objects.filter(
      (object) => object.extends === 'SmrtJunction',
    ).length,
    hierarchicalObjects: objects.filter(
      (object) => object.extends === 'SmrtHierarchical',
    ).length,
    polymorphicAssociations: objects.filter((object) =>
      object.fields.some(
        (field) => field.name === 'metaType' || field.name === 'metaId',
      ),
    ).length,
    uuidColumns: fields.filter((field) => field.columnType === 'UUID').length,
  };
}

function relationshipFeatures(objects: KnowledgeObject[]): string[] {
  const features = new Set<string>();
  if (
    objects.some((object) =>
      object.fields.some((field) => field.type === 'foreignKey'),
    )
  ) {
    features.add('foreignKey');
  }
  if (
    objects.some((object) =>
      object.fields.some((field) => field.type === 'crossPackageRef'),
    )
  ) {
    features.add('crossPackageRef');
  }
  if (objects.some((object) => object.extends === 'SmrtJunction')) {
    features.add('SmrtJunction');
  }
  if (objects.some((object) => object.extends === 'SmrtHierarchical')) {
    features.add('SmrtHierarchical');
  }
  if (
    objects.some((object) =>
      object.fields.some(
        (field) => field.name === 'metaType' || field.name === 'metaId',
      ),
    )
  ) {
    features.add('SmrtPolymorphicAssociation');
  }
  if (
    objects.some((object) =>
      object.fields.some((field) => field.columnType === 'UUID'),
    )
  ) {
    features.add('uuidColumns');
  }
  return [...features].sort();
}

function findStalePatternIssues(
  rootDir: string,
  changedFiles?: string[],
): KnowledgeIssue[] {
  const candidates =
    changedFiles && changedFiles.length > 0
      ? changedFiles.map((file) => join(rootDir, file))
      : walkFiles(rootDir);
  const issues: KnowledgeIssue[] = [];
  for (const file of candidates.filter((candidate) =>
    shouldScanStalePatternFile(rootDir, candidate),
  )) {
    if (!existsSync(file) || lstatSync(file).isDirectory()) continue;
    const rel = relative(rootDir, file);
    const content = readFileSync(file, 'utf8');
    for (const stale of STALE_PATTERNS) {
      if (!stale.pattern.test(content)) continue;
      issues.push({
        severity: 'warning',
        code: stale.code,
        message: stale.message,
        file: rel,
      });
    }
  }
  return issues;
}

function shouldScanStalePatternFile(
  rootDir: string,
  filePath: string,
): boolean {
  const rel = relative(rootDir, filePath).replaceAll('\\', '/');
  if (!rel || rel.startsWith('..')) return false;
  const parts = rel.split('/');
  if (parts.includes('node_modules') || parts.includes('dist')) return false;
  if (rel === 'AGENTS.md' || rel === 'README.md') return true;
  if (rel.endsWith('/AGENTS.md') || rel.endsWith('/README.md')) return true;
  if (!rel.startsWith('docs/content/') || !rel.endsWith('.md')) return false;
  return !(
    rel.startsWith('docs/content/api/') ||
    rel.startsWith('docs/content/rfcs/') ||
    rel.startsWith('docs/content/architecture/')
  );
}

function buildReviewFindings(
  index: SmrtKnowledgeIndex,
  changedFiles: string[],
  selectedPackages: KnowledgePackage[],
): KnowledgeIssue[] {
  const issues: KnowledgeIssue[] = [];

  for (const pkg of selectedPackages) {
    const changedPackageFiles = changedFiles.filter(
      (file) =>
        file === pkg.relativeDirectory ||
        file.startsWith(`${pkg.relativeDirectory}/`),
    );

    if (!pkg.agentDoc && pkg.kind === 'smrt') {
      issues.push({
        severity: 'warning',
        code: 'missing-package-expertise',
        message: 'Selected SMRT package has no authored AGENTS.md expertise',
        file: pkg.relativeDirectory,
        packageName: pkg.name,
      });
    }

    if (
      changedPackageFiles.some((file) => file.endsWith('.ts')) &&
      pkg.relationshipFeatures.length > 0
    ) {
      issues.push({
        severity: 'warning',
        code: 'relationship-sensitive-review',
        message: `Package uses relationships-v2 features: ${pkg.relationshipFeatures.join(', ')}`,
        file: changedPackageFiles.find((file) => file.endsWith('.ts')),
        packageName: pkg.name,
      });
    }

    if (
      changedPackageFiles.some((file) => file.endsWith('.ts')) &&
      pkg.mcpTools.length > 0
    ) {
      issues.push({
        severity: 'warning',
        code: 'mcp-surface-review',
        message: `Package exposes ${pkg.mcpTools.length} generated MCP tool(s); check public tool compatibility`,
        file: changedPackageFiles.find((file) => file.endsWith('.ts')),
        packageName: pkg.name,
      });
    }

    const manifestFile = changedPackageFiles.find((file) =>
      isPackageManifestFile(pkg, file),
    );
    if (manifestFile) {
      issues.push({
        severity: 'warning',
        code: 'package-manifest-review',
        message:
          'package.json changed; verify exports, files, dependencies, AGENTS.md, and CLAUDE.md shim packaging',
        file: manifestFile,
        packageName: pkg.name,
      });
    }

    const publicEntrypointFile = changedPackageFiles.find((file) =>
      isPublicEntrypointFile(pkg, file),
    );
    if (publicEntrypointFile) {
      issues.push({
        severity: 'warning',
        code: 'public-entrypoint-review',
        message:
          'Public package entrypoint changed; check exports, generated surfaces, and downstream docs',
        file: publicEntrypointFile,
        packageName: pkg.name,
      });
    }

    const agentDocFile = changedPackageFiles.find((file) =>
      isPackageAgentDocFile(pkg, file),
    );
    if (agentDocFile) {
      issues.push({
        severity: 'warning',
        code: 'agent-expertise-review',
        message:
          'AGENTS.md changed; validate authored expertise against generated objects, relationships, exports, and SDK dependencies',
        file: agentDocFile,
        packageName: pkg.name,
      });
    }
  }

  for (const file of changedFiles) {
    if (!file.startsWith('packages/')) continue;
    if (selectPackagesForFiles(index, [file]).length > 0) continue;
    issues.push({
      severity: 'warning',
      code: 'changed-file-without-package-expert',
      message:
        'Changed file is under packages/ but did not map to a SMRT package',
      file,
    });
  }

  return issues;
}

function isPackageManifestFile(pkg: KnowledgePackage, file: string): boolean {
  return file === `${pkg.relativeDirectory}/package.json`;
}

function isPackageAgentDocFile(pkg: KnowledgePackage, file: string): boolean {
  return (
    file === `${pkg.relativeDirectory}/AGENTS.md` ||
    // A linked module doc carries the same authored expertise (#2108).
    pkg.moduleDocs.some(
      (doc) => file === `${pkg.relativeDirectory}/${doc.path}`,
    )
  );
}

function isPublicEntrypointFile(pkg: KnowledgePackage, file: string): boolean {
  const sourcePrefix = `${pkg.relativeDirectory}/src/`;
  if (!file.startsWith(sourcePrefix)) return false;
  const sourcePath = file.slice(sourcePrefix.length);
  return (
    sourcePath === 'index.ts' ||
    sourcePath === 'index.tsx' ||
    sourcePath === 'index.js' ||
    sourcePath.startsWith('api/') ||
    sourcePath.startsWith('cli/') ||
    sourcePath.startsWith('mcp/') ||
    sourcePath.startsWith('tools/')
  );
}

function buildArchitectureRecommendations(
  context: ArchitectureContextResult,
  ideaText: string,
): SmrtArchitectureResult['recommendations'] {
  const smrtPackages = context.selectedPackages.map((pkg) => pkg.name);
  const sdkPackages = context.selectedSdkPackages.map((pkg) => pkg.name);
  const objectModelSketch = buildObjectModelSketch(
    context.selectedPackages,
    context.diagnostics,
  );
  const risks = buildArchitectureRisks(context.selectedPackages, ideaText);
  const questions = buildArchitectureQuestions(
    context.selectedPackages,
    ideaText,
  );

  return {
    smrtPackages,
    sdkPackages,
    objectModelSketch,
    risks,
    questions,
    notes: [
      'Use SMRT packages for domain/runtime models and generated REST, CLI, MCP, and AI-operation surfaces.',
      'Use HappyVertical SDK packages for AI, SQL, files, logging, secrets, and external capability adapters.',
      'Run smrt dev:knowledge-check after applying model-assisted architecture or review updates.',
    ],
  };
}

function buildObjectModelSketch(
  packages: KnowledgePackage[],
  diagnostics: KnowledgeDiagnostic[] = [],
): string[] {
  // Never hand back a generic sketch when discovery failed: that is the exact
  // confident-but-empty answer #2143 was filed about.
  const blocking = diagnostics.find(
    (diagnostic) => diagnostic.code === 'no-smrt-objects-discovered',
  );
  if (blocking) {
    return [
      `No object model could be derived: ${blocking.message}`,
      `Remediation: ${blocking.remedy ?? 'verify workspace discovery.'}`,
    ];
  }

  const lines = packages.flatMap((pkg) => {
    const objects = pkg.objects
      .filter((object) => object.extends !== 'SmrtCollection')
      .slice(0, 6)
      .map((object) => object.className);
    if (objects.length === 0) {
      return [
        `${pkg.name}: use package services or templates; no manifest objects indexed (${pkg.objectSourceReason ?? pkg.objectSource}).`,
      ];
    }
    return [`${pkg.name}: start from ${objects.join(', ')}.`];
  });

  return lines.length > 0
    ? lines
    : [
        'Define the core domain as SmrtObject classes with explicit relationships and generated surfaces.',
      ];
}

function buildArchitectureRisks(
  packages: KnowledgePackage[],
  ideaText: string,
): string[] {
  const risks = new Set<string>();
  const names = new Set(packages.map((pkg) => pkg.name));
  const relationshipFeatures = new Set(
    packages.flatMap((pkg) => pkg.relationshipFeatures),
  );
  const lowerText = ideaText.toLowerCase();

  if (relationshipFeatures.has('crossPackageRef')) {
    risks.add(
      'Cross-package references should stay as plain string ids and validate target package ownership at workflow boundaries.',
    );
  }
  if (relationshipFeatures.has('SmrtJunction')) {
    risks.add(
      'Junction models need explicit conflictColumns so generated upserts stay deterministic.',
    );
  }
  if (relationshipFeatures.has('SmrtHierarchical')) {
    risks.add(
      'Hierarchical models need cycle prevention and tenant-aware child loading paths.',
    );
  }
  if (
    names.has('@happyvertical/smrt-tenancy') ||
    lowerText.includes('tenant')
  ) {
    risks.add(
      'Tenant-scoped models need nullable tenantId semantics and tenant-guarded loadRelated usage.',
    );
  }
  if (names.has('@happyvertical/smrt-assets')) {
    risks.add(
      'Asset ownership should use package-owned join tables; reserve asset_associations for generic/provenance links.',
    );
  }
  if (names.has('@happyvertical/smrt-secrets')) {
    risks.add(
      'Secrets must use envelope encryption and avoid exposing decrypted values through generated tools.',
    );
  }
  if (names.has('@happyvertical/smrt-jobs') || lowerText.includes('schedule')) {
    risks.add(
      'Background work should use jobs/schedules rather than request-time side effects.',
    );
  }

  risks.add(
    'Generated architecture should be rechecked with smrt dev:knowledge-check after docs or expertise edits.',
  );
  return [...risks];
}

function buildArchitectureQuestions(
  packages: KnowledgePackage[],
  ideaText: string,
): string[] {
  const questions = new Set<string>();
  const names = new Set(packages.map((pkg) => pkg.name));
  const lowerText = ideaText.toLowerCase();

  questions.add(
    'Which generated surfaces are required first: REST, CLI, MCP, AI operations, or Svelte UI?',
  );
  if (
    names.has('@happyvertical/smrt-tenancy') ||
    lowerText.includes('tenant')
  ) {
    questions.add(
      'Which objects are global catalogs and which are tenant-scoped records?',
    );
  }
  if (names.has('@happyvertical/smrt-assets')) {
    questions.add('Which package owns each asset relationship join table?');
  }
  if (names.has('@happyvertical/smrt-profiles')) {
    questions.add('Which identities own or administer the primary records?');
  }
  if (names.has('@happyvertical/smrt-content')) {
    questions.add(
      'Which content snapshots need citation-time reference pinning?',
    );
  }
  if (names.has('@happyvertical/smrt-social')) {
    questions.add(
      'Which social providers need OAuth, scheduling, and post-state reconciliation?',
    );
  }

  return [...questions];
}

function selectPackagesForFiles(
  index: SmrtKnowledgeIndex,
  changedFiles: string[],
): KnowledgePackage[] {
  const selected = new Set<KnowledgePackage>();
  for (const file of changedFiles) {
    for (const pkg of domainPackages(index)) {
      if (
        file === pkg.relativeDirectory ||
        file.startsWith(`${pkg.relativeDirectory}/`)
      ) {
        selected.add(pkg);
      }
    }
  }
  return [...selected].sort((a, b) => a.name.localeCompare(b.name));
}

function selectPackages(
  index: SmrtKnowledgeIndex,
  options: {
    changedFiles?: string[];
    text?: string;
    scope?: KnowledgeScope;
    packageName?: string;
  },
): KnowledgePackage[] {
  const selected = new Set<KnowledgePackage>();
  const packageName = options.packageName?.toLowerCase();
  if (packageName) {
    for (const pkg of domainPackages(index)) {
      if (packageMatches(pkg, packageName)) {
        selected.add(pkg);
      }
    }
  }

  for (const pkg of selectPackagesForFiles(index, options.changedFiles ?? [])) {
    if (scopeAllowsPackage(pkg, options.scope)) selected.add(pkg);
  }

  const text = (options.text ?? '').toLowerCase();
  if (text) {
    for (const pkg of domainPackages(index)) {
      if (!scopeAllowsPackage(pkg, options.scope)) continue;
      const packageKey = pkg.name.replace('@happyvertical/smrt-', '');
      if (
        includesToken(text, packageKey) ||
        text.includes(pkg.name.toLowerCase()) ||
        pkg.objects.some((object) =>
          includesToken(text, object.className.toLowerCase()),
        )
      ) {
        selected.add(pkg);
      }
    }
  }

  if (selected.size === 0 && options.scope === 'local') {
    for (const pkg of domainPackages(index).filter((item) =>
      scopeAllowsPackage(item, 'local'),
    )) {
      selected.add(pkg);
    }
  }

  if (selected.size === 0 && options.scope !== 'sdk') {
    for (const name of [
      '@happyvertical/smrt-core',
      '@happyvertical/smrt-config',
      '@happyvertical/smrt-cli',
      '@happyvertical/smrt-scanner',
      '@happyvertical/smrt-dev-mcp',
    ]) {
      const pkg = index.smrtPackages.find((item) => item.name === name);
      if (pkg) selected.add(pkg);
    }

    // A downstream product has none of those framework packages in its
    // workspace, so the list above selected nothing and the tool reported no
    // packages even after discovery found the project's objects (#2143). Fall
    // back to the local packages that actually carry a model, largest first.
    if (selected.size === 0) {
      const contributing = domainPackages(index)
        .filter(
          (pkg) =>
            pkg.objects.length > 0 &&
            scopeAllowsPackage(pkg, options.scope) &&
            !pkg.relativeDirectory.includes('node_modules'),
        )
        .sort((a, b) => b.objects.length - a.objects.length)
        .slice(0, MAX_FALLBACK_PACKAGES);
      for (const pkg of contributing) selected.add(pkg);
    }
  }

  return [...selected].sort((a, b) => a.name.localeCompare(b.name));
}

function selectSdkPackages(
  index: SmrtKnowledgeIndex,
  selectedPackages: KnowledgePackage[],
  texts: Array<string | undefined>,
  options: {
    scope?: KnowledgeScope;
    packageName?: string;
  } = {},
): KnowledgePackage[] {
  const selected = new Set<KnowledgePackage>();
  const sdkNames = new Set(
    selectedPackages.flatMap((pkg) => pkg.sdkDependencies),
  );
  const text = texts.filter(Boolean).join('\n').toLowerCase();
  const packageName = options.packageName?.toLowerCase();

  for (const sdk of index.sdkPackages) {
    const shortName = sdk.name.replace('@happyvertical/', '');
    if (
      options.scope === 'sdk' ||
      sdkNames.has(sdk.name) ||
      (packageName && packageMatches(sdk, packageName)) ||
      text.includes(sdk.name.toLowerCase()) ||
      includesToken(text, shortName)
    ) {
      selected.add(sdk);
    }
  }

  if (selected.size === 0) {
    for (const name of [
      '@happyvertical/ai',
      '@happyvertical/sql',
      '@happyvertical/files',
      '@happyvertical/utils',
    ]) {
      const sdk = index.sdkPackages.find((item) => item.name === name);
      if (sdk) selected.add(sdk);
    }
  }

  return [...selected].sort((a, b) => a.name.localeCompare(b.name));
}

function domainPackages(index: SmrtKnowledgeIndex): KnowledgePackage[] {
  return index.packages.filter((pkg) => pkg.kind !== 'sdk');
}

function scopeAllowsPackage(
  pkg: KnowledgePackage,
  scope: KnowledgeScope | undefined,
): boolean {
  switch (scope) {
    case 'sdk':
      return false;
    case 'local':
      return !pkg.relativeDirectory.includes('node_modules');
    case 'package':
    case 'project':
    case undefined:
      return true;
  }
}

function packageMatches(pkg: KnowledgePackage, query: string): boolean {
  const normalized = query.toLowerCase();
  const shortName = pkg.name
    .replace('@happyvertical/smrt-', '')
    .replace('@happyvertical/', '');
  return (
    pkg.name.toLowerCase() === normalized ||
    pkg.name.toLowerCase().includes(normalized) ||
    shortName.toLowerCase() === normalized ||
    pkg.relativeDirectory.toLowerCase().endsWith(`/${normalized}`)
  );
}

function buildPromptBundle(options: {
  title: string;
  task: string;
  index: SmrtKnowledgeIndex;
  packages: KnowledgePackage[];
  sdkPackages: KnowledgePackage[];
  sourceFiles: string[];
  extraContext?: string;
  detail?: KnowledgeDetail;
  moduleDocHints?: ModuleDocHints;
}): KnowledgePromptBundle {
  const detail = options.detail ?? 'summary';
  const render = (pkg: KnowledgePackage) =>
    renderPackageContext(pkg, options.moduleDocHints, detail);
  const contextMarkdown = [
    `# ${options.title}`,
    '',
    `Baseline root: ${options.index.rootDir}`,
    '',
    // A caller must see a discovery failure before any of the context below,
    // because zeroed metrics otherwise read as a real answer (#2143).
    ...renderDiagnosticsSection(options.index.diagnostics),
    '## Task',
    '',
    options.task,
    '',
    '## Relationships-v2 Summary',
    '',
    JSON.stringify(options.index.relationshipsV2, null, 2),
    '',
    '## Selected SMRT Packages',
    '',
    ...options.packages.map(render),
    '',
    '## Selected SDK Packages',
    '',
    ...options.sdkPackages.map(render),
    '',
    options.extraContext ? `## Extra Context\n\n${options.extraContext}\n` : '',
  ];

  return {
    title: options.title,
    instructions: [
      'Use the supplied SMRT knowledge context as source material. Return concrete findings or architecture guidance with package names and source references. Do not assume model-provider access.',
      detail === 'summary'
        ? 'Authored package docs are listed by path rather than embedded; read the ones you need, or re-request with detail: "full".'
        : '',
    ]
      .filter(Boolean)
      .join(' '),
    contextMarkdown: contextMarkdown.join('\n'),
    selectedPackages: options.packages.map((pkg) => pkg.name),
    selectedSdkPackages: options.sdkPackages.map((pkg) => pkg.name),
    sourceFiles: options.sourceFiles,
  };
}

function renderDiagnosticsSection(
  diagnostics: KnowledgeDiagnostic[],
): string[] {
  if (diagnostics.length === 0) return [];
  const lines = ['## Diagnostics', ''];
  for (const diagnostic of diagnostics) {
    lines.push(
      `- [${diagnostic.severity.toUpperCase()}] ${diagnostic.code}: ${diagnostic.message}`,
    );
    if (diagnostic.checkedPaths && diagnostic.checkedPaths.length > 0) {
      lines.push(`  - checked: ${diagnostic.checkedPaths.join(', ')}`);
    }
    if (diagnostic.remedy) lines.push(`  - remedy: ${diagnostic.remedy}`);
  }
  lines.push('');
  return lines;
}

/**
 * Which of a package's module docs to embed for this request (#2108).
 *
 * The moved prose is unregenerable, so the DEFAULT is to embed everything —
 * dropping a doc must never be the silent outcome. Hints only NARROW: when the
 * changed files or the focus/idea text point at specific modules, the rest are
 * still listed by path so an agent can open them on demand. If hints exist but
 * match nothing, fall open and embed all.
 */
function selectModuleDocs(
  pkg: KnowledgePackage,
  hints: ModuleDocHints | undefined,
): { embedded: KnowledgeModuleDoc[]; scoped: boolean } {
  const all = pkg.moduleDocs;
  if (all.length === 0) return { embedded: [], scoped: false };

  const packageFiles = (hints?.changedFiles ?? []).filter(
    (file) =>
      file === pkg.relativeDirectory ||
      file.startsWith(`${pkg.relativeDirectory}/`),
  );
  const text = hints?.text ?? '';
  if (packageFiles.length === 0 && text.trim() === '') {
    return { embedded: all, scoped: false };
  }

  const matched = all.filter((doc) => {
    // A doc is relevant when its module name appears as a path segment of a
    // changed file (`src/commissions/...` -> `agents/commissions.md`), when the
    // doc itself changed, or when the request text names the module.
    const segment = new RegExp(`(^|[/.])${escapeRegExp(doc.module)}([/.]|$)`);
    return (
      packageFiles.some(
        (file) =>
          segment.test(file.slice(pkg.relativeDirectory.length + 1)) ||
          file === `${pkg.relativeDirectory}/${doc.path}`,
      ) || includesToken(text, doc.module)
    );
  });

  return matched.length > 0
    ? { embedded: matched, scoped: true }
    : { embedded: all, scoped: false };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function renderPackageContext(
  pkg: KnowledgePackage,
  hints?: ModuleDocHints,
  detail: KnowledgeDetail = 'full',
): string {
  const { embedded, scoped } = selectModuleDocs(pkg, hints);
  const lines = [
    `### ${pkg.name}`,
    '',
    `- version: ${pkg.version}`,
    `- kind: ${pkg.kind}`,
    `- directory: ${pkg.relativeDirectory}`,
    `- domain knowledge: ${pkg.domainKnowledgePath ?? '(manifest fallback)'}`,
    `- object source: ${pkg.objectSource}${pkg.objectSourceReason ? ` (${pkg.objectSourceReason})` : ''}`,
    `- docs: ${[pkg.docSource ?? '(none)', ...pkg.moduleDocs.map((doc) => doc.path)].join(', ')}`,
    `- relationship features: ${pkg.relationshipFeatures.join(', ') || '(none)'}`,
    `- SDK deps: ${pkg.sdkDependencies.join(', ') || '(none)'}`,
    `- exports: ${pkg.exportKeys.join(', ') || '(none)'}`,
    `- MCP tools: ${
      pkg.mcpTools
        .slice(0, 20)
        .map((tool) => tool.name)
        .join(', ') || '(none)'
    }`,
    `- objects: ${pkg.objects
      .slice(0, 20)
      .map((object) => object.qualifiedName ?? object.className)
      .join(', ')}`,
  ];
  if (pkg.objects.length > 20) {
    lines.push(`- object count: ${pkg.objects.length}`);
  }

  // Summary mode lists authored prose by path instead of embedding it, which is
  // what keeps a large project's bundle inside tool-result budgets (#2143).
  if (detail === 'summary') {
    const docPaths = [
      ...(pkg.docSource ? [`${pkg.relativeDirectory}/${pkg.docSource}`] : []),
      ...pkg.moduleDocs.map((doc) => `${pkg.relativeDirectory}/${doc.path}`),
    ];
    if (docPaths.length > 0) {
      lines.push(
        '',
        `> Authored docs not embedded (read on demand, or re-request with detail: "full"): ${docPaths.join(', ')}`,
      );
    }
    lines.push('');
    return lines.join('\n');
  }

  if (pkg.agentDoc) {
    lines.push('', pkg.agentDoc.trim());
  }
  for (const doc of embedded) {
    lines.push('', `#### ${pkg.relativeDirectory}/${doc.path}`, '');
    lines.push(doc.content.trim());
  }
  if (scoped) {
    const omitted = pkg.moduleDocs.filter((doc) => !embedded.includes(doc));
    if (omitted.length > 0) {
      lines.push(
        '',
        `> Module docs not loaded for this request (read on demand): ${omitted
          .map((doc) => `${pkg.relativeDirectory}/${doc.path}`)
          .join(', ')}`,
      );
    }
  }
  lines.push('');
  return lines.join('\n');
}

function getChangedFiles(rootDir: string, base?: string): string[] {
  if (base) {
    try {
      const output = execFileSync(
        'git',
        ['diff', '--name-only', `${base}...HEAD`],
        {
          cwd: rootDir,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        },
      );
      const files = output
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
      if (files.length > 0) return files;
    } catch {
      // Fall back to working-tree changes below.
    }
  }

  try {
    const output = execFileSync('git', ['diff', '--name-only'], {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const cachedOutput = execFileSync(
      'git',
      ['diff', '--cached', '--name-only'],
      {
        cwd: rootDir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
    return uniqueStrings(
      [output, cachedOutput].flatMap((value) =>
        value
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean),
      ),
    );
  } catch {
    return [];
  }
}

function dedupePackages(packages: KnowledgePackage[]): KnowledgePackage[] {
  const byName = new Map<string, KnowledgePackage>();
  for (const pkg of packages) {
    const current = byName.get(pkg.name);
    if (!current || current.kind === 'sdk') {
      byName.set(pkg.name, pkg);
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function includesToken(text: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'i').test(text);
}

function readJson(path: string): unknown {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function hashFile(path: string): string {
  return createHash('sha256').update(readFileSync(path, 'utf8')).digest('hex');
}

function hashJsonFile(path: string): string {
  const content = readJson(path);
  const hashContent = content
    ? stableJson(normalizeJsonForHash(content))
    : readFileSync(path, 'utf8');
  return createHash('sha256').update(hashContent).digest('hex');
}

function objectRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringRecord(value: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(objectRecord(value))) {
    if (typeof entry === 'string') result[key] = entry;
  }
  return result;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function camelToSnake(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[-\s]+/g, '_')
    .toLowerCase();
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function normalizeJsonForHash(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }

  const normalized = { ...(value as Record<string, unknown>) };
  delete normalized.timestamp;
  return normalized;
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value), null, 2);
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, sortJson(entry)]),
    );
  }
  return value;
}
