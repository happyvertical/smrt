import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import {
  existsSync,
  lstatSync,
  opendirSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import {
  AGENT_SURFACE_HASH_PREFIX,
  MODULE_DOC_HASH_PREFIX,
  readAgentModuleDocs,
} from '@happyvertical/smrt-core/knowledge';
import { toSnakeCase } from '@happyvertical/smrt-core/utils';
import {
  type AgentSurface,
  isAgentSurfaceSourcePath,
  lintNumericPrecision,
  ManifestAdapter,
  mergeAgentSurfaces,
  OxcScanner,
  parseSource,
  scanSvelteAgentSurface,
  sourceMayContainNumericPrecisionIssue,
  sourceMayDeclareAgentSurface,
} from '@happyvertical/smrt-scanner';
import type {
  DomainKnowledgeAgentSurface,
  DomainKnowledgeField,
  DomainKnowledgeFieldConstraints,
  DomainKnowledgeManifest,
  DomainKnowledgeMethodSignature,
  DomainKnowledgeModuleDoc,
  DomainKnowledgeObject,
  DomainKnowledgeTenant,
} from '@happyvertical/smrt-types';
import { TOOLS } from '../tool-catalog.js';
import { checkMcpToolDocumentation } from './mcp-docs.js';

export type KnowledgePackageKind = 'smrt' | 'sdk' | 'workspace';
export type KnowledgeIssueSeverity = 'error' | 'warning';
/**
 * `installed` is the consumer-app scope (#2275): installed
 * `@happyvertical/smrt-*` packages and packages in the known HappyVertical SDK
 * allowlist, rather than packages the project authors. The other scopes all
 * describe the workspace's own sources.
 */
export type KnowledgeScope =
  | 'project'
  | 'local'
  | 'package'
  | 'sdk'
  | 'installed';

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

export type KnowledgeField = DomainKnowledgeField;

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
  methodSignatures?: DomainKnowledgeMethodSignature[];
  tenant?: DomainKnowledgeTenant;
  tableStrategy?: 'cti' | 'sti';
  conflictColumns?: string[];
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
   * SHA-256 of the shipped `AGENTS.md`, when there is one.
   *
   * A version bump is a poor drift signal because most releases do not touch a
   * package's documented surface. This hash is the stable identity a consumer
   * diffs against its own recorded baseline to answer "which installed packages
   * changed their documented surface since I last verified my copy?" (#2275).
   */
  agentDocSha256?: string;
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
  /**
   * The package's declared view intents and playbooks (#2591), lifted out of
   * the domain-knowledge artifact so a consumer of the index never has to reach
   * into the whole artifact for them. Absent when the package declares none.
   */
  agentSurface?: DomainKnowledgeAgentSurface;
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
  /**
   * True when the package was resolved out of `node_modules` rather than
   * authored in this workspace. This repository's docs and packaging rules do
   * not apply to it — a consumer cannot add an `AGENTS.md` to a dependency —
   * so the freshness gate skips it entirely: indexed, never checked (#2275).
   */
  isInstalledDependency: boolean;
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
  /**
   * 2 adds `coverage` and `diagnostics` (additive, #2143); 3 adds
   * `installedPackages` plus each package's `isInstalledDependency` and
   * `agentDocSha256` (additive, #2275).
   */
  schemaVersion: 3;
  generatedAt: string;
  rootDir: string;
  packages: KnowledgePackage[];
  smrtPackages: KnowledgePackage[];
  sdkPackages: KnowledgePackage[];
  /**
   * Installed `@happyvertical/*` dependencies, SMRT and SDK alike. In a
   * consumer app this is the whole audit surface. In this monorepo it holds the
   * registry-installed SDK packages; the `smrt-*` names resolve to workspace
   * copies, which win the name-keyed dedupe (#2275).
   */
  installedPackages: KnowledgePackage[];
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

export interface PackageSpecialistContextResult {
  selectedPackage: KnowledgePackage;
  selectedSdkPackages: KnowledgePackage[];
  promptBundle: KnowledgePromptBundle;
  sourceFiles: string[];
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

/**
 * Bounds total directory-entry work across every workspace glob. This is a
 * cardinality budget rather than a depth cap: valid deeply nested workspaces
 * remain discoverable, while broad or repeated globstars fail loudly before
 * they can amplify into unbounded filesystem work.
 */
const MAX_WORKSPACE_GLOB_TRAVERSAL_ENTRIES = 10_000;

/** Prevents a broad but sub-budget glob from fanning out package reads. */
const MAX_DISCOVERED_WORKSPACE_PACKAGES = 512;

/** Bounds simultaneous OxcScanner instances and their filesystem handles. */
const MAX_SCANNER_CONCURRENCY = 8;

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
    dirs: discoveredPackageDirs,
    diagnostics: discoveryDiagnostics,
  } = discoverProjectPackageDirs(rootDir);
  const resolvedRoot = realpathSync(rootDir);
  const packageDirs: string[] = [];
  const packages: KnowledgePackage[] = [];
  for (const dir of discoveredPackageDirs) {
    if (confinedRealPath(resolvedRoot, dir) === undefined) {
      discoveryDiagnostics.push({
        severity: 'error',
        code: 'workspace-package-root-escape',
        message:
          'Rejected a workspace package whose real path changed or escaped the workspace root before it could be read.',
        remedy:
          'Keep workspace package paths stable and inside the workspace root throughout knowledge discovery.',
      });
      continue;
    }
    packageDirs.push(dir);
    packages.push(readKnowledgePackage(rootDir, dir, includeDocs));
  }

  // A workspace root can own objects of its own, but scanning it naively would
  // also sweep every member package and claim their objects as the root's. Scan
  // it with the member directories excluded instead of skipping it (#2143).
  const memberExcludes = packageDirs
    .filter((dir) => resolve(dir) !== resolve(rootDir))
    .map((dir) => `${relative(rootDir, dir).replaceAll('\\', '/')}/**`);
  await applyScannerFallbacks(packages, memberExcludes);

  packages.push(
    ...discoverInstalledPackages(rootDir, packageDirs, includeDocs),
  );

  const uniquePackages = dedupePackages(packages);
  const scopedPackages = filterKnowledgePackages(uniquePackages, options);
  const smrtPackages = scopedPackages.filter((pkg) => pkg.kind === 'smrt');
  const sdkPackages = scopedPackages.filter((pkg) => pkg.kind === 'sdk');
  // Coverage and diagnostics answer "did discovery work", which is a property of
  // the whole workspace. Computing them from the scoped subset made
  // `scope: 'sdk'` (or a `--package` filter) report a false discovery failure on
  // a repository whose model was found perfectly well.
  const coverage = buildCoverage({
    rootDir,
    globs,
    globSource,
    packageDirs,
    packages: uniquePackages,
  });

  return {
    schemaVersion: 3,
    generatedAt: new Date().toISOString(),
    rootDir,
    packages: scopedPackages,
    smrtPackages,
    sdkPackages,
    installedPackages: scopedPackages.filter(
      (pkg) => pkg.isInstalledDependency,
    ),
    relationshipsV2: summarizeRelationshipsV2(scopedPackages),
    coverage,
    diagnostics: buildIndexDiagnostics(
      rootDir,
      uniquePackages,
      coverage,
      discoveryDiagnostics,
    ),
  };
}

