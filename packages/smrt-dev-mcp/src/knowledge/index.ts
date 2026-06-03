import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

export type KnowledgePackageKind = 'smrt' | 'sdk' | 'workspace';
export type KnowledgeIssueSeverity = 'error' | 'warning';

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
  manifestPath?: string;
  manifestVersion?: string;
  objects: KnowledgeObject[];
  prompts: KnowledgePrompt[];
  mcpTools: KnowledgeMcpTool[];
  relationshipFeatures: string[];
}

export interface SmrtKnowledgeIndex {
  schemaVersion: 1;
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
}

export interface ArchitectureContextResult {
  selectedPackages: KnowledgePackage[];
  selectedSdkPackages: KnowledgePackage[];
  promptBundle: KnowledgePromptBundle;
}

export interface SmrtReviewResult extends ReviewContextResult {
  mode: 'findings' | 'prompt-bundle' | 'both';
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
}

interface CheckKnowledgeFreshnessOptions extends BuildKnowledgeIndexOptions {
  changed?: boolean;
  strict?: boolean;
}

interface ContextSelectorOptions {
  rootDir?: string;
  changedFiles?: string[];
  idea?: string;
  documentation?: string;
  focus?: string;
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
    pattern: new RegExp(`docs:${'Codex'}|docs-${'Codex'}|\\.${'Codex'}`),
    message: 'Stale Codex-specific downstream-doc reference found',
  },
];

export async function buildKnowledgeIndex(
  options: BuildKnowledgeIndexOptions = {},
): Promise<SmrtKnowledgeIndex> {
  const rootDir = findProjectRoot(options.rootDir ?? process.cwd());
  const includeDocs = options.includeDocs ?? true;
  const packageDirs = discoverWorkspacePackageDirs(rootDir);
  const packages = packageDirs.map((dir) =>
    readKnowledgePackage(rootDir, dir, includeDocs),
  );

  packages.push(
    ...discoverInstalledSdkPackages(rootDir, packageDirs, includeDocs),
  );

  const uniquePackages = dedupePackages(packages);
  const smrtPackages = uniquePackages.filter((pkg) => pkg.kind === 'smrt');
  const sdkPackages = uniquePackages.filter((pkg) => pkg.kind === 'sdk');

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    rootDir,
    packages: uniquePackages,
    smrtPackages,
    sdkPackages,
    relationshipsV2: summarizeRelationshipsV2(uniquePackages),
  };
}

export async function checkKnowledgeFreshness(
  options: CheckKnowledgeFreshnessOptions = {},
): Promise<KnowledgeFreshnessResult> {
  const index = await buildKnowledgeIndex(options);
  const issues: KnowledgeIssue[] = [];
  const changedFiles = options.changed
    ? getChangedFiles(index.rootDir)
    : undefined;

  for (const pkg of index.packages.filter((item) => item.kind !== 'sdk')) {
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

    if (!pkg.files.includes('AGENTS.md')) {
      issues.push({
        severity: 'error',
        code: 'package-files-missing-agents',
        message: 'package.json files allowlist must include AGENTS.md',
        file: packageJsonPath,
        packageName: pkg.name,
      });
    }

    if (!pkg.files.includes('CLAUDE.md')) {
      issues.push({
        severity: 'error',
        code: 'package-files-missing-claude-shim',
        message: 'package.json files allowlist must include CLAUDE.md shim',
        file: packageJsonPath,
        packageName: pkg.name,
      });
    }
  }

  issues.push(...findStalePatternIssues(index.rootDir, changedFiles));

  const effectiveIssues = options.strict
    ? issues
    : issues.map((issue) =>
        issue.code.startsWith('stale-')
          ? { ...issue, severity: 'warning' as const }
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

export async function diffKnowledgeIndex(
  options: { rootDir?: string; base?: string } = {},
): Promise<{
  base: string;
  changedFiles: string[];
  changedPackages: string[];
  index: SmrtKnowledgeIndex;
}> {
  const index = await buildKnowledgeIndex({ rootDir: options.rootDir });
  const base = options.base ?? 'HEAD';
  const changedFiles = getChangedFiles(index.rootDir, base);
  const changedPackages = selectPackagesForFiles(index, changedFiles).map(
    (pkg) => pkg.name,
  );
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
  });
  const selectedSdkPackages = selectSdkPackages(index, selectedPackages, [
    options.focus,
    options.documentation,
  ]);
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
    }),
  };
}

