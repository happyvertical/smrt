/**
 * Cross-package knowledge graph (#2863).
 *
 * Each package's own `smrt-knowledge.json` (see `knowledge.ts`) is a
 * per-package projection. Nothing merges them, so cross-package invariants
 * that the scanner manifest already carries — `@crossPackageRef` targets, STI
 * parent/child pairs, junction/hierarchical/polymorphic base usage, and
 * `_smrt_` system-table ownership — live only as prose in the root
 * `AGENTS.md`. This module builds the merged, deterministic root artifact
 * (`.smrt/smrt-knowledge-graph.json`) from whichever per-package artifacts
 * are present, and checks it for staleness the same way `knowledge.ts` checks
 * a package artifact: by comparing recorded `sourceHashes` against the
 * current file content.
 *
 * This module never invents an edge: every edge is a direct read of a field
 * already emitted into a package's `DomainKnowledgeManifest` (`related`,
 * `tableStrategy`, `extends`, `relationshipFeatures`, `tableName`).
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type {
  DomainKnowledgeManifest,
  DomainKnowledgeObject,
} from '@happyvertical/smrt-types';

/** One package's `smrt-knowledge.json`, located relative to the graph root. */
export interface KnowledgeGraphInput {
  /** Path to the artifact, relative to the repo root, POSIX-separated. */
  artifactPath: string;
  manifest: DomainKnowledgeManifest;
}

export interface KnowledgeGraphPackageNode {
  name: string;
  version?: string;
  artifactPath: string;
  tags: string[];
  risks: string[];
  summary?: string;
  objectCount: number;
}

export interface KnowledgeGraphObjectNode {
  /** `<packageName>#<qualifiedName-or-name>`, this graph's stable object id. */
  id: string;
  packageName: string;
  name: string;
  qualifiedName?: string;
  collection: string;
  tableName?: string;
  tableStrategy?: 'cti' | 'sti';
  extends?: string;
}

export type KnowledgeGraphEdgeType =
  | 'crossPackageRef'
  | 'sti'
  | 'junction'
  | 'hierarchical'
  | 'polymorphic'
  | 'systemTable';

export interface KnowledgeGraphEdge {
  type: KnowledgeGraphEdgeType;
  /** Object id (or `<packageName>#<extends>`-style unresolved target) this edge starts from. */
  from: string;
  /**
   * Object id the edge points to when resolvable against a scanned object;
   * otherwise the raw declared target (e.g. a qualified name this run did
   * not scan), so the edge is still readable rather than dropped.
   */
  to?: string;
  /** Declaring field name, for `crossPackageRef` edges. */
  field?: string;
}

export interface SmrtKnowledgeGraph {
  schemaVersion: 1;
  generatedAt: string;
  /** `artifactPath -> sha256(content)`, sorted by key; the freshness input. */
  sourceHashes: Record<string, string>;
  packages: KnowledgeGraphPackageNode[];
  objects: KnowledgeGraphObjectNode[];
  edges: KnowledgeGraphEdge[];
}

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function objectId(packageName: string, object: DomainKnowledgeObject): string {
  return `${packageName}#${object.qualifiedName ?? object.name}`;
}

