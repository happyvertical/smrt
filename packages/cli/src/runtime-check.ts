import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  createQualifiedName,
  isQualifiedName,
  ObjectRegistry,
  parseQualifiedName,
} from '@happyvertical/smrt-core';
import {
  loadExternalManifestSync,
  type SmartObjectManifest,
} from '@happyvertical/smrt-core/manifest';
import type { SmartObjectDefinition } from '@happyvertical/smrt-core/scanner';
import {
  autoDiscoverAndLoad,
  type DiscoveredManifest,
  discoverManifests,
  loadManifestFile,
} from './discovery/index.js';

type RuntimeCheckSeverity = 'error' | 'warning' | 'pass';

export interface RuntimeCheckFinding {
  severity: RuntimeCheckSeverity;
  code: string;
  message: string;
}

export interface RuntimeCheckResult {
  projectRoot: string;
  projectManifestPath?: string;
  projectPackageName?: string;
  discoveredManifestCount: number;
  findings: RuntimeCheckFinding[];
}

interface ManifestEntryRef {
  manifestPackageName?: string;
  manifestSource: 'project' | 'dependency';
  key: string;
  definition: SmartObjectDefinition;
}

interface LoadedDependencyManifest {
  manifest: SmartObjectManifest;
  resolverPath: string;
}

type EntryLookupResult =
  | {
      kind: 'resolved';
      entry: ManifestEntryRef;
    }
  | {
      kind: 'ambiguous';
      name: string;
      matches: ManifestEntryRef[];
    }
  | {
      kind: 'missing';
      name: string;
    };

const SYSTEM_FIELDS = new Set([
  'context',
  'created_at',
  'id',
  'slug',
  'tenantId',
  'tenant_id',
  'updated_at',
]);

// pnpm nests package entries under .pnpm/<pkg>/node_modules/<pkg>, so allow a
// bounded upward walk when resolving the owning package.json from an entry path.
const MAX_PACKAGE_JSON_ASCENTS = 12;

function formatDependencyList(dependencies: string[]): string {
  if (dependencies.length <= 3) {
    return dependencies.join(', ');
  }

  return `${dependencies.slice(0, 3).join(', ')}, +${dependencies.length - 3} more`;
}

function addFinding(
  findings: RuntimeCheckFinding[],
  severity: RuntimeCheckSeverity,
  code: string,
  message: string,
): void {
  findings.push({ severity, code, message });
}

function getManifestPackageName(
  manifest: SmartObjectManifest,
  fallback?: string,
): string | undefined {
  return manifest.packageName || fallback;
}

function getEntryClassName(
  key: string,
  definition: SmartObjectDefinition,
): string {
  if (definition.className) {
    return definition.className;
  }

  if (isQualifiedName(key)) {
    return parseQualifiedName(key).className;
  }

  return key;
}

function getEntryQualifiedName(
  key: string,
  definition: SmartObjectDefinition,
  manifestPackageName?: string,
): string {
  if (definition.qualifiedName && isQualifiedName(definition.qualifiedName)) {
    return definition.qualifiedName;
  }

  if (isQualifiedName(key)) {
    return key;
  }

  if (!manifestPackageName) {
    return getEntryClassName(key, definition);
  }

  return createQualifiedName(
    manifestPackageName,
    getEntryClassName(key, definition),
  );
}

function getOwnFieldNames(definition: SmartObjectDefinition): string[] {
  return Object.keys(definition.fields || {}).sort();
}

function getNonSystemFieldNames(definition: SmartObjectDefinition): string[] {
  return getOwnFieldNames(definition).filter(
    (field) => !SYSTEM_FIELDS.has(field),
  );
}

function flattenManifestEntries(
  manifest: SmartObjectManifest,
  source: 'project' | 'dependency',
  fallbackPackageName?: string,
): ManifestEntryRef[] {
  const manifestPackageName = getManifestPackageName(
    manifest,
    fallbackPackageName,
  );

  return Object.entries(manifest.objects || {}).map(([key, objectDef]) => ({
    manifestPackageName,
    manifestSource: source,
    key,
    definition: objectDef as SmartObjectDefinition,
  }));
}

