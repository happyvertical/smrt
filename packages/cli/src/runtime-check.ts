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

const SYSTEM_FIELDS = new Set([
  'context',
  'created_at',
  'id',
  'slug',
  'tenantId',
  'tenant_id',
  'updated_at',
]);

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

function findEntryByName(
  manifests: SmartObjectManifest[],
  name: string,
): ManifestEntryRef | undefined {
  for (const manifest of manifests) {
    for (const [key, objectDef] of Object.entries(manifest.objects || {})) {
      const definition = objectDef as SmartObjectDefinition;
      const className = getEntryClassName(key, definition);
      const qualifiedName = getEntryQualifiedName(
        key,
        definition,
        manifest.packageName,
      );

      if (
        name === className ||
        name === qualifiedName ||
        (isQualifiedName(name) &&
          qualifiedName.toLowerCase() === name.toLowerCase()) ||
        className.toLowerCase() === name.toLowerCase()
      ) {
        return {
          manifestPackageName: manifest.packageName,
          manifestSource: manifest === manifests[0] ? 'project' : 'dependency',
          key,
          definition,
        };
      }
    }
  }

  return undefined;
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
  findings: RuntimeCheckFinding[],
): Promise<SmartObjectManifest[]> {
  const loaded = new Map<string, SmartObjectManifest>();
  const queue = [...(rootManifest.smrtDependencies || [])];

  while (queue.length > 0) {
    const dependency = queue.shift();
    if (!dependency || loaded.has(dependency)) {
      continue;
    }

    const manifest = loadExternalManifestSync(dependency, { warn: false });
    if (!manifest) {
      addFinding(
        findings,
        'error',
        'missing-dependency-manifest',
        `Declared SMRT dependency "${dependency}" does not expose a runtime manifest.`,
      );
      continue;
    }

    loaded.set(dependency, manifest);
    for (const nestedDependency of manifest.smrtDependencies || []) {
      if (!loaded.has(nestedDependency)) {
        queue.push(nestedDependency);
      }
    }
  }

  return Array.from(loaded.values());
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

    if (entry.definition.extends) {
      const parentEntry = findEntryByName(
        allManifests,
        entry.definition.extends,
      );
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
  await autoDiscoverAndLoad(projectRoot);
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