function buildCoverage(options: {
  rootDir: string;
  globs: string[];
  globSource: WorkspaceGlobSource;
  packageDirs: string[];
  packages: KnowledgePackage[];
}): KnowledgeCoverage {
  // Coverage answers "did discovery see THIS PROJECT", so it reports on the
  // packages the project authors. An installed dependency's objects are not
  // project coverage, and listing every dependency that ships no model as a
  // gap made the answer unreadable in a consumer app (#2275).
  const authored = options.packages.filter((pkg) => !pkg.isInstalledDependency);
  return {
    workspaceGlobs: options.globs,
    workspaceGlobSource: options.globSource,
    packageDirs: options.packageDirs.map(
      (dir) => relative(options.rootDir, dir) || '.',
    ),
    packagesWithObjects: authored
      .filter((pkg) => pkg.objects.length > 0)
      .map((pkg) => `${pkg.name} (${pkg.objects.length}, ${pkg.objectSource})`),
    packagesWithoutObjects: authored
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
  discoveryDiagnostics: KnowledgeDiagnostic[] = [],
): KnowledgeDiagnostic[] {
  const diagnostics: KnowledgeDiagnostic[] = [...discoveryDiagnostics];
  // Counted over authored packages only. Installed `@happyvertical/smrt-*`
  // dependencies ship their own `smrt-knowledge.json`, so counting them would
  // make this guard unreachable in any project that depends on the framework —
  // exactly the projects whose own discovery is most likely to be broken
  // (#2143, #2275).
  const authoredPackages = packages.filter((pkg) => !pkg.isInstalledDependency);
  const authoredObjects = authoredPackages.reduce(
    (total, pkg) => total + pkg.objects.length,
    0,
  );
  const installedObjects = packages.reduce(
    (total, pkg) =>
      total + (pkg.isInstalledDependency ? pkg.objects.length : 0),
    0,
  );

  if (authoredObjects === 0 && installedObjects > 0) {
    diagnostics.push({
      severity: 'warning',
      code: 'no-authored-smrt-objects',
      message: [
        `No SMRT objects were discovered in the project's own packages under ${rootDir},`,
        `though ${installedObjects} were read from installed dependencies.`,
        'Expected for an application that only consumes the framework;',
        'a discovery failure if this workspace is supposed to declare @smrt() classes.',
      ].join(' '),
      remedy: [
        'If this workspace authors SMRT objects, confirm rootDir is the workspace root,',
        'confirm the workspace globs cover the directories that hold @smrt() classes,',
        'and run `pnpm build` in the owning package to emit .smrt/manifest.json.',
      ].join(' '),
    });
  }

  if (authoredObjects === 0 && installedObjects === 0) {
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
        ...new Set(authoredPackages.flatMap((pkg) => pkg.checkedObjectPaths)),
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
  const duplicates: Array<[string, string[]]> = [];
  for (const [identity, entries] of groupObjectsByIdentity(packages)) {
    // Report only the collisions the corpus actually collapses.
    if (collapseIdentityGroup(entries).length >= entries.length) continue;
    duplicates.push([
      identity,
      [...new Set(entries.map((entry) => entry.pkg.name))],
    ]);
  }
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
  //
  // A monorepo root is glue rather than a publishable package, so it is exempt —
  // it only became visible to this loop when discovery stopped gating root
  // inclusion (#2143). But in a single-package repository the root IS the
  // published package, so exempting every root would turn this gate into a
  // no-op for exactly the layout #2143 added support for.
  //
  // Installed dependencies are excluded throughout: a consumer app cannot add
  // an AGENTS.md to a package it merely installs, so gating on one would make
  // `dev:knowledge-check` unpassable everywhere downstream (#2275). They are
  // still indexed and reported — only the authored-source rules skip them.
  const authoredPackages = index.packages.filter(
    (item) => !item.isInstalledDependency,
  );
  const hasMemberPackages = authoredPackages.some(
    (item) => item.kind !== 'sdk' && !item.isWorkspaceRoot,
  );
  const memberDirectories = authoredPackages
    .filter(
      (item) =>
        item.kind !== 'sdk' && !item.isWorkspaceRoot && item.relativeDirectory,
    )
    .map((item) => item.relativeDirectory);
  // Instruction chains are ADDITIVE, so the kernel forbids nesting AGENTS.md:
  // an agent editing `packages/x/host/**` would load the parent's file and this
  // one. A workspace package nested inside another workspace package therefore
  // cannot own canonical docs at all — its expertise belongs in the parent's
  // linked module doc (`packages/x/agents/host.md`). Demanding an AGENTS.md
  // here would require exactly the file the kernel prohibits.
  const isNestedMember = (pkg: KnowledgePackage): boolean =>
    Boolean(pkg.relativeDirectory) &&
    memberDirectories.some(
      (directory) =>
        directory !== pkg.relativeDirectory &&
        pkg.relativeDirectory.startsWith(`${directory}/`),
    );
  for (const pkg of authoredPackages.filter(
    (item) =>
      item.kind !== 'sdk' && !(item.isWorkspaceRoot && hasMemberPackages),
  )) {
    const packageJsonPath = join(pkg.directory, 'package.json');
    const nested = isNestedMember(pkg);

    if (!pkg.hasAgentsMd && !nested) {
      issues.push({
        severity: 'error',
        code: 'missing-agents-md',
        message: 'Workspace package is missing canonical AGENTS.md',
        file: relative(index.rootDir, join(pkg.directory, 'AGENTS.md')),
        packageName: pkg.name,
      });
    }

    if (nested && pkg.hasAgentsMd) {
      issues.push({
        severity: 'error',
        code: 'nested-agents-md',
        message:
          'Nested workspace package must not define AGENTS.md; move it to the parent package as a linked agents/<module>.md',
        file: relative(index.rootDir, join(pkg.directory, 'AGENTS.md')),
        packageName: pkg.name,
      });
    }

    if (!pkg.hasClaudeMd && !nested) {
      issues.push({
        severity: 'error',
        code: 'missing-claude-shim',
        message: 'Workspace package is missing CLAUDE.md compatibility shim',
        file: relative(index.rootDir, join(pkg.directory, 'CLAUDE.md')),
        packageName: pkg.name,
      });
    } else if (pkg.hasClaudeMd && !pkg.hasClaudeShim) {
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

  for (const pkg of authoredPackages) {
    issues.push(...checkDomainKnowledgeArtifact(index.rootDir, pkg));
    issues.push(...checkAgentSurface(pkg));
  }

  const devMcpPackage = authoredPackages.find(
    (pkg) => pkg.name === '@happyvertical/smrt-dev-mcp',
  );
  if (devMcpPackage) {
    issues.push(
      ...checkMcpToolDocumentation(
        index.rootDir,
        devMcpPackage.directory,
        TOOLS,
      ),
    );
  }

  issues.push(...findAgentSurfaceDriftIssues(authoredPackages));
  issues.push(...findStalePatternIssues(index.rootDir, changedFiles));
  issues.push(
    ...findNumericPrecisionIssues(index, authoredPackages, changedFiles),
  );

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
    // A module declaring a view intent or a playbook is an authored source for
    // exactly the same reason (#2591): editing one changes the emitted agent
    // surface, and an artifact that still claims the old surface is stale.
    ...Object.keys(hashes)
      .filter((key) => key.startsWith(AGENT_SURFACE_HASH_PREFIX))
      .sort()
      .map((key) => {
        const sourcePath = key.slice(AGENT_SURFACE_HASH_PREFIX.length);
        const filePath = join(pkg.directory, sourcePath);
        return {
          key,
          filePath: existsSync(filePath) ? filePath : undefined,
          kind: 'raw' as const,
          label: sourcePath,
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

/**
 * Validate the emitted agent surface (#2591).
 *
 * Two rules, and the second is the reason this exists at all:
 *
 * - an identity must be present and unique within the package. `id`/`key` is
 *   what a playbook step, a parity snapshot, and `smrt doctor` all name, so a
 *   blank or colliding one makes the surface unaddressable;
 * - every declaration the matcher recognized but could not read is reported.
 *   It is a warning, not an error, because a computed tool set is a legitimate
 *   choice with a supported path — but it is never silence, because the whole
 *   value of emitting the surface is that "what can an agent do here" has one
 *   answer, and an invisible declaration makes that answer wrong.
 */
function checkAgentSurface(pkg: KnowledgePackage): KnowledgeIssue[] {
  const surface = pkg.domainKnowledge?.agentSurface;
  if (!surface) return [];

  const issues: KnowledgeIssue[] = [];
  const file = pkg.domainKnowledgePath;

  const seen = new Set<string>();
  const checkIdentity = (
    label: string,
    identity: string | undefined,
    sourceFile: string,
  ): void => {
    if (!identity) {
      issues.push({
        severity: 'error',
        code: 'agent-surface-missing-identity',
        message: `${label} declared in ${sourceFile} has no identity`,
        file,
        packageName: pkg.name,
      });
      return;
    }
    const scoped = `${label}:${identity}`;
    if (seen.has(scoped)) {
      issues.push({
        severity: 'error',
        code: 'agent-surface-duplicate-identity',
        message: `${label} \`${identity}\` is emitted more than once`,
        file,
        packageName: pkg.name,
      });
      return;
    }
    seen.add(scoped);
  };

  for (const intent of surface.intents) {
    checkIdentity('view intent', intent.id, intent.sourceFile);
  }
  for (const playbook of surface.playbooks) {
    checkIdentity('playbook', playbook.key, playbook.sourceFile);
    if (playbook.steps.length === 0) {
      issues.push({
        severity: 'error',
        code: 'agent-surface-empty-playbook',
        message: `playbook \`${playbook.key}\` declares no steps`,
        file,
        packageName: pkg.name,
      });
    }
  }

  for (const diagnostic of surface.diagnostics) {
    const where = diagnostic.line
      ? `${diagnostic.sourceFile}:${diagnostic.line}`
      : diagnostic.sourceFile;
    // A cross-file duplicate never reaches the identity loop above: the
    // scanner's merge already dropped the loser and left only this diagnostic.
    // Reporting it as a "not static" warning would make the duplicate error
    // unreachable in practice, so the diagnostic itself carries the severity.
    const duplicate = diagnostic.code === 'duplicate-identity';
    issues.push({
      severity: duplicate ? 'error' : 'warning',
      code: duplicate
        ? 'agent-surface-duplicate-identity'
        : 'agent-surface-not-static',
      message: `${where} — ${diagnostic.message}`,
      file,
      packageName: pkg.name,
    });
  }

  return issues;
}

/** Turn a comparison key back into something a human can act on. */
function describeAgentSurfaceIdentity(identity: string): string {
  if (!identity.startsWith('diagnostic:')) return identity;
  const [, code, ...rest] = identity.split(':');
  const line = rest.pop();
  const path = rest.join(':');
  const where = line && line !== '0' ? `${path}:${line}` : path;
  return `${code} diagnostic at ${where}`;
}

/**
 * Compare the artifact's emitted surface against what the sources declare NOW
 * (#2591).
 *
 * `sourceHashes` alone cannot see an ADDED declaration: a brand-new
 * `Foo.intents.ts` has no recorded hash to mismatch, the runtime manifest does
 * not change (intents never enter it), and `AGENTS.md` does not change either —
 * so every existing freshness signal stays green while the artifact silently
 * omits a real operation. That defeats the point of emitting the surface, so
 * the declaration SET is re-derived from source and compared by identity.
 *
 * The scan is bounded the same way the numeric-precision lint is: `src` only,
 * with the scanner's cheap token pre-filter in front of every parse. Which
 * files count is decided by the scanner's own `isAgentSurfaceSourcePath`, never
 * by a list copied into this package: the two sides disagreeing produces a
 * drift error no rebuild can clear, in whichever direction they differ.
 */
function findAgentSurfaceDriftIssues(
  authoredPackages: KnowledgePackage[],
): KnowledgeIssue[] {
  const issues: KnowledgeIssue[] = [];

  for (const pkg of authoredPackages) {
    if (pkg.kind === 'sdk' || pkg.isInstalledDependency) continue;
    if (!pkg.domainKnowledge || !pkg.domainKnowledgePath) continue;
    const srcDir = join(pkg.directory, 'src');
    if (!existsSync(srcDir)) continue;

    const perFile: AgentSurface[] = [];
    for (const filePath of walkFiles(srcDir)) {
      // A `.svelte` file contributes diagnostics only — never an entry — but
      // those diagnostics ARE part of the emitted surface, so omitting them
      // here would report every one of them as no longer declared.
      if (filePath.endsWith('.svelte')) {
        const diagnostics = scanSvelteAgentSurface(filePath);
        if (diagnostics.length > 0) {
          perFile.push({ intents: [], playbooks: [], diagnostics });
        }
        continue;
      }
      // Match what the EMITTER sees, not merely what is on disk. A declaration
      // in a file the build excludes is never emitted, so counting it here
      // would raise a drift error no rebuild could ever clear.
      if (!isAgentSurfaceSourcePath(filePath)) continue;
      let sourceText: string;
      try {
        sourceText = readFileSync(filePath, 'utf8');
      } catch {
        continue;
      }
      if (!sourceMayDeclareAgentSurface(sourceText)) continue;
      const surface = parseSource(sourceText, filePath).agentSurface;
      if (surface) perFile.push(surface);
    }

    // Merge before comparing: the merge is where a duplicate identity and a
    // derived tool-name collision are resolved, and the emitted artifact is the
    // merged result. Comparing raw per-file declarations against it would
    // report the dropped loser as missing, which a rebuild cannot fix.
    // Relativize the same way the emitter does, so paths in the two sets are
    // directly comparable.
    const merged = mergeAgentSurfaces(perFile, (filePath) =>
      relative(pkg.directory, filePath).split(sep).join('/'),
    );
    const declared = new Set<string>();
    for (const intent of merged.intents) {
      declared.add(`view intent:${intent.id}`);
    }
    for (const playbook of merged.playbooks) {
      declared.add(`playbook:${playbook.key}`);
    }
    // Diagnostics are part of the emitted surface, and a sidecar containing
    // ONLY a non-static declaration changes nothing else: no identity, and no
    // prior hash to mismatch. Without this, "a diagnostic, never silence"
    // would quietly become "a diagnostic, until the artifact goes stale".
    for (const diagnostic of merged.diagnostics) {
      declared.add(
        `diagnostic:${diagnostic.code}:${diagnostic.filePath}:${diagnostic.line ?? 0}`,
      );
    }

    const emitted = new Set<string>();
    for (const intent of pkg.agentSurface?.intents ?? []) {
      emitted.add(`view intent:${intent.id}`);
    }
    for (const playbook of pkg.agentSurface?.playbooks ?? []) {
      emitted.add(`playbook:${playbook.key}`);
    }
    for (const diagnostic of pkg.agentSurface?.diagnostics ?? []) {
      emitted.add(
        `diagnostic:${diagnostic.code}:${diagnostic.sourceFile}:${diagnostic.line ?? 0}`,
      );
    }

    for (const identity of [...declared].sort()) {
      if (emitted.has(identity)) continue;
      issues.push({
        severity: 'error',
        code: 'stale-agent-surface',
        message: `${describeAgentSurfaceIdentity(identity)} is present in source but missing from smrt-knowledge.json — rebuild the package`,
        file: pkg.domainKnowledgePath,
        packageName: pkg.name,
      });
    }
    for (const identity of [...emitted].sort()) {
      if (declared.has(identity)) continue;
      issues.push({
        severity: 'error',
        code: 'stale-agent-surface',
        message: `${describeAgentSurfaceIdentity(identity)} is in smrt-knowledge.json but no longer present in source — rebuild the package`,
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

export async function buildPackageSpecialistContext(
  options: ContextSelectorOptions = {},
): Promise<PackageSpecialistContextResult> {
  const packageQuery = options.packageName ?? options.package;
  if (!packageQuery) {
    throw new Error('Package specialist context requires a package name');
  }

  const index = await buildKnowledgeIndex({
    rootDir: options.rootDir,
    includeDocs: true,
  });
  const selectedPackage = index.packages.find(
    (pkg) =>
      pkg.kind !== 'sdk' && packageMatches(pkg, packageQuery.toLowerCase()),
  );

  if (!selectedPackage) {
    throw new Error(`Unknown SMRT package: ${packageQuery}`);
  }

  const selectedSdkPackages = selectSdkPackages(
    index,
    [selectedPackage],
    [selectedPackage.name, ...selectedPackage.sdkDependencies],
    {
      scope: 'project',
      packageName: selectedPackage.name,
    },
  );
  const sourceFiles = packageSpecialistSourceFiles(
    index.rootDir,
    selectedPackage,
  );

  return {
    selectedPackage,
    selectedSdkPackages,
    sourceFiles,
    promptBundle: buildPromptBundle({
      title: `SMRT package specialist: ${selectedPackage.name}`,
      task: 'Act as a deterministic specialist for this package. Use only the supplied package docs, manifest/knowledge artifacts, routes, tests, prompts, and dependency context. Explain package concepts, integration surfaces, validation commands, and likely implementation risks with source references. Do not assume provider-backed chat or external model access.',
      index,
      packages: [selectedPackage],
      sdkPackages: selectedSdkPackages,
      sourceFiles,
      extraContext: options.focus,
    }),
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
    `- Installed dependencies: ${index.installedPackages.length}`,
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
    if (pkg.isInstalledDependency) {
      lines.push('- source: installed dependency');
      lines.push(`- AGENTS.md sha256: ${pkg.agentDocSha256 ?? '(none)'}`);
    }
    if (pkg.moduleDocs.length > 0) {
      lines.push(
        `- module docs: ${pkg.moduleDocs.map((doc) => doc.path).join(', ')}`,
      );
    }
    if (pkg.relationshipFeatures.length > 0) {
      lines.push(`- relationships-v2: ${pkg.relationshipFeatures.join(', ')}`);
    }
    // Only rendered for a package that declares one, so output for every
    // existing package stays byte-for-byte unchanged (#2591).
    if (pkg.agentSurface) {
      lines.push(
        `- view intents: ${
          pkg.agentSurface.intents.map((intent) => intent.id).join(', ') ||
          '(none)'
        }`,
      );
      lines.push(
        `- playbooks: ${
          pkg.agentSurface.playbooks
            .map((playbook) => playbook.key)
            .join(', ') || '(none)'
        }`,
      );
      if (pkg.agentSurface.diagnostics.length > 0) {
        lines.push(
          `- non-static declarations: ${pkg.agentSurface.diagnostics.length}`,
        );
      }
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
interface WorkspaceGlobExpansion {
  dirs: string[];
  diagnostics: KnowledgeDiagnostic[];
  fatal: boolean;
}

interface WorkspaceGlobTraversalBudget {
  entries: number;
}

class WorkspaceGlobTraversalLimitError extends Error {
  constructor(readonly glob: string) {
    super(
      `Workspace glob traversal exceeded ${MAX_WORKSPACE_GLOB_TRAVERSAL_ENTRIES} directory entries while expanding ${glob}`,
    );
    this.name = 'WorkspaceGlobTraversalLimitError';
  }
}

function expandWorkspaceGlobs(
  rootDir: string,
  globs: string[],
): WorkspaceGlobExpansion {
  const diagnostics: KnowledgeDiagnostic[] = [];
  const positiveGlobs: string[] = [];
  const negations: RegExp[] = [];

  for (const rawGlob of globs) {
    const negated = rawGlob.trim().startsWith('!');
    const glob = normalizeGlob(
      negated ? rawGlob.trim().slice(1) : rawGlob.trim(),
    );
    const unsafeReason = unsafeWorkspaceGlobReason(glob);
    if (unsafeReason) {
      diagnostics.push({
        severity: 'error',
        code: 'unsafe-workspace-glob',
        message: `Rejected workspace glob ${JSON.stringify(rawGlob)}: ${unsafeReason}.`,
        remedy:
          'Keep every workspace glob relative to the declared workspace root; absolute paths and parent-directory (`..`) segments are not supported.',
      });
      continue;
    }
    if (!glob) continue;
    if (negated) {
      negations.push(globToRegExp(glob));
    } else {
      positiveGlobs.push(glob);
    }
  }

  const matched = new Set<string>();
  const budget: WorkspaceGlobTraversalBudget = { entries: 0 };

  try {
    for (const glob of positiveGlobs) {
      for (const dir of expandGlob(rootDir, glob, budget)) {
        matched.add(dir);
      }
    }
  } catch (error) {
    if (!(error instanceof WorkspaceGlobTraversalLimitError)) throw error;
    diagnostics.push({
      severity: 'error',
      code: 'workspace-glob-expansion-limit',
      message: error.message,
      remedy:
        'Narrow the workspace package globs or remove repeated broad globstars. Discovery stopped without reading any partially matched package set.',
    });
    return { dirs: [], diagnostics, fatal: true };
  }

  const resolvedRoot = realpathSync(rootDir);
  const confined = [...matched]
    .map((dir) => confinedRealPath(resolvedRoot, dir))
    .filter((dir): dir is string => dir !== undefined);
  if (confined.length !== matched.size) {
    diagnostics.push({
      severity: 'error',
      code: 'workspace-glob-root-escape',
      message:
        'Rejected a workspace package directory whose real path resolves outside the workspace root.',
      remedy:
        'Keep workspace packages inside the workspace root and do not route workspace globs through symlinks to sibling directories.',
    });
  }

  const dirs = [...new Set(confined)]
    .filter((dir) => existsSync(join(dir, 'package.json')))
    .filter((dir) => {
      const rel = relative(rootDir, dir).replaceAll('\\', '/');
      return rel !== '' && !negations.some((pattern) => pattern.test(rel));
    })
    .sort();

  return { dirs, diagnostics, fatal: false };
}

function normalizeGlob(glob: string): string {
  return glob
    .trim()
    .replaceAll('\\', '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '');
}

function unsafeWorkspaceGlobReason(glob: string): string | undefined {
  if (glob.includes('\0')) return 'NUL bytes are not valid path content';
  if (isAbsolute(glob) || /^[A-Za-z]:\//.test(glob)) {
    return 'absolute paths are outside the workspace trust boundary';
  }
  if (glob.split('/').includes('..')) {
    return 'parent-directory segments can escape the workspace root';
  }
  return undefined;
}

function confinedRealPath(
  resolvedRoot: string,
  candidate: string,
): string | undefined {
  try {
    const resolvedCandidate = realpathSync(candidate);
    const rel = relative(resolvedRoot, resolvedCandidate);
    if (
      rel === '' ||
      (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
    ) {
      // Preserve the caller's lexical root for stable relative paths after
      // validating the candidate's canonical target.
      return candidate;
    }
  } catch {
    // A disappeared or unreadable candidate is not a package directory.
  }
  return undefined;
}

function expandGlob(
  rootDir: string,
  glob: string,
  budget: WorkspaceGlobTraversalBudget,
): string[] {
  const segments = glob.split('/').filter((segment) => segment !== '');
  if (segments.length === 0) return [];

  let current = [rootDir];
  for (const [segmentIndex, segment] of segments.entries()) {
    const next: string[] = [];
    for (const dir of current) {
      if (segment === '**') {
        // A globstar may consume zero segments, so `apps/**/host` must also
        // match `apps/host`.
        next.push(dir, ...descendantDirs(dir, budget, glob));
        continue;
      }
      if (segment.includes('*')) {
        const pattern = globToRegExp(segment);
        next.push(
          ...childDirs(dir, budget, glob).filter((child) =>
            pattern.test(basename(child)),
          ),
        );
        continue;
      }
      const literal = join(dir, segment);
      const isFinalSegment = segmentIndex === segments.length - 1;
      if (isDirectory(literal) || (isFinalSegment && isSymbolicLink(literal))) {
        next.push(literal);
      }
    }
    current = [...new Set(next)];
    if (current.length === 0) break;
  }

  return current;
}

function childDirs(
  dir: string,
  budget: WorkspaceGlobTraversalBudget,
  glob: string,
): string[] {
  const children: string[] = [];
  try {
    const directory = opendirSync(dir);
    try {
      let entry: Dirent | null = directory.readSync();
      while (entry !== null) {
        budget.entries += 1;
        if (budget.entries > MAX_WORKSPACE_GLOB_TRAVERSAL_ENTRIES) {
          throw new WorkspaceGlobTraversalLimitError(glob);
        }
        if (entry.isDirectory() && !WALK_SKIP_DIRS.has(entry.name)) {
          children.push(join(dir, entry.name));
        }
        entry = directory.readSync();
      }
    } finally {
      directory.closeSync();
    }
    return children;
  } catch (error) {
    if (error instanceof WorkspaceGlobTraversalLimitError) throw error;
    return children;
  }
}

function descendantDirs(
  dir: string,
  budget: WorkspaceGlobTraversalBudget,
  glob: string,
): string[] {
  const descendants: string[] = [];
  const pending = [dir];
  for (let index = 0; index < pending.length; index += 1) {
    const children = childDirs(pending[index] as string, budget, glob);
    descendants.push(...children);
    pending.push(...children);
  }
  return descendants;
}

function isDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isSymbolicLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
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
  diagnostics: KnowledgeDiagnostic[];
} {
  const { globs, source } = readWorkspaceGlobs(rootDir);
  const expansion = expandWorkspaceGlobs(rootDir, globs);
  // A single-package repo is its own package, and a workspace root can also own
  // objects. Coverage reporting makes an empty root visible instead of hiding
  // it behind the old "only if it already has an artifact" gate (#2143).
  const dirs = expansion.fatal
    ? []
    : existsSync(join(rootDir, 'package.json'))
      ? [
          rootDir,
          ...expansion.dirs.filter((dir) => resolve(dir) !== resolve(rootDir)),
        ]
      : expansion.dirs;
  if (dirs.length > MAX_DISCOVERED_WORKSPACE_PACKAGES) {
    return {
      globs,
      globSource: source,
      dirs: [],
      diagnostics: [
        ...expansion.diagnostics,
        {
          severity: 'error',
          code: 'workspace-package-limit',
          message: `Workspace discovery found ${dirs.length} packages, exceeding the ${MAX_DISCOVERED_WORKSPACE_PACKAGES}-package limit.`,
          remedy:
            'Narrow the workspace package globs. Discovery stopped without reading any partially matched package set.',
        },
      ],
    };
  }
  return {
    globs,
    globSource: source,
    dirs,
    diagnostics: expansion.diagnostics,
  };
}

/**
 * Installed `@happyvertical/*` packages, resolved once each (#2275).
 *
 * Reads the `@happyvertical` scope directory of the project and of every
 * workspace package — one `readdir` per scope directory, resolving each entry's
 * real path — instead of descending through `node_modules`. Under pnpm those
 * entries are symlinks into a store whose entries link back out to each other,
 * so a descent revisits the same package once per path that reaches it. The
 * realpath is the dedupe key only: the same store entry reached from three
 * scope directories is read once, but it is read through its `node_modules`
 * path, because a realpath is the wrong thing to report. On a host where any
 * ancestor of the root is a symlink (`/var` on macOS, a symlinked worktree),
 * `relative(rootDir, realpath)` escapes the root entirely.
 *
 * Workspace packages linked into a sibling's `node_modules` are skipped here.
 * They are authored source that happens to be reachable through a link, and
 * calling them installed would exempt them from the freshness gate.
 *
 * Both SMRT and SDK packages are returned. A consumer app authors neither, and
 * its `@happyvertical/smrt-*` dependencies are exactly the surface it needs to
 * audit; excluding them is why the index could see nothing in a consumer app.
 */
function discoverInstalledPackages(
  rootDir: string,
  packageDirs: string[],
  includeDocs: boolean,
): KnowledgePackage[] {
  const scopeDirs = [
    join(rootDir, 'node_modules', '@happyvertical'),
    ...packageDirs.map((dir) => join(dir, 'node_modules', '@happyvertical')),
  ];
  const workspaceRealPaths = new Set(
    [rootDir, ...packageDirs].flatMap((dir) => {
      try {
        return [realpathSync(dir)];
      } catch {
        return [];
      }
    }),
  );

  const byRealPath = new Map<string, string>();
  for (const scopeDir of new Set(scopeDirs)) {
    if (!existsSync(scopeDir)) continue;
    let entries: Dirent[];
    try {
      entries = readdirSync(scopeDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const entryPath = join(scopeDir, entry.name);
      let resolved: string;
      try {
        resolved = realpathSync(entryPath);
      } catch {
        // A dangling link is not an installed package.
        continue;
      }
      if (workspaceRealPaths.has(resolved)) continue;
      if (byRealPath.has(resolved)) continue;
      byRealPath.set(resolved, entryPath);
    }
  }

  const packages: KnowledgePackage[] = [];
  for (const directory of byRealPath.values()) {
    const packageJson = objectRecord(readJson(join(directory, 'package.json')));
    const name = packageJson.name;
    if (typeof name !== 'string') continue;
    if (
      !SDK_PACKAGE_NAMES.has(name) &&
      !name.startsWith('@happyvertical/smrt-')
    )
      continue;
    packages.push(
      readKnowledgePackage(rootDir, directory, includeDocs, {
        installed: true,
      }),
    );
  }
  return packages.sort((a, b) => a.name.localeCompare(b.name));
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
          pkg.kind !== 'sdk' &&
          !pkg.isInstalledDependency &&
          !pkg.relativeDirectory.includes('node_modules')
        );
      case 'package':
        return pkg.kind !== 'sdk' && !pkg.isInstalledDependency;
      case 'sdk':
        return pkg.kind === 'sdk';
      case 'installed':
        return pkg.isInstalledDependency;
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
  options: { installed?: boolean } = {},
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
  const manifest = readManifest(directory);
  const discoveredDomainKnowledge = readDomainKnowledge(directory);
  const domainKnowledge = discoveredDomainKnowledge
    ? {
        ...discoveredDomainKnowledge,
        content: sanitizeDomainKnowledgeManifest(
          discoveredDomainKnowledge.content,
          manifest?.content,
          name,
        ),
      }
    : null;
  const docSource = hasAgentsMd
    ? 'AGENTS.md'
    : fallbackClaudeDoc
      ? 'CLAUDE.md'
      : null;
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
    // Always hashed, even when doc bodies are excluded: the hash is the drift
    // signal, and dropping it with the body would make `includeDocs: false`
    // useless for a consumer audit (#2275).
    agentDocSha256: hasAgentsMd
      ? createHash('sha256').update(agentsContent).digest('hex')
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
    agentSurface: domainKnowledge?.content.agentSurface,
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
    isInstalledDependency: options.installed === true,
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
async function applyScannerFallback(
  pkg: KnowledgePackage,
  extraExcludes: string[] = [],
): Promise<void> {
  if (pkg.objectSource !== 'none') return;
  if (!hasScannableSources(pkg.directory)) {
    pkg.objectSourceReason = `${pkg.objectSourceReason ?? 'no-artifact'}; no-typescript-sources`;
    return;
  }

  try {
    const objects = await scanPackageObjects(
      pkg.directory,
      pkg.name,
      extraExcludes,
    );
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

async function applyScannerFallbacks(
  packages: KnowledgePackage[],
  memberExcludes: string[],
): Promise<void> {
  for (
    let offset = 0;
    offset < packages.length;
    offset += MAX_SCANNER_CONCURRENCY
  ) {
    await Promise.all(
      packages
        .slice(offset, offset + MAX_SCANNER_CONCURRENCY)
        .map((pkg) =>
          applyScannerFallback(pkg, pkg.isWorkspaceRoot ? memberExcludes : []),
        ),
    );
  }
}

/**
 * Stops at the first candidate instead of walking a whole tree.
 *
 * Deliberately unbounded in depth: a package may keep its models at
 * `src/features/billing/models/internal/Invoice.ts`, and a shallow probe would
 * report "no TypeScript sources" for a package `OxcScanner` can actually read.
 */
function hasScannableSources(directory: string): boolean {
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

  return subdirectories.some((child) => hasScannableSources(child));
}

async function scanPackageObjects(
  directory: string,
  packageName: string,
  extraExcludes: string[] = [],
): Promise<KnowledgeObject[]> {
  const scanner = new OxcScanner({
    cwd: directory,
    include: SCAN_INCLUDE,
    exclude: [...SCAN_EXCLUDE, ...extraExcludes],
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
    const knowledgeFields = Object.entries(fields)
      .filter(([, field]) => !isSensitiveKnowledgeField(field))
      .map(([fieldName, field]) => {
        const columnName = camelToSnake(fieldName);
        const column = objectRecord(schemaColumns[columnName]);
        return projectKnowledgeField(fieldName, field, column.type);
      });
    const methods = objectRecord(item.methods);
    const sensitiveIdentifiers = sensitiveKnowledgeFieldIdentifiers(
      Object.entries(fields),
    );
    const tenant = sanitizeKnowledgeTenant(
      projectTenant(decoratorConfig.tenantScoped),
      sensitiveIdentifiers,
    );
    const conflictColumns = stringArray(decoratorConfig.conflictColumns).filter(
      (column) => !sensitiveIdentifiers.has(column),
    );

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
      methods: Object.keys(methods).sort(),
      methodSignatures: projectMethodSignatures(methods),
      tenant,
      tableStrategy:
        decoratorConfig.tableStrategy === 'cti' ||
        decoratorConfig.tableStrategy === 'sti'
          ? decoratorConfig.tableStrategy
          : undefined,
      conflictColumns: conflictColumns.length > 0 ? conflictColumns : undefined,
    };
  });
}

function readDomainKnowledgeObjects(
  manifest: DomainKnowledgeManifest,
): KnowledgeObject[] {
  return manifest.objects.map((object) => {
    const sensitiveIdentifiers = sensitiveKnowledgeFieldIdentifiers(
      object.fields.map((field) => [field.name, field]),
    );
    const fields = object.fields
      .filter((field) => !isSensitiveKnowledgeField(field))
      .map((field) => projectKnowledgeField(field.name, field));
    const safeFieldNames = new Set(fields.map((field) => field.name));
    const conflictColumns = object.conflictColumns?.filter(
      (column) => !sensitiveIdentifiers.has(column),
    );
    const tenant = sanitizeKnowledgeTenant(
      object.tenant ? { ...object.tenant } : undefined,
      sensitiveIdentifiers,
    );
    return {
      className: object.name,
      qualifiedName: object.qualifiedName,
      extends: object.extends,
      collection: object.collection,
      mcpOperations: object.surfaces
        .filter((surface) => surface.kind === 'mcp')
        .map((surface) => surface.operation)
        .sort(),
      tableName: object.tableName,
      idColumnType: fields.find((field) => field.name === 'id')?.columnType,
      fields,
      relationships: object.relationships
        .filter(
          (field) =>
            safeFieldNames.has(field.name) && !isSensitiveKnowledgeField(field),
        )
        .map((field) => projectKnowledgeField(field.name, field)),
      methods: object.methods,
      methodSignatures: object.methodSignatures?.map((signature) => ({
        name: signature.name,
        async: signature.async,
        static: signature.static,
        params: signature.params ? [...signature.params] : undefined,
        returns: signature.returns,
      })),
      tenant,
      tableStrategy: object.tableStrategy,
      conflictColumns:
        conflictColumns && conflictColumns.length > 0
          ? conflictColumns
          : undefined,
    };
  });
}

function sanitizeDomainKnowledgeManifest(
  manifest: DomainKnowledgeManifest,
  rawManifest?: Record<string, unknown>,
  packageName?: string,
): DomainKnowledgeManifest {
  const rawObjects = rawManifest
    ? ownedManifestObjectsByIdentity(rawManifest, packageName)
    : new Map<string, Record<string, unknown>>();
  const projectionIsSanitized = manifest.sensitiveFieldsExcluded === true;
  return {
    ...manifest,
    objects: manifest.objects.map((object): DomainKnowledgeObject => {
      const rawObject =
        (object.qualifiedName
          ? rawObjects.get(object.qualifiedName)
          : undefined) ?? rawObjects.get(object.name);
      const rawFields = objectRecord(rawObject?.fields);
      const artifactSensitiveIdentifiers = sensitiveKnowledgeFieldIdentifiers(
        object.fields.map((field) => [field.name, field]),
      );
      const rawSensitiveIdentifiers = sensitiveKnowledgeFieldIdentifiers(
        Object.entries(rawFields),
      );
      const sensitiveIdentifiers = new Set([
        ...artifactSensitiveIdentifiers,
        ...rawSensitiveIdentifiers,
      ]);
      const rawSafeFieldNames = new Set(
        Object.entries(rawFields)
          .filter(([, field]) => !isSensitiveKnowledgeField(field))
          .map(([name]) => name),
      );
      const canTrustField = (field: DomainKnowledgeField) =>
        projectionIsSanitized ||
        (rawObject !== undefined && rawSafeFieldNames.has(field.name));
      const fields = object.fields
        .filter(
          (field) => canTrustField(field) && !isSensitiveKnowledgeField(field),
        )
        .map((field) => projectKnowledgeField(field.name, field));
      const safeFieldNames = new Set(fields.map((field) => field.name));
      const rawDecoratorConfig = objectRecord(rawObject?.decoratorConfig);
      const projectedConflictColumns = projectionIsSanitized
        ? object.conflictColumns
        : rawObject
          ? stringArray(rawDecoratorConfig.conflictColumns)
          : undefined;
      const conflictColumns = projectedConflictColumns?.filter(
        (column) => !sensitiveIdentifiers.has(column),
      );
      const projectedTenant = projectionIsSanitized
        ? object.tenant
        : rawObject
          ? projectTenant(rawDecoratorConfig.tenantScoped)
          : object.tenant
            ? { scoped: object.tenant.scoped, mode: object.tenant.mode }
            : undefined;
      return {
        ...object,
        fields,
        relationships: object.relationships
          .filter(
            (field) =>
              safeFieldNames.has(field.name) &&
              !isSensitiveKnowledgeField(field),
          )
          .map((field) => projectKnowledgeField(field.name, field)),
        tenant: sanitizeKnowledgeTenant(projectedTenant, sensitiveIdentifiers),
        conflictColumns:
          conflictColumns && conflictColumns.length > 0
            ? conflictColumns
            : undefined,
      };
    }),
  };
}

function ownedManifestObjectsByIdentity(
  manifest: Record<string, unknown>,
  packageName?: string,
): Map<string, Record<string, unknown>> {
  const owned = packageName
    ? partitionOwnedObjects(manifest, packageName).owned
    : objectRecord(manifest.objects);
  const objects = new Map<string, Record<string, unknown>>();
  for (const [key, value] of Object.entries(owned)) {
    const object = objectRecord(value);
    objects.set(key, object);
    if (typeof object.className === 'string') {
      objects.set(object.className, object);
    }
    if (typeof object.qualifiedName === 'string') {
      objects.set(object.qualifiedName, object);
    }
  }
  return objects;
}

function isSensitiveKnowledgeField(value: unknown): boolean {
  const field = objectRecord(value);
  return (
    field.sensitive === true || objectRecord(field._meta).sensitive === true
  );
}

function sensitiveKnowledgeFieldIdentifiers(
  fields: Array<[string, unknown]>,
): Set<string> {
  return new Set(
    fields
      .filter(([, field]) => isSensitiveKnowledgeField(field))
      .flatMap(([name]) => [name, toSnakeCase(name), camelToSnake(name)]),
  );
}

function projectKnowledgeField(
  name: string,
  value: unknown,
  columnType?: unknown,
): KnowledgeField {
  const field = objectRecord(value);
  const meta = objectRecord(field._meta);
  const declaredConstraints = objectRecord(field.constraints);
  const constraints: DomainKnowledgeFieldConstraints = {};
  for (const key of ['min', 'max', 'minLength', 'maxLength'] as const) {
    const candidate = field[key] ?? meta[key] ?? declaredConstraints[key];
    if (typeof candidate === 'number') constraints[key] = candidate;
  }
  const pattern = normalizeKnowledgePattern(
    field.pattern ?? meta.pattern ?? declaredConstraints.pattern,
  );
  if (pattern !== undefined) constraints.pattern = pattern;
  const hasDefault = Object.hasOwn(field, 'default')
    ? field.default !== undefined
    : meta.default !== undefined;

  return {
    name,
    type: String(field.type ?? 'unknown'),
    required: typeof field.required === 'boolean' ? field.required : undefined,
    related: typeof field.related === 'string' ? field.related : undefined,
    columnType:
      typeof columnType === 'string'
        ? columnType
        : typeof field.columnType === 'string'
          ? field.columnType
          : undefined,
    ...(hasDefault
      ? {
          default: Object.hasOwn(field, 'default')
            ? field.default
            : meta.default,
        }
      : {}),
    constraints: Object.keys(constraints).length > 0 ? constraints : undefined,
    readonly:
      field.readonly === true || meta.readonly === true ? true : undefined,
    transient:
      field.transient === true || meta.transient === true ? true : undefined,
  };
}

function normalizeKnowledgePattern(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  const source = objectRecord(value).source;
  return typeof source === 'string' ? source : undefined;
}

function projectTenant(value: unknown): DomainKnowledgeTenant | undefined {
  if (value === true) {
    return { scoped: true, mode: 'required', field: 'tenantId' };
  }
  const config = objectRecord(value);
  if (Object.keys(config).length === 0) return undefined;
  return {
    scoped: true,
    mode: config.mode === 'optional' ? 'optional' : 'required',
    field: typeof config.field === 'string' ? config.field : 'tenantId',
  };
}

function sanitizeKnowledgeTenant(
  tenant: DomainKnowledgeTenant | undefined,
  sensitiveIdentifiers: Set<string>,
): DomainKnowledgeTenant | undefined {
  if (!tenant?.field || !sensitiveIdentifiers.has(tenant.field)) return tenant;
  return { scoped: tenant.scoped, mode: tenant.mode };
}

function projectMethodSignatures(
  methods: Record<string, unknown>,
): DomainKnowledgeMethodSignature[] | undefined {
  const signatures = Object.entries(methods)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([methodName, value]) => {
      const method = objectRecord(value);
      const params = Array.isArray(method.parameters)
        ? method.parameters.map((raw) => {
            const parameter = objectRecord(raw);
            const name =
              typeof parameter.name === 'string' ? parameter.name : 'arg';
            const type =
              typeof parameter.type === 'string' ? parameter.type : 'unknown';
            return `${name}${parameter.optional === true ? '?' : ''}: ${type}`;
          })
        : undefined;
      return {
        name: typeof method.name === 'string' ? method.name : methodName,
        async: method.async === true ? true : undefined,
        static: method.isStatic === true ? true : undefined,
        params: params && params.length > 0 ? params : undefined,
        returns:
          typeof method.returnType === 'string' && method.returnType
            ? method.returnType
            : undefined,
      };
    });
  return signatures.length > 0 ? signatures : undefined;
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

/**
 * True when either package declares the other as a dependency.
 *
 * This is what separates a re-qualified copy from a coincidence. A consuming
 * package can only restate its *dependencies'* objects, so a shared identity
 * across a dependency edge is one table reported twice. Two unrelated packages
 * that happen to share a class and table name (observed: `Account::accounts` in
 * both smrt-messages and smrt-ledgers) are genuinely distinct objects and must
 * both keep contributing their fields.
 */
function hasDependencyEdge(a: KnowledgePackage, b: KnowledgePackage): boolean {
  return dependsOn(a, b.name) || dependsOn(b, a.name);
}

/**
 * Picks the copy that owns the class within one connected group.
 *
 * Ownership follows the dependency direction: a consumer can restate its
 * *dependency's* objects, never the reverse, so the entry that the most other
 * members of the group depend on is the declaring package. Provenance alone is
 * not enough — preferring a scanner copy kept `smrt-support`'s compatibility
 * subtype over the canonical `smrt-projects` model and changed the facts.
 */
function pickOwningEntry(
  entries: Array<{ pkg: KnowledgePackage; object: KnowledgeObject }>,
): { pkg: KnowledgePackage; object: KnowledgeObject } {
  let best = entries[0];
  let bestScore = -1;
  for (const entry of entries) {
    const score = entries.filter(
      (other) => other !== entry && dependsOn(other.pkg, entry.pkg.name),
    ).length;
    // Entries arrive name-sorted, so ties resolve deterministically.
    if (score > bestScore) {
      best = entry;
      bestScore = score;
    }
  }
  return best;
}

function dependsOn(pkg: KnowledgePackage, name: string): boolean {
  return (
    name in pkg.dependencies ||
    name in pkg.devDependencies ||
    name in pkg.peerDependencies
  );
}

function dedupeObjectsByIdentity(
  packages: KnowledgePackage[],
): KnowledgeObject[] {
  const groups = groupObjectsByIdentity(packages);
  return [...groups.values()].flatMap((entries) =>
    collapseIdentityGroup(entries).map((entry) => entry.object),
  );
}

function groupObjectsByIdentity(
  packages: KnowledgePackage[],
): Map<string, Array<{ pkg: KnowledgePackage; object: KnowledgeObject }>> {
  const groups = new Map<
    string,
    Array<{ pkg: KnowledgePackage; object: KnowledgeObject }>
  >();
  for (const pkg of packages) {
    for (const object of pkg.objects) {
      const identity = objectIdentity(object);
      const entries = groups.get(identity) ?? [];
      entries.push({ pkg, object });
      groups.set(identity, entries);
    }
  }
  return groups;
}

/**
 * Collapses entries linked by dependency edges, leaving unrelated same-named
 * objects intact.
 *
 * Grouping is by connected component, not a greedy first match: when two
 * independent consumers both restate one shared dependency's object, neither
 * consumer has an edge to the other, so a greedy pass would keep both and
 * double-count the very table this exists to collapse. Packages arrive
 * name-sorted, so the result is stable.
 */
function collapseIdentityGroup(
  entries: Array<{ pkg: KnowledgePackage; object: KnowledgeObject }>,
): Array<{ pkg: KnowledgePackage; object: KnowledgeObject }> {
  if (entries.length === 1) return entries;

  const parent = entries.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root];
    return root;
  };
  for (let a = 0; a < entries.length; a += 1) {
    for (let b = a + 1; b < entries.length; b += 1) {
      if (!hasDependencyEdge(entries[a].pkg, entries[b].pkg)) continue;
      const rootA = find(a);
      const rootB = find(b);
      if (rootA !== rootB) parent[rootB] = rootA;
    }
  }

  const components = new Map<
    number,
    Array<{ pkg: KnowledgePackage; object: KnowledgeObject }>
  >();
  for (const [index, entry] of entries.entries()) {
    const root = find(index);
    components.set(root, [...(components.get(root) ?? []), entry]);
  }

  return [...components.values()].map((component) =>
    component.length === 1 ? component[0] : pickOwningEntry(component),
  );
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

/**
 * Flag fields whose declared numeric precision contradicts their name (#2361):
 * money declared decimal, or a rate declared integer.
 *
 * Both kinds fail closed on `@happyvertical/smrt-*`. The framework has zero
 * violations of either rule: the rates were already correct (#2361), and the
 * twenty-one money fields across commerce, projects, subscriptions, support and
 * the conformance fixture converted to integer minor units in #2401, along with
 * the data migration that rescales existing columns. The gate now holds both
 * lines at zero rather than watching money drift back.
 *
 * Consumer packages always warn: the framework cannot know a downstream
 * project's money convention, and a hard failure would make
 * `dev:knowledge-check` unpassable there.
 *
 * Source, not manifest, is the oracle: the manifest records the resulting
 * column type but not whether the author chose it, so only the source can tell
 * `@field({ type: 'decimal' })` (a decision) from `= 0.0` (a default nobody
 * made).
 */
function findNumericPrecisionIssues(
  index: SmrtKnowledgeIndex,
  authoredPackages: KnowledgePackage[],
  changedFiles?: string[],
): KnowledgeIssue[] {
  const changedAbsolutePaths = changedFiles
    ? new Set(changedFiles.map((file) => resolve(index.rootDir, file)))
    : undefined;
  const issues: KnowledgeIssue[] = [];

  for (const pkg of authoredPackages) {
    if (pkg.kind === 'sdk') continue;
    const srcDir = join(pkg.directory, 'src');
    if (!existsSync(srcDir)) continue;
    const isFramework = pkg.kind === 'smrt';

    for (const filePath of walkFiles(srcDir)) {
      if (!isLintableModelSource(filePath)) continue;
      if (changedAbsolutePaths && !changedAbsolutePaths.has(filePath)) continue;
      let sourceText: string;
      try {
        sourceText = readFileSync(filePath, 'utf8');
      } catch {
        continue;
      }
      // Parsing every file in the workspace would dominate this check; the
      // pre-filter is conservative, so it only ever skips files that could not
      // have produced a finding.
      if (!sourceMayContainNumericPrecisionIssue(sourceText)) continue;

      const parsed = parseSource(sourceText, filePath);
      for (const finding of lintNumericPrecision(parsed.classes, sourceText)) {
        const location = finding.line > 0 ? `:${finding.line}` : '';
        // See this function's doc comment: the framework is at zero for both
        // rules, so both fail closed there; consumers always warn.
        const severity: KnowledgeIssueSeverity = isFramework
          ? 'error'
          : 'warning';
        issues.push({
          severity,
          code: `numeric-precision-${finding.kind}`,
          message: `${finding.message} ${finding.remedy}`,
          file: `${relative(index.rootDir, filePath)}${location}`,
          packageName: pkg.name,
        });
      }
    }
  }

  return issues;
}

/** Only authored, non-generated TypeScript model sources are linted. */
function isLintableModelSource(filePath: string): boolean {
  if (!filePath.endsWith('.ts') && !filePath.endsWith('.tsx')) return false;
  if (filePath.endsWith('.d.ts')) return false;
  if (/\.(test|spec)\.tsx?$/.test(filePath)) return false;
  const parts = filePath.split(sep);
  // `template/` holds consumer scaffolding this repo's rules do not govern
  // (biome skips it too), and `__tests__/` is fixtures.
  return !parts.includes('__tests__') && !parts.includes('template');
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
    const changedPackageFiles = changedFiles.filter((file) =>
      packageOwnsFile(pkg, file, index.packages),
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

/**
 * Joins a package-relative path onto a package's workspace-relative directory.
 *
 * The workspace root can itself be an indexed package — including the
 * single-package layout #2143 added — and its `relativeDirectory` is the empty
 * string. Naive interpolation emits `/AGENTS.md`, an absolute filesystem path,
 * instead of the project-relative path callers are told to read.
 */
function packageRelativePath(pkg: KnowledgePackage, path: string): string {
  return pkg.relativeDirectory ? `${pkg.relativeDirectory}/${path}` : path;
}

/**
 * Workspace-relative paths of a package's authored documentation.
 *
 * Shared with the MCP transport layer so the summary projection and the
 * Markdown bundle can never disagree about where a doc lives.
 */
export function packageDocPaths(pkg: KnowledgePackage): string[] {
  return [
    ...(pkg.docSource ? [packageRelativePath(pkg, pkg.docSource)] : []),
    ...pkg.moduleDocs.map((doc) => packageRelativePath(pkg, doc.path)),
  ];
}

/**
 * True when a workspace-relative changed file belongs to `pkg`.
 *
 * A workspace-root package has an empty `relativeDirectory`, so the nested-path
 * test would compare against a leading `/` and never match — which silently
 * selected no packages for exactly the single-package layout #2143 added. The
 * root instead owns any path no member package owns, mirroring the
 * member-excluded scan in `applyScannerFallbacks`.
 */
function packageOwnsFile(
  pkg: KnowledgePackage,
  file: string,
  siblings: readonly KnowledgePackage[],
): boolean {
  if (pkg.relativeDirectory) {
    return (
      file === pkg.relativeDirectory ||
      file.startsWith(`${pkg.relativeDirectory}/`)
    );
  }
  return !siblings.some(
    (member) =>
      member !== pkg &&
      member.relativeDirectory &&
      (file === member.relativeDirectory ||
        file.startsWith(`${member.relativeDirectory}/`)),
  );
}

function isPackageManifestFile(pkg: KnowledgePackage, file: string): boolean {
  return file === packageRelativePath(pkg, 'package.json');
}

function isPackageAgentDocFile(pkg: KnowledgePackage, file: string): boolean {
  return (
    file === packageRelativePath(pkg, 'AGENTS.md') ||
    // A linked module doc carries the same authored expertise (#2108).
    pkg.moduleDocs.some((doc) => file === packageRelativePath(pkg, doc.path))
  );
}

function isPublicEntrypointFile(pkg: KnowledgePackage, file: string): boolean {
  const sourcePrefix = packageRelativePath(pkg, 'src/');
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
  const candidates = domainPackages(index);
  for (const file of changedFiles) {
    for (const pkg of candidates) {
      if (packageOwnsFile(pkg, file, index.packages)) {
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
      if (
        scopeAllowsPackage(pkg, options.scope) &&
        packageMatches(pkg, packageName)
      ) {
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
      if (pkg && scopeAllowsPackage(pkg, options.scope)) selected.add(pkg);
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
    const selectedDependency = sdkNames.has(sdk.name);
    if (!scopeAllowsSdkPackage(sdk, options.scope, selectedDependency))
      continue;
    const shortName = sdk.name.replace('@happyvertical/', '');
    if (
      options.scope === 'sdk' ||
      selectedDependency ||
      (packageName && packageMatches(sdk, packageName)) ||
      text.includes(sdk.name.toLowerCase()) ||
      includesToken(text, shortName)
    ) {
      selected.add(sdk);
    }
  }

  if (selected.size === 0 && !(packageName && selectedPackages.length === 0)) {
    for (const name of [
      '@happyvertical/ai',
      '@happyvertical/sql',
      '@happyvertical/files',
      '@happyvertical/utils',
    ]) {
      const sdk = index.sdkPackages.find(
        (item) =>
          item.name === name &&
          scopeAllowsSdkPackage(item, options.scope, false),
      );
      if (sdk) selected.add(sdk);
    }
  }

  return [...selected].sort((a, b) => a.name.localeCompare(b.name));
}

function scopeAllowsSdkPackage(
  pkg: KnowledgePackage,
  scope: KnowledgeScope | undefined,
  selectedDependency: boolean,
): boolean {
  switch (scope) {
    case 'installed':
      return pkg.isInstalledDependency;
    case 'local':
    case 'package':
      return !pkg.isInstalledDependency || selectedDependency;
    case 'sdk':
    case 'project':
    case undefined:
      return true;
  }
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
    case 'installed':
      return pkg.isInstalledDependency;
    case 'local':
      return (
        !pkg.isInstalledDependency &&
        !pkg.relativeDirectory.includes('node_modules')
      );
    case 'package':
      return !pkg.isInstalledDependency;
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

function packageSpecialistSourceFiles(
  rootDir: string,
  pkg: KnowledgePackage,
): string[] {
  const sourceFiles = new Set<string>();
  const addIfExists = (relativePath: string) => {
    if (existsSync(join(rootDir, relativePath))) {
      sourceFiles.add(relativePath);
    }
  };

  addIfExists(join(pkg.relativeDirectory, 'package.json'));
  addIfExists(join(pkg.relativeDirectory, 'README.md'));
  addIfExists(join(pkg.relativeDirectory, 'AGENTS.md'));
  addIfExists(join(pkg.relativeDirectory, 'CHANGELOG.md'));

  if (pkg.domainKnowledgePath) {
    sourceFiles.add(pkg.domainKnowledgePath);
  }
  if (pkg.manifestPath) {
    sourceFiles.add(pkg.manifestPath);
  }

  for (const prompt of pkg.prompts) {
    sourceFiles.add(prompt.filePath);
  }

  const packageFiles = existsSync(pkg.directory)
    ? walkFiles(pkg.directory)
    : [];
  for (const filePath of packageFiles) {
    const relativeFilePath = relative(rootDir, filePath);
    if (isPackageSpecialistSource(relativeFilePath)) {
      sourceFiles.add(relativeFilePath);
    }
  }

  return [...sourceFiles].sort().slice(0, 120);
}

function isPackageSpecialistSource(relativeFilePath: string): boolean {
  return (
    relativeFilePath.endsWith('/src/workbench.ts') ||
    relativeFilePath.endsWith('/src/playground.ts') ||
    relativeFilePath.endsWith('/src/route-module.ts') ||
    relativeFilePath.includes('/src/svelte/playground') ||
    relativeFilePath.includes('/src/svelte/routes/') ||
    relativeFilePath.includes('/src/routes/') ||
    relativeFilePath.includes('/src/prompts/') ||
    /\.test\.[cm]?ts$/.test(relativeFilePath) ||
    /\.spec\.[cm]?ts$/.test(relativeFilePath)
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

  // A workspace-root package has no directory prefix, so every changed path is
  // already package-relative (#2143).
  const prefix = pkg.relativeDirectory ? `${pkg.relativeDirectory}/` : '';
  const packageFiles = (hints?.changedFiles ?? []).filter(
    (file) => file === pkg.relativeDirectory || file.startsWith(prefix),
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
          segment.test(file.slice(prefix.length)) ||
          file === packageRelativePath(pkg, doc.path),
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
    const docPaths = packageDocPaths(pkg);
    if (docPaths.length > 0) {
      lines.push(
        '',
        `> Authored docs not embedded (read on demand, or re-request with detail: "full"): ${docPaths.join(', ')}`,
      );
    }
    lines.push('');
    return lines.join('\n');
  }

  const structuralFacts = renderObjectStructuralFacts(pkg.objects);
  if (structuralFacts.length > 0) {
    lines.push('', '#### Object structural facts', '', ...structuralFacts);
  }

  if (pkg.agentDoc) {
    lines.push('', pkg.agentDoc.trim());
  }
  for (const doc of embedded) {
    lines.push('', `#### ${packageRelativePath(pkg, doc.path)}`, '');
    lines.push(doc.content.trim());
  }
  if (scoped) {
    const omitted = pkg.moduleDocs.filter((doc) => !embedded.includes(doc));
    if (omitted.length > 0) {
      lines.push(
        '',
        `> Module docs not loaded for this request (read on demand): ${omitted
          .map((doc) => packageRelativePath(pkg, doc.path))
          .join(', ')}`,
      );
    }
  }
  lines.push('');
  return lines.join('\n');
}

function renderObjectStructuralFacts(objects: KnowledgeObject[]): string[] {
  const lines: string[] = [];
  for (const object of objects) {
    const objectFacts = [
      object.tenant
        ? object.tenant.scoped
          ? `tenant ${object.tenant.mode ?? 'required'}${object.tenant.field ? ` via ${object.tenant.field}` : ''}`
          : 'tenant unscoped'
        : undefined,
      object.tableStrategy
        ? `table strategy ${object.tableStrategy}`
        : undefined,
      object.conflictColumns && object.conflictColumns.length > 0
        ? `conflict columns ${object.conflictColumns.join(', ')}`
        : undefined,
    ].filter((fact): fact is string => Boolean(fact));
    const structuralFields = object.fields.filter(
      (field) =>
        Object.hasOwn(field, 'default') ||
        field.constraints !== undefined ||
        field.readonly === true ||
        field.transient === true,
    );
    const signatures = object.methodSignatures ?? [];
    if (
      objectFacts.length === 0 &&
      structuralFields.length === 0 &&
      signatures.length === 0
    ) {
      continue;
    }

    lines.push(
      `- ${object.qualifiedName ?? object.className}${objectFacts.length > 0 ? ` — ${objectFacts.join('; ')}` : ''}`,
    );
    for (const field of structuralFields) {
      const facts = [
        Object.hasOwn(field, 'default')
          ? `default ${renderKnowledgeValue(field.default)}`
          : undefined,
        field.constraints
          ? `constraints ${Object.entries(field.constraints)
              .map(([key, value]) => `${key}=${renderKnowledgeValue(value)}`)
              .join(', ')}`
          : undefined,
        field.readonly ? 'readonly' : undefined,
        field.transient ? 'transient' : undefined,
      ].filter((fact): fact is string => Boolean(fact));
      lines.push(
        `  - field ${field.name}: ${field.type} (${facts.join('; ')})`,
      );
    }
    for (const signature of signatures) {
      const prefix = [
        signature.static ? 'static' : '',
        signature.async ? 'async' : '',
      ]
        .filter(Boolean)
        .join(' ');
      lines.push(
        `  - method ${prefix ? `${prefix} ` : ''}${signature.name}(${(signature.params ?? []).join(', ')})${signature.returns ? `: ${signature.returns}` : ''}`,
      );
    }
  }
  return lines;
}

function renderKnowledgeValue(value: unknown): string {
  const rendered = JSON.stringify(value);
  if (rendered === undefined) return String(value);
  return rendered.length > 120 ? `${rendered.slice(0, 117)}...` : rendered;
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