function findProjectManifest(
  manifests: DiscoveredManifest[],
): DiscoveredManifest | undefined {
  return manifests.find((manifest) => manifest.source === 'project');
}

function flattenRuntimeEntries(
  manifests: SmartObjectManifest[],
): ManifestEntryRef[] {
  return manifests.flatMap((manifest, index) =>
    flattenManifestEntries(
      manifest,
      index === 0 ? 'project' : 'dependency',
      manifest.packageName,
    ),
  );
}

function entryMatchesQualifiedName(
  entry: ManifestEntryRef,
  name: string,
): boolean {
  const qualifiedName = getEntryQualifiedName(
    entry.key,
    entry.definition,
    entry.manifestPackageName,
  );

  return (
    qualifiedName === name || qualifiedName.toLowerCase() === name.toLowerCase()
  );
}

function entryMatchesShortName(entry: ManifestEntryRef, name: string): boolean {
  const className = getEntryClassName(entry.key, entry.definition);

  return className === name || className.toLowerCase() === name.toLowerCase();
}

function resolveEntryByName(
  manifests: SmartObjectManifest[],
  name: string,
): EntryLookupResult {
  const entries = flattenRuntimeEntries(manifests);
  const qualifiedMatches = entries.filter((entry) =>
    entryMatchesQualifiedName(entry, name),
  );

  if (qualifiedMatches.length === 1) {
    return {
      kind: 'resolved',
      entry: qualifiedMatches[0],
    };
  }

  if (qualifiedMatches.length > 1) {
    return {
      kind: 'ambiguous',
      name,
      matches: qualifiedMatches,
    };
  }

  const shortName = isQualifiedName(name)
    ? parseQualifiedName(name).className
    : name;
  const shortNameMatches = entries.filter((entry) =>
    entryMatchesShortName(entry, shortName),
  );

  if (shortNameMatches.length === 1) {
    return {
      kind: 'resolved',
      entry: shortNameMatches[0],
    };
  }

  if (shortNameMatches.length > 1) {
    return {
      kind: 'ambiguous',
      name,
      matches: shortNameMatches,
    };
  }

  return {
    kind: 'missing',
    name,
  };
}

function describeEntry(entry: ManifestEntryRef): string {
  return getEntryQualifiedName(
    entry.key,
    entry.definition,
    entry.manifestPackageName,
  );
}

function collectShadowCandidates(
  projectManifest: SmartObjectManifest,
  dependencyManifests: SmartObjectManifest[],
): Array<{
  className: string;
  localEntry: ManifestEntryRef;
  externalEntries: ManifestEntryRef[];
}> {
  const dependencyEntries = dependencyManifests.flatMap((manifest) =>
    flattenManifestEntries(manifest, 'dependency'),
  );
  const byClassName = new Map<string, ManifestEntryRef[]>();

  for (const entry of dependencyEntries) {
    const className = getEntryClassName(
      entry.key,
      entry.definition,
    ).toLowerCase();
    const bucket = byClassName.get(className) || [];
    bucket.push(entry);
    byClassName.set(className, bucket);
  }

  const candidates: Array<{
    className: string;
    localEntry: ManifestEntryRef;
    externalEntries: ManifestEntryRef[];
  }> = [];

  for (const entry of flattenManifestEntries(projectManifest, 'project')) {
    const className = getEntryClassName(entry.key, entry.definition);
    const externalEntries = byClassName.get(className.toLowerCase()) || [];
    if (externalEntries.length > 0) {
      candidates.push({ className, localEntry: entry, externalEntries });
    }
  }

  return candidates;
}

