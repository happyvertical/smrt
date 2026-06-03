export type DomainKnowledgeSurfaceKind = 'api' | 'cli' | 'mcp' | 'ai';

export interface DomainKnowledgeSurface {
  kind: DomainKnowledgeSurfaceKind;
  name: string;
  operation: string;
  path?: string;
  method?: string;
  description?: string;
  objectName?: string;
}

export interface DomainKnowledgeConfig {
  enabled?: boolean;
  api?: {
    enabled?: boolean;
    basePath?: string;
    includeDocs?: boolean;
    includePrompts?: boolean;
    requireAdmin?: boolean;
  };
  cli?: boolean;
  mcp?: boolean;
  includeDocs?: boolean;
  includePrompts?: boolean;
  tags?: string[];
  summary?: string;
  risks?: string[];
}

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