/** Builds the merged graph. Deterministic: every array is sorted. */
export function buildKnowledgeGraph(
  inputs: KnowledgeGraphInput[],
): SmrtKnowledgeGraph {
  const sortedInputs = [...inputs].sort((a, b) =>
    a.artifactPath.localeCompare(b.artifactPath),
  );

  const sourceHashes: Record<string, string> = {};
  const packages: KnowledgeGraphPackageNode[] = [];
  const objects: KnowledgeGraphObjectNode[] = [];
  const edges: KnowledgeGraphEdge[] = [];

  // Qualified-name -> object id, so a crossPackageRef/STI target declared in
  // one package can be resolved to the node emitted by whichever package
  // scanned it, regardless of scan order.
  const idByQualifiedName = new Map<string, string>();
  const idBySimpleName = new Map<string, string[]>();

  for (const input of sortedInputs) {
    const packageName = input.manifest.packageName ?? input.artifactPath;
    for (const object of input.manifest.objects) {
      const id = objectId(packageName, object);
      idByQualifiedName.set(object.qualifiedName ?? id, id);
      const bySimple = idBySimpleName.get(object.name) ?? [];
      bySimple.push(id);
      idBySimpleName.set(object.name, bySimple);
    }
  }

  const resolveTarget = (raw: string | undefined): string | undefined => {
    if (!raw) return undefined;
    if (idByQualifiedName.has(raw)) return idByQualifiedName.get(raw);
    const bySimple = idBySimpleName.get(raw);
    if (bySimple && bySimple.length === 1) return bySimple[0];
    return undefined;
  };

  for (const input of sortedInputs) {
    sourceHashes[input.artifactPath] = hashContent(
      stableStringify(input.manifest),
    );
    const packageName = input.manifest.packageName ?? input.artifactPath;

    packages.push({
      name: packageName,
      version: input.manifest.packageVersion,
      artifactPath: input.artifactPath,
      tags: [...input.manifest.tags].sort(),
      risks: [...input.manifest.risks].sort(),
      summary: input.manifest.summary,
      objectCount: input.manifest.objects.length,
    });

    for (const object of input.manifest.objects) {
      const id = objectId(packageName, object);
      objects.push({
        id,
        packageName,
        name: object.name,
        qualifiedName: object.qualifiedName,
        collection: object.collection,
        tableName: object.tableName,
        tableStrategy: object.tableStrategy,
        extends: object.extends,
      });

      for (const field of object.relationships) {
        if (field.type !== 'crossPackageRef') continue;
        edges.push({
          type: 'crossPackageRef',
          from: id,
          to: resolveTarget(field.related) ?? field.related,
          field: field.name,
        });
      }

      if (object.tableStrategy === 'sti' && object.extends) {
        edges.push({
          type: 'sti',
          from: id,
          to:
            resolveTarget(object.extends) ?? `${packageName}#${object.extends}`,
        });
      }

      for (const feature of object.relationshipFeatures) {
        if (feature === 'SmrtJunction') {
          edges.push({ type: 'junction', from: id });
        } else if (feature === 'SmrtHierarchical') {
          edges.push({ type: 'hierarchical', from: id });
        } else if (feature === 'SmrtPolymorphicAssociation') {
          edges.push({ type: 'polymorphic', from: id });
        }
      }

      if (object.tableName?.startsWith('_smrt_')) {
        edges.push({ type: 'systemTable', from: id, to: object.tableName });
      }
    }
  }

  packages.sort((a, b) => a.name.localeCompare(b.name));
  objects.sort((a, b) => a.id.localeCompare(b.id));
  edges.sort((a, b) => {
    const key = (edge: KnowledgeGraphEdge) =>
      `${edge.type}|${edge.from}|${edge.to ?? ''}|${edge.field ?? ''}`;
    return key(a).localeCompare(key(b));
  });

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    sourceHashes: sortRecord(sourceHashes),
    packages,
    objects,
    edges,
  };
}

/** Deterministic `JSON.stringify` — object keys are sorted at every level. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortValue((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

function sortRecord(record: Record<string, string>): Record<string, string> {
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(record).sort()) sorted[key] = record[key];
  return sorted;
}

export interface KnowledgeGraphFreshnessIssue {
  severity: 'error';
  code:
    | 'missing-knowledge-graph'
    | 'stale-knowledge-graph'
    | 'knowledge-graph-source-missing';
  message: string;
  file?: string;
}

/**
 * Checks the merged graph's recorded `sourceHashes` against the current
 * content of each per-package artifact it was built from — the same pattern
 * `knowledge.ts`/`smrt-dev-mcp` use for a single package's `sourceHashes`.
 *
 * `graphPath` and each `artifactPath` in the graph are resolved relative to
 * `rootDir` (the repo root).
 */
export function checkKnowledgeGraphFreshness(
  rootDir: string,
  graphPath: string,
  options: { requireArtifact?: boolean } = {},
): KnowledgeGraphFreshnessIssue[] {
  const issues: KnowledgeGraphFreshnessIssue[] = [];
  const absoluteGraphPath = `${rootDir}/${graphPath}`;
  if (!existsSync(absoluteGraphPath)) {
    if (!options.requireArtifact) return issues;
    issues.push({
      severity: 'error',
      code: 'missing-knowledge-graph',
      message: `${graphPath} does not exist; run \`pnpm knowledge:graph\``,
      file: graphPath,
    });
    return issues;
  }

  let graph: SmrtKnowledgeGraph;
  try {
    graph = JSON.parse(readFileSync(absoluteGraphPath, 'utf8'));
  } catch (error) {
    issues.push({
      severity: 'error',
      code: 'stale-knowledge-graph',
      message: `${graphPath} is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
      file: graphPath,
    });
    return issues;
  }

  for (const [artifactPath, expectedHash] of Object.entries(
    graph.sourceHashes ?? {},
  )) {
    const absoluteArtifactPath = `${rootDir}/${artifactPath}`;
    if (!existsSync(absoluteArtifactPath)) {
      issues.push({
        severity: 'error',
        code: 'knowledge-graph-source-missing',
        message: `${artifactPath} used to build ${graphPath} no longer exists`,
        file: graphPath,
      });
      continue;
    }
    const manifest = JSON.parse(readFileSync(absoluteArtifactPath, 'utf8'));
    const actualHash = hashContent(stableStringify(manifest));
    if (actualHash !== expectedHash) {
      issues.push({
        severity: 'error',
        code: 'stale-knowledge-graph',
        message: `${artifactPath} changed since ${graphPath} was generated; run \`pnpm knowledge:graph\``,
        file: graphPath,
      });
    }
  }

  return issues;
}
