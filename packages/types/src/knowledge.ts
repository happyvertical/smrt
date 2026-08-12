/** Kind of generated surface a knowledge entry describes (REST/CLI/MCP/AI). */
export type DomainKnowledgeSurfaceKind = 'api' | 'cli' | 'mcp' | 'ai';

/** A single generated surface (one api/cli/mcp/ai operation) exposed by an object. */
export interface DomainKnowledgeSurface {
  kind: DomainKnowledgeSurfaceKind;
  name: string;
  operation: string;
  path?: string;
  method?: string;
  description?: string;
  objectName?: string;
}

/** Per-object configuration controlling domain-knowledge generation and exposure. */
export interface DomainKnowledgeConfig {
  enabled?: boolean;
  api?: {
    /**
     * Generate HTTP knowledge routes. Disabled by default; prefer CLI/MCP for
     * agent workflows unless this is a guarded dev/admin endpoint.
     */
    enabled?: boolean;
    basePath?: string;
    includeDocs?: boolean;
    includePrompts?: boolean;
    /**
     * Require dev mode or admin locals for HTTP knowledge access. Setting this
     * to false makes the route public and should only be used when sanitized
     * anonymous schema/surface metadata is acceptable.
     */
    requireAdmin?: boolean;
  };
  includeDocs?: boolean;
  includePrompts?: boolean;
  tags?: string[];
  summary?: string;
  risks?: string[];
}

/** Validation constraints retained in the curated agent-facing field shape. */
export interface DomainKnowledgeFieldConstraints {
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
}

/** A field retained in the curated agent-facing object shape. */
export interface DomainKnowledgeField {
  name: string;
  type: string;
  required?: boolean;
  related?: string;
  columnType?: string;
  default?: unknown;
  constraints?: DomainKnowledgeFieldConstraints;
  readonly?: boolean;
  transient?: boolean;
}

/** Additive structured signature; `methods: string[]` remains the compatibility surface. */
export interface DomainKnowledgeMethodSignature {
  name: string;
  async?: boolean;
  static?: boolean;
  params?: string[];
  returns?: string;
}

/** Normalized tenancy facts from `@smrt({ tenantScoped })`. */
export interface DomainKnowledgeTenant {
  scoped: boolean;
  mode?: 'required' | 'optional';
  field?: string;
}

/** One object's entry in the domain-knowledge manifest (fields, relationships, surfaces). */
export interface DomainKnowledgeObject {
  name: string;
  qualifiedName?: string;
  collection: string;
  tableName?: string;
  packageName?: string;
  extends?: string;
  visibility?: string;
  fields: DomainKnowledgeField[];
  relationships: DomainKnowledgeField[];
  methods: string[];
  methodSignatures?: DomainKnowledgeMethodSignature[];
  tenant?: DomainKnowledgeTenant;
  tableStrategy?: 'cti' | 'sti';
  conflictColumns?: string[];
  surfaces: DomainKnowledgeSurface[];
  relationshipFeatures: string[];
  tags: string[];
  summary?: string;
  risks: string[];
}

/**
 * A sibling module doc linked from a package's `AGENTS.md` (#2108).
 *
 * Oversized package docs are split by module into `packages/<pkg>/agents/<module>.md`
 * rather than nested `AGENTS.md` files, because instruction chains are additive.
 * The link in `AGENTS.md` is the registration: the knowledge tooling resolves it
 * so the moved prose — which is curated and not regenerable from the manifest —
 * stays reachable from agent context.
 */
export interface DomainKnowledgeModuleDoc {
  /** Path relative to the package root, e.g. `agents/commissions.md`. */
  path: string;
  /** Module name derived from the file's basename, e.g. `commissions`. */
  module: string;
  content: string;
}

/** The package-level domain-knowledge artifact (`smrt-knowledge.json`) — the agent/developer contract. */
export interface DomainKnowledgeManifest {
  schemaVersion: 1;
  /** True when generation removed sensitive fields before projecting objects. */
  sensitiveFieldsExcluded?: true;
  generatedAt: string;
  packageName?: string;
  packageVersion?: string;
  sourceManifestPath?: string;
  agentDocPath?: string;
  sourceHashes: Record<string, string>;
  exports: string[];
  dependencies: Record<string, string>;
  smrtDependencies: string[];
  sdkDependencies: string[];
  tags: string[];
  summary?: string;
  risks: string[];
  objects: DomainKnowledgeObject[];
  surfaces: DomainKnowledgeSurface[];
  prompts: Array<{
    filePath: string;
    key?: string;
  }>;
  relationshipsV2: {
    foreignKeyFields: number;
    crossPackageRefFields: number;
    junctionCollections: number;
    hierarchicalObjects: number;
    polymorphicAssociations: number;
    uuidColumns: number;
  };
  agentDoc?: string;
  /** Sibling module docs linked from `AGENTS.md`; omitted when the package links none. */
  moduleDocs?: DomainKnowledgeModuleDoc[];
}

/** Result of a domain-knowledge freshness check (stale references, error/warning counts). */
export interface DomainKnowledgeFreshnessResult {
  ok: boolean;
  checkedAt: string;
  artifactPath?: string;
  issueCount: number;
  errorCount: number;
  warningCount: number;
  issues: Array<{
    severity: 'error' | 'warning';
    code: string;
    message: string;
    file?: string;
    packageName?: string;
  }>;
}