export async function smrtReview(
  options: ContextSelectorOptions & {
    mode?: 'findings' | 'prompt-bundle' | 'both';
  } = {},
): Promise<SmrtReviewResult> {
  const context = await buildReviewContext(options);
  return {
    ...context,
    mode: options.mode ?? 'both',
  };
}

export async function buildArchitectureContext(
  options: ContextSelectorOptions = {},
): Promise<ArchitectureContextResult> {
  const index = await buildKnowledgeIndex({ rootDir: options.rootDir });
  const text = [options.idea, options.documentation, options.focus]
    .filter(Boolean)
    .join('\n');
  const selectedPackages = selectPackages(index, { text });
  const selectedSdkPackages = selectSdkPackages(index, selectedPackages, [
    text,
  ]);

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
    `- foreignKey fields: ${index.relationshipsV2.foreignKeyFields}`,
    `- crossPackageRef fields: ${index.relationshipsV2.crossPackageRefFields}`,
    `- junction collections: ${index.relationshipsV2.junctionCollections}`,
    `- hierarchical objects: ${index.relationshipsV2.hierarchicalObjects}`,
    `- polymorphic associations: ${index.relationshipsV2.polymorphicAssociations}`,
    `- UUID columns: ${index.relationshipsV2.uuidColumns}`,
    '',
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
      `- docs: ${pkg.docSource ?? '(none)'}${pkg.hasClaudeShim ? ' + CLAUDE.md shim' : ''}`,
    );
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

function findProjectRoot(startDir: string): string {
  let current = resolve(startDir);
  for (;;) {
    if (
      existsSync(join(current, 'pnpm-workspace.yaml')) &&
      existsSync(join(current, 'packages'))
    ) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) return resolve(startDir);
    current = parent;
  }
}

function discoverWorkspacePackageDirs(rootDir: string): string[] {
  const packagesDir = join(rootDir, 'packages');
  if (!existsSync(packagesDir)) return [];
  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(packagesDir, entry.name))
    .filter((dir) => existsSync(join(dir, 'package.json')))
    .sort();
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
      const pkg = readJson(join(dir, 'package.json'));
      return (
        typeof pkg?.name === 'string' &&
        SDK_PACKAGE_NAMES.has(pkg.name) &&
        !pkg.name.startsWith('@happyvertical/smrt-')
      );
    })
    .map((dir) => readKnowledgePackage(rootDir, dir, includeDocs));
}

function readKnowledgePackage(
  rootDir: string,
  directory: string,
  includeDocs: boolean,
): KnowledgePackage {
  const packageJson = readJson(join(directory, 'package.json')) ?? {};
  const dependencies = objectRecord(packageJson.dependencies);
  const devDependencies = objectRecord(packageJson.devDependencies);
  const peerDependencies = objectRecord(packageJson.peerDependencies);
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
  const docSource = hasAgentsMd
    ? 'AGENTS.md'
    : fallbackClaudeDoc
      ? 'CLAUDE.md'
      : null;
  const manifest = readManifest(directory);
  const objects = manifest ? readManifestObjects(manifest.content) : [];
  const prompts = readPrompts(directory, rootDir);
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
    files: Array.isArray(packageJson.files) ? packageJson.files : [],
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
      ? hasAgentsMd
        ? agentsContent
        : fallbackClaudeDoc || undefined
      : undefined,
    manifestPath: manifest?.path ? relative(rootDir, manifest.path) : undefined,
    manifestVersion:
      typeof manifest?.content.version === 'string'
        ? manifest.content.version
        : undefined,
    objects,
    prompts,
    mcpTools: mcpTools(objects),
    relationshipFeatures: relationshipFeatures(objects),
  };
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
    if (content) return { path, content };
  }
  return null;
}