async function loadDependencyManifests(
  rootManifest: SmartObjectManifest,
  projectRoot: string,
  findings: RuntimeCheckFinding[],
): Promise<SmartObjectManifest[]> {
  const loaded = new Map<string, LoadedDependencyManifest>();
  const queue = (rootManifest.smrtDependencies || []).map((dependency) => ({
    dependency,
    issuerResolverPath: resolve(projectRoot, 'package.json'),
  }));

  while (queue.length > 0) {
    const next = queue.shift();
    if (!next || !next.dependency || loaded.has(next.dependency)) {
      continue;
    }

    const loadedDependency = await loadDependencyManifest(
      next.dependency,
      next.issuerResolverPath,
    );

    if (!loadedDependency) {
      addFinding(
        findings,
        'error',
        'missing-dependency-manifest',
        `Declared SMRT dependency "${next.dependency}" does not expose a runtime manifest.`,
      );
      continue;
    }

    loaded.set(next.dependency, loadedDependency);
    for (const nestedDependency of loadedDependency.manifest.smrtDependencies ||
      []) {
      if (!loaded.has(nestedDependency)) {
        queue.push({
          dependency: nestedDependency,
          issuerResolverPath: loadedDependency.resolverPath,
        });
      }
    }
  }

  return Array.from(loaded.values(), (entry) => entry.manifest);
}

function registerDependencyManifests(
  dependencyManifests: SmartObjectManifest[],
): void {
  for (const manifest of dependencyManifests) {
    for (const [name, objectDef] of Object.entries(manifest.objects || {})) {
      ObjectRegistry.registerFromManifest(
        name,
        objectDef,
        manifest.packageName,
      );
    }
  }
}

function resolvePackageJsonPath(
  packageName: string,
  issuerResolverPath: string,
): string | null {
  const requireFromIssuer = createRequire(issuerResolverPath);
  const resolutionCandidates = [
    packageName,
    `${packageName}/manifest`,
    `${packageName}/manifest.json`,
  ];

  for (const candidate of resolutionCandidates) {
    try {
      const resolvedPath = requireFromIssuer.resolve(candidate);
      const packageJsonPath = findPackageJsonForResolvedEntry(
        resolvedPath,
        packageName,
      );

      if (packageJsonPath) {
        return packageJsonPath;
      }
    } catch {
      // Keep trying the next candidate.
    }
  }

  return null;
}

function findPackageJsonForResolvedEntry(
  resolvedPath: string,
  packageName: string,
): string | null {
  let currentDir = dirname(resolvedPath);

  for (let index = 0; index < MAX_PACKAGE_JSON_ASCENTS; index += 1) {
    const packageJsonPath = join(currentDir, 'package.json');
    if (existsSync(packageJsonPath)) {
      try {
        const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
        if (packageJson?.name === packageName) {
          return packageJsonPath;
        }
      } catch {
        // Keep walking upward.
      }
    }

    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      break;
    }
    currentDir = parentDir;
  }

  return null;
}

async function tryLoadManifestFile(
  manifestPath: string,
): Promise<SmartObjectManifest | null> {
  try {
    const manifest = (await loadManifestFile(
      manifestPath,
    )) as SmartObjectManifest;
    return manifest?.objects && typeof manifest.objects === 'object'
      ? manifest
      : null;
  } catch {
    return null;
  }
}

function resolveExportedManifestPath(
  packageDir: string,
  manifestExport: unknown,
): string | null {
  const exportRecord =
    manifestExport &&
    typeof manifestExport === 'object' &&
    !Array.isArray(manifestExport)
      ? (manifestExport as Record<string, unknown>)
      : null;
  const manifestRelPath =
    typeof manifestExport === 'string'
      ? manifestExport
      : exportRecord?.default || exportRecord?.import;

  if (
    typeof manifestRelPath !== 'string' ||
    !manifestRelPath.startsWith('./') ||
    !manifestRelPath.endsWith('.json')
  ) {
    return null;
  }

  const manifestPath = resolve(packageDir, manifestRelPath);
  const packageRelativePath = relative(packageDir, manifestPath);

  if (
    packageRelativePath === '' ||
    packageRelativePath.startsWith('..') ||
    isAbsolute(packageRelativePath)
  ) {
    return null;
  }

  return manifestPath;
}

