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

/** One object's entry in the domain-knowledge manifest (fields, relationships, surfaces). */
export interface DomainKnowledgeObject {
  name: string;
  qualifiedName?: string;
  collection: string;
  tableName?: string;
  packageName?: string;
  extends?: string;
  visibility?: string;
  fields: Array<{
    name: string;
    type: string;
    required?: boolean;
    related?: string;
    columnType?: string;
  }>;
  relationships: Array<{
    name: string;
    type: string;
    required?: boolean;
    related?: string;
    columnType?: string;
  }>;
  methods: string[];
  surfaces: DomainKnowledgeSurface[];
  relationshipFeatures: string[];
  tags: string[];
  summary?: string;
  risks: string[];
}

/** The package-level domain-knowledge artifact (`smrt-knowledge.json`) — the agent/developer contract. */
export interface DomainKnowledgeManifest {
  schemaVersion: 1;
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