function readManifestObjects(
  manifest: Record<string, unknown>,
): KnowledgeObject[] {
  const objects = objectRecord(manifest.objects);
  return Object.values(objects).map((raw) => {
    const item = raw as Record<string, any>;
    const fields = objectRecord(item.fields);
    const schemaColumns = objectRecord(item.schema?.columns);
    const decoratorConfig = item.decoratorConfig as
      | Record<string, unknown>
      | undefined;
    const knowledgeFields = Object.entries(fields).map(([fieldName, field]) => {
      const fieldInfo = field as Record<string, any>;
      const columnName = camelToSnake(fieldName);
      const column = schemaColumns[columnName] as
        | Record<string, any>
        | undefined;
      return {
        name: fieldName,
        type: String(fieldInfo.type ?? 'unknown'),
        required:
          typeof fieldInfo.required === 'boolean'
            ? fieldInfo.required
            : undefined,
        related:
          typeof fieldInfo.related === 'string' ? fieldInfo.related : undefined,
        columnType: typeof column?.type === 'string' ? column.type : undefined,
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
      mcpOperations: mcpOperations(item.decoratorConfig?.mcp),
      tableName:
        typeof decoratorConfig?.tableName === 'string'
          ? decoratorConfig.tableName
          : typeof item.schema?.tableName === 'string'
            ? item.schema.tableName
            : undefined,
      idColumnType:
        typeof (schemaColumns.id as Record<string, any> | undefined)?.type ===
        'string'
          ? (schemaColumns.id as Record<string, any>).type
          : undefined,
      fields: knowledgeFields,
      relationships: knowledgeFields.filter((field) =>
        RELATIONSHIP_FIELD_TYPES.has(field.type),
      ),
      methods: Object.keys(objectRecord(item.methods)).sort(),
    };
  });
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

function summarizeRelationshipsV2(packages: KnowledgePackage[]) {
  const objects = packages.flatMap((pkg) => pkg.objects);
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
      : walkFiles(rootDir).filter((file) => {
          const rel = relative(rootDir, file);
          if (rel.includes('node_modules/') || rel.includes('/dist/')) {
            return false;
          }
          if (rel.includes('/CHANGELOG.md') || rel === 'CHANGELOG.md') {
            return false;
          }
          if (rel === 'AGENTS.md' || rel === 'README.md') return true;
          if (rel.endsWith('/AGENTS.md') || rel.endsWith('/README.md')) {
            return true;
          }
          if (!rel.startsWith('docs/content/') || !rel.endsWith('.md')) {
            return false;
          }
          return !(
            rel.startsWith('docs/content/api/') ||
            rel.startsWith('docs/content/rfcs/') ||
            rel.startsWith('docs/content/architecture/')
          );
        });
  const issues: KnowledgeIssue[] = [];
  for (const file of candidates) {
    if (!existsSync(file) || lstatSync(file).isDirectory()) continue;
    const rel = relative(rootDir, file);
    if (rel === 'pnpm-lock.yaml') continue;
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

function buildArchitectureRecommendations(
  context: ArchitectureContextResult,
  ideaText: string,
): SmrtArchitectureResult['recommendations'] {
  const smrtPackages = context.selectedPackages.map((pkg) => pkg.name);
  const sdkPackages = context.selectedSdkPackages.map((pkg) => pkg.name);
  const objectModelSketch = buildObjectModelSketch(context.selectedPackages);
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

function buildObjectModelSketch(packages: KnowledgePackage[]): string[] {
  const lines = packages.flatMap((pkg) => {
    const objects = pkg.objects
      .filter((object) => object.extends !== 'SmrtCollection')
      .slice(0, 6)
      .map((object) => object.className);
    if (objects.length === 0) {
      return [
        `${pkg.name}: use package services or templates; no manifest objects indexed.`,
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
    for (const pkg of index.smrtPackages) {
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
  options: { changedFiles?: string[]; text?: string },
): KnowledgePackage[] {
  const selected = new Set<KnowledgePackage>();
  for (const pkg of selectPackagesForFiles(index, options.changedFiles ?? [])) {
    selected.add(pkg);
  }

  const text = (options.text ?? '').toLowerCase();
  if (text) {
    for (const pkg of index.smrtPackages) {
      const packageKey = pkg.name.replace('@happyvertical/smrt-', '');
      if (
        text.includes(packageKey) ||
        text.includes(pkg.name.toLowerCase()) ||
        pkg.objects.some((object) =>
          text.includes(object.className.toLowerCase()),
        )
      ) {
        selected.add(pkg);
      }
    }
  }

  if (selected.size === 0) {
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
  }

  return [...selected].sort((a, b) => a.name.localeCompare(b.name));
}

function selectSdkPackages(
  index: SmrtKnowledgeIndex,
  selectedPackages: KnowledgePackage[],
  texts: Array<string | undefined>,
): KnowledgePackage[] {
  const selected = new Set<KnowledgePackage>();
  const sdkNames = new Set(
    selectedPackages.flatMap((pkg) => pkg.sdkDependencies),
  );
  const text = texts.filter(Boolean).join('\n').toLowerCase();

  for (const sdk of index.sdkPackages) {
    const shortName = sdk.name.replace('@happyvertical/', '');
    if (
      sdkNames.has(sdk.name) ||
      text.includes(sdk.name.toLowerCase()) ||
      text.includes(shortName)
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

function buildPromptBundle(options: {
  title: string;
  task: string;
  index: SmrtKnowledgeIndex;
  packages: KnowledgePackage[];
  sdkPackages: KnowledgePackage[];
  sourceFiles: string[];
  extraContext?: string;
}): KnowledgePromptBundle {
  const contextMarkdown = [
    `# ${options.title}`,
    '',
    `Baseline root: ${options.index.rootDir}`,
    '',
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
    ...options.packages.map(renderPackageContext),
    '',
    '## Selected SDK Packages',
    '',
    ...options.sdkPackages.map(renderPackageContext),
    '',
    options.extraContext ? `## Extra Context\n\n${options.extraContext}\n` : '',
  ];

  return {
    title: options.title,
    instructions:
      'Use the supplied SMRT knowledge context as source material. Return concrete findings or architecture guidance with package names and source references. Do not assume model-provider access.',
    contextMarkdown: contextMarkdown.join('\n'),
    selectedPackages: options.packages.map((pkg) => pkg.name),
    selectedSdkPackages: options.sdkPackages.map((pkg) => pkg.name),
    sourceFiles: options.sourceFiles,
  };
}

function renderPackageContext(pkg: KnowledgePackage): string {
  const lines = [
    `### ${pkg.name}`,
    '',
    `- version: ${pkg.version}`,
    `- kind: ${pkg.kind}`,
    `- directory: ${pkg.relativeDirectory}`,
    `- docs: ${pkg.docSource ?? '(none)'}`,
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
  if (pkg.agentDoc) {
    lines.push('', pkg.agentDoc.trim());
  }
  lines.push('');
  return lines.join('\n');
}

function getChangedFiles(rootDir: string, base = 'HEAD'): string[] {
  try {
    const output = execFileSync(
      'git',
      ['diff', '--name-only', `${base}...HEAD`],
      { cwd: rootDir, encoding: 'utf8' },
    );
    const files = output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    if (files.length > 0) return files;
  } catch {
    // Fall back to working-tree changes below.
  }

  try {
    const output = execFileSync('git', ['diff', '--name-only'], {
      cwd: rootDir,
      encoding: 'utf8',
    });
    return output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function dedupePackages(packages: KnowledgePackage[]): KnowledgePackage[] {
  const byName = new Map<string, KnowledgePackage>();
  for (const pkg of packages) {
    if (!byName.has(pkg.name) || pkg.kind !== 'sdk') {
      byName.set(pkg.name, pkg);
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function readJson(path: string): any | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function objectRecord(value: unknown): Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};
}

function camelToSnake(value: string): string {
  return value.replace(/[A-Z]/g, (match) => `_${match.toLowerCase()}`);
}