async function loadDependencyManifest(
  packageName: string,
  issuerResolverPath: string,
): Promise<LoadedDependencyManifest | null> {
  const packageJsonPath = resolvePackageJsonPath(
    packageName,
    issuerResolverPath,
  );

  if (!packageJsonPath) {
    const fallbackManifest = loadExternalManifestSync(packageName, {
      warn: false,
    });
    if (!fallbackManifest) {
      return null;
    }

    return {
      manifest: fallbackManifest,
      resolverPath: issuerResolverPath,
    };
  }

  const packageDir = dirname(packageJsonPath);
  const manifestCandidates = [
    join(packageDir, 'dist', 'manifest.json'),
    join(packageDir, '.smrt', 'manifest.json'),
    join(packageDir, 'manifest.json'),
  ];

  for (const manifestPath of manifestCandidates) {
    if (!existsSync(manifestPath)) {
      continue;
    }

    const manifest = await tryLoadManifestFile(manifestPath);
    if (manifest) {
      return {
        manifest,
        resolverPath: packageJsonPath,
      };
    }
  }

  try {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
    const manifestExport =
      packageJson?.exports?.['./manifest.json'] ||
      packageJson?.exports?.['./manifest'];
    const manifestPath = resolveExportedManifestPath(
      packageDir,
      manifestExport,
    );

    if (!manifestPath) {
      return null;
    }

    const manifest = await tryLoadManifestFile(manifestPath);

    if (manifest) {
      return {
        manifest,
        resolverPath: packageJsonPath,
      };
    }
  } catch {
    // Fall through to missing-manifest handling.
  }

  return null;
}

function checkManifestIdentity(
  findings: RuntimeCheckFinding[],
  entry: ManifestEntryRef,
): void {
  const className = getEntryClassName(entry.key, entry.definition);
  const manifestPackageName = entry.manifestPackageName;
  const qualifiedName = getEntryQualifiedName(
    entry.key,
    entry.definition,
    manifestPackageName,
  );

  if (!manifestPackageName) {
    addFinding(
      findings,
      'warning',
      'missing-manifest-package-name',
      `Class "${className}" is missing package identity in its manifest.`,
    );
    return;
  }

  const canonicalQualifiedName = createQualifiedName(
    manifestPackageName,
    className,
  );

  if (qualifiedName !== canonicalQualifiedName) {
    addFinding(
      findings,
      'error',
      'qualified-name-mismatch',
      `Class "${className}" resolves to "${qualifiedName}" but its canonical qualified name should be "${canonicalQualifiedName}".`,
    );
  }

  if (isQualifiedName(entry.key)) {
    const parsedKey = parseQualifiedName(entry.key);
    if (
      parsedKey.packageName !== manifestPackageName ||
      parsedKey.className !== className
    ) {
      addFinding(
        findings,
        'error',
        'manifest-key-mismatch',
        `Manifest key "${entry.key}" does not match ${manifestPackageName}:${className}.`,
      );
    }
  }
}

