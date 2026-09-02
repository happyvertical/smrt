import type { CapabilityClassification } from './capability.js';

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

/**
 * A declared view intent (#2588) as emitted into the knowledge artifact (#2591).
 *
 * `id` is the entry's identity everywhere: in this artifact, in a playbook step
 * (`{ kind: 'intent', id }`), and in `smrt doctor`'s surface report. It is
 * declared, never derived from a namespace, a generated tool name, or a route,
 * so it survives every rename those could undergo.
 */
export interface DomainKnowledgeViewIntent {
  id: string;
  description: string;
  /** Resolved through the #2587 fail-closed rule at declaration time. */
  capability: CapabilityClassification;
  /** The browser registry this intent compiles into, and what it addresses. */
  target: Record<string, unknown>;
  hasInputSchema: boolean;
  /** An intent moves mounted browser state, so it is browser-valid only. */
  planes: Array<'browser' | 'server'>;
  /** Declaring module, relative to the package root, in POSIX form. */
  sourceFile: string;
}

/** One step of an emitted playbook. Steps never nest another playbook. */
export type DomainKnowledgePlaybookStep =
  | { kind: 'operation'; model: string; action: string }
  | { kind: 'intent'; id: string };

/** A registered playbook (#2589) as emitted into the knowledge artifact (#2591). */
export interface DomainKnowledgePlaybook {
  key: string;
  title: string;
  description: string;
  steps: DomainKnowledgePlaybookStep[];
  planes: Array<'browser' | 'server'>;
  /** False when `planes` was derived from the step kinds rather than declared. */
  planesDeclared: boolean;
  onStepFailure: 'abort' | 'continue';
  enabled: boolean;
  /** Declaring module, relative to the package root, in POSIX form. */
  sourceFile: string;
}

/**
 * A declaration the scanner recognized but could not emit.
 *
 * Recorded rather than dropped: the whole point of emitting the agent surface
 * is that "what can an agent do here" has one answer, and an invisible
 * declaration would quietly make that answer wrong. Every message names
 * `useWebMcpTool`, the escape hatch for a genuinely computed tool set.
 */
export interface DomainKnowledgeAgentSurfaceDiagnostic {
  code: string;
  helper: 'defineIntent' | 'definePlaybook';
  message: string;
  /** Declaring module, relative to the package root, in POSIX form. */
  sourceFile: string;
  line?: number;
  column?: number;
}

/**
 * The package's declared agent-addressable surface beyond its generated model
 * tools (#2591).
 *
 * Omitted entirely when a package declares no intents, playbooks, or
 * diagnostics, so an artifact for a package with none stays byte-identical to
 * what it emitted before this field existed.
 */
export interface DomainKnowledgeAgentSurface {
  intents: DomainKnowledgeViewIntent[];
  playbooks: DomainKnowledgePlaybook[];
  diagnostics: DomainKnowledgeAgentSurfaceDiagnostic[];
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
  /**
   * Declared view intents and playbooks (#2591). Omitted when the package
   * declares none, so this field is additive to schema version 1.
   *
   * This is deliberately a knowledge-artifact field and not a runtime-manifest
   * field: `manifest.json` stays runtime-focused, and the agent-addressable
   * surface is an agent/developer contract.
   */
  agentSurface?: DomainKnowledgeAgentSurface;
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