async function checkRuntimeHydration(
  projectManifest: SmartObjectManifest,
  dependencyManifests: SmartObjectManifest[],
  findings: RuntimeCheckFinding[],
): Promise<void> {
  const allManifests = [projectManifest, ...dependencyManifests];

  for (const entry of flattenManifestEntries(projectManifest, 'project')) {
    const className = getEntryClassName(entry.key, entry.definition);
    const qualifiedName = getEntryQualifiedName(
      entry.key,
      entry.definition,
      projectManifest.packageName,
    );
    let parentEntry: ManifestEntryRef | undefined;

    if (entry.definition.extends) {
      const parentLookup = resolveEntryByName(
        allManifests,
        entry.definition.extends,
      );

      if (parentLookup.kind === 'ambiguous') {
        addFinding(
          findings,
          'error',
          'ambiguous-extends-reference',
          `Runtime hydration for "${qualifiedName}" cannot resolve "${entry.definition.extends}" because it matches multiple manifest classes: ${parentLookup.matches.map(describeEntry).sort().join(', ')}.`,
        );
        continue;
      }

      if (parentLookup.kind === 'resolved') {
        parentEntry = parentLookup.entry;
      }
    }

    const expectedOwnFields = getOwnFieldNames(entry.definition);
    let resolvedFields: Map<string, any>;

    try {
      resolvedFields = await ObjectRegistry.getAllFields(qualifiedName);
    } catch (error) {
      addFinding(
        findings,
        'error',
        'runtime-registry-collision',
        `Runtime hydration for "${qualifiedName}" failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }

    const resolvedFieldNames = new Set(resolvedFields.keys());
    const missingOwnFields = expectedOwnFields.filter(
      (field) => !resolvedFieldNames.has(field),
    );

    if (missingOwnFields.length > 0) {
      addFinding(
        findings,
        'error',
        'runtime-field-hydration',
        `Runtime hydration for "${qualifiedName}" is missing own fields: ${missingOwnFields.join(', ')}.`,
      );
    }

    if (parentEntry) {
      const expectedInherited = getOwnFieldNames(parentEntry.definition);
      const missingInherited = expectedInherited.filter(
        (field) => !resolvedFieldNames.has(field),
      );

      if (missingInherited.length > 0) {
        addFinding(
          findings,
          'error',
          'runtime-inheritance-hydration',
          `Runtime hydration for "${qualifiedName}" is missing inherited fields from "${entry.definition.extends}": ${missingInherited.join(', ')}.`,
        );
      }
    }
  }
}

function checkShadowing(
  projectManifest: SmartObjectManifest,
  dependencyManifests: SmartObjectManifest[],
  findings: RuntimeCheckFinding[],
): void {
  for (const candidate of collectShadowCandidates(
    projectManifest,
    dependencyManifests,
  )) {
    const localNonSystemFields = getNonSystemFieldNames(
      candidate.localEntry.definition,
    );
    const externalFieldCounts = candidate.externalEntries.map(
      (entry) => getNonSystemFieldNames(entry.definition).length,
    );
    const maxExternalFieldCount = Math.max(...externalFieldCounts);
    const externalPackages = Array.from(
      new Set(
        candidate.externalEntries
          .map((entry) => entry.manifestPackageName)
          .filter((value): value is string => Boolean(value)),
      ),
    ).sort();

    if (
      localNonSystemFields.length <= 1 &&
      maxExternalFieldCount >= Math.max(3, localNonSystemFields.length + 2)
    ) {
      addFinding(
        findings,
        'error',
        'shadow-class',
        `Local manifest class "${candidate.className}" appears to shadow richer external runtime classes from ${externalPackages.join(', ')}.`,
      );
      continue;
    }

    addFinding(
      findings,
      'warning',
      'duplicate-short-name',
      `Class "${candidate.className}" exists in both the project manifest and external packages (${externalPackages.join(', ')}). Prefer qualified lookups and verify runtime registration order.`,
    );
  }
}

function getConsumerObjectDependencies(
  dependencyManifests: SmartObjectManifest[],
): string[] {
  return Array.from(
    new Set(
      dependencyManifests
        .filter(
          (manifest) => manifest.packageName !== '@happyvertical/smrt-core',
        )
        .filter((manifest) => Object.keys(manifest.objects || {}).length > 0)
        .map((manifest) => manifest.packageName)
        .filter((dependency): dependency is string => Boolean(dependency)),
    ),
  ).sort();
}

function checkConsumerRegistration(
  projectManifest: SmartObjectManifest,
  dependencyManifests: SmartObjectManifest[],
  projectRoot: string,
  findings: RuntimeCheckFinding[],
): void {
  const dependencies = getConsumerObjectDependencies(dependencyManifests);
  if (dependencies.length === 0) {
    return;
  }

  const registerPath = join(projectRoot, '.smrt', 'register.js');
  if (existsSync(registerPath)) {
    return;
  }

  addFinding(
    findings,
    'error',
    'missing-consumer-register',
    `Project "${projectManifest.packageName || projectRoot}" declares external SMRT dependencies (${formatDependencyList(dependencies)}) but is missing ".smrt/register.js". Consumer apps must generate runtime registrations via smrtConsumer() or "smrt generate-register" before running runtime checks.`,
  );
}

export async function runRuntimeCheck(
  projectRoot: string = process.cwd(),
): Promise<RuntimeCheckResult> {
  const findings: RuntimeCheckFinding[] = [];
  const discovered = await discoverManifests(projectRoot);
  const projectManifestInfo = findProjectManifest(discovered);

  if (!projectManifestInfo) {
    addFinding(
      findings,
      'error',
      'missing-project-manifest',
      'No project SMRT manifest was discovered. Run your build/dev pipeline so the runtime manifest exists before checking runtime hydration.',
    );

    return {
      projectRoot,
      discoveredManifestCount: discovered.length,
      findings,
    };
  }

  const projectManifest = (await loadManifestFile(
    projectManifestInfo.path,
  )) as SmartObjectManifest;
  const dependencyManifests = await loadDependencyManifests(
    projectManifest,
    projectRoot,
    findings,
  );
  checkConsumerRegistration(
    projectManifest,
    dependencyManifests,
    projectRoot,
    findings,
  );

  const allEntries = [
    ...flattenManifestEntries(
      projectManifest,
      'project',
      projectManifest.packageName,
    ),
    ...dependencyManifests.flatMap((manifest) =>
      flattenManifestEntries(manifest, 'dependency', manifest.packageName),
    ),
  ];

  for (const entry of allEntries) {
    checkManifestIdentity(findings, entry);
  }

  ObjectRegistry.clear();
  try {
    await autoDiscoverAndLoad(projectRoot);
  } catch (error) {
    addFinding(
      findings,
      'error',
      'runtime-discovery-error',
      `Runtime discovery failed before hydration checks could run: ${error instanceof Error ? error.message : String(error)}`,
    );

    return {
      projectRoot,
      projectManifestPath: projectManifestInfo.path,
      projectPackageName: projectManifest.packageName,
      discoveredManifestCount: discovered.length,
      findings,
    };
  }
  registerDependencyManifests(dependencyManifests);
  await checkRuntimeHydration(projectManifest, dependencyManifests, findings);
  checkShadowing(projectManifest, dependencyManifests, findings);

  if (!findings.some((finding) => finding.severity === 'error')) {
    addFinding(
      findings,
      'pass',
      'runtime-check-passed',
      `Validated runtime registration across ${discovered.length} discovered manifest(s).`,
    );
  }

  return {
    projectRoot,
    projectManifestPath: projectManifestInfo.path,
    projectPackageName: projectManifest.packageName,
    discoveredManifestCount: discovered.length,
    findings,
  };
}

export function formatRuntimeCheckReport(
  result: RuntimeCheckResult,
  options: { heading?: boolean } = {},
): string {
  const lines: string[] = [];
  const errors = result.findings.filter(
    (finding) => finding.severity === 'error',
  );
  const warnings = result.findings.filter(
    (finding) => finding.severity === 'warning',
  );
  const passes = result.findings.filter(
    (finding) => finding.severity === 'pass',
  );

  if (options.heading ?? true) {
    lines.push('🧪 SMRT Runtime Check');
    lines.push('');
  }

  if (result.projectManifestPath) {
    lines.push(`Project manifest: ${result.projectManifestPath}`);
  }
  if (result.projectPackageName) {
    lines.push(`Project package: ${result.projectPackageName}`);
  }
  lines.push(`Discovered manifests: ${result.discoveredManifestCount}`);
  lines.push('');

  for (const finding of errors) {
    lines.push(`❌ ${finding.message}`);
  }
  for (const finding of warnings) {
    lines.push(`⚠️  ${finding.message}`);
  }
  for (const finding of passes) {
    lines.push(`✅ ${finding.message}`);
  }

  if (lines[lines.length - 1] !== '') {
    lines.push('');
  }

  lines.push(
    `Summary: ${passes.length} passed, ${warnings.length} warning(s), ${errors.length} error(s)`,
  );

  return lines.join('\n');
}
