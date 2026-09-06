/**
 * Type definitions for OXC-based SMRT scanner
 *
 * This module defines:
 * 1. Raw types - Intermediate representation from OXC parsing (Phase 1)
 * 2. Resolved types - After inheritance resolution (Phase 2)
 * 3. Re-exports of smrt-core types for compatibility
 */

// ============================================================================
// Phase 1: Raw Types (Direct OXC output)
// ============================================================================

/**
 * Raw class definition extracted from OXC AST
 * Contains only syntactic information, no semantic resolution
 */
export interface RawClassDefinition {
  /** Class name as declared in source */
  className: string;

  /** Absolute path to source file */
  filePath: string;

  /** Parent class name from extends clause (null if none) */
  extendsClause: string | null;

  /** Generic type argument from extends (e.g., "Meeting" from SmrtCollection<Meeting>) */
  extendsTypeArg: string | null;

  /** Parsed @smrt() decorator configuration object */
  decoratorConfig: RawDecoratorConfig | null;

  /** Has @smrt() decorator */
  hasSmartDecorator: boolean;

  /** Class properties/fields */
  fields: RawFieldDefinition[];

  /** Class methods */
  methods: RawMethodDefinition[];

  /** Start line in source file */
  startLine: number;

  /** End line in source file */
  endLine: number;
}

/**
 * Raw @smrt() decorator configuration
 */
export interface RawDecoratorConfig {
  /** Table strategy: 'sti' | 'cti' */
  tableStrategy?: 'sti' | 'cti';

  /** Storage type for the generated id primary key */
  idType?: 'uuid' | 'text';

  /** Code-owned feature toggle declarations */
  features?: Record<
    string,
    {
      defaultEnabled: boolean;
      label?: string;
      description?: string;
      metadata?: Record<string, unknown>;
    }
  >;

  /** API configuration */
  api?: {
    include?: string[];
    exclude?: string[];
  };

  /** CLI configuration */
  cli?:
    | boolean
    | {
        include?: string[];
        exclude?: string[];
        skipApiCheck?: boolean;
        http?: boolean;
      };

  /** MCP configuration */
  mcp?: {
    include?: string[];
    exclude?: string[];
  };

  /** Raw config object for unknown properties */
  [key: string]: unknown;
}

/**
 * Raw field definition from OXC AST
 */
export interface RawFieldDefinition {
  /** Field name */
  name: string;

  /** TypeScript type annotation as string (e.g., "string", "number", "Date") */
  typeAnnotation: string | null;

  /** Raw initializer expression as string */
  initializer: string | null;

  /** For numeric literals: whether it contains a decimal point */
  hasDecimalPoint: boolean;

  /** For numeric literals: the actual numeric value */
  numericValue: number | null;

  /** Decorators applied to this field */
  decorators: RawDecorator[];

  /** Whether field is optional (has ?) */
  optional: boolean;

  /** Whether field is static */
  isStatic: boolean;

  /** Whether field is readonly */
  readonly: boolean;

  /** Whether field is private/protected */
  accessibility: 'public' | 'private' | 'protected';

  /** Start line in source */
  line: number;
}

/**
 * Raw decorator information
 */
export interface RawDecorator {
  /** Decorator name (e.g., "field", "foreignKey") */
  name: string;

  /** Raw arguments as strings */
  arguments: string[];
}

/**
 * Raw method definition from OXC AST
 */
export interface RawMethodDefinition {
  /** Method name */
  name: string;

  /** Whether method is async */
  async: boolean;

  /** Whether method is static */
  isStatic: boolean;

  /** Accessibility modifier */
  accessibility: 'public' | 'private' | 'protected';

  /** Method parameters */
  parameters: RawParameterDefinition[];

  /** Return type annotation as string */
  returnType: string | null;

  /** JSDoc description if present */
  description: string | null;

  /**
   * Config object of an `@method()` decorator on this method, when one is
   * present. `{}` for a bare `@method()`; `undefined` when the method carries
   * no `@method()` decorator at all — the two are distinct, because an
   * explicit bare decorator still marks the method as deliberately reviewed.
   *
   * Values are extracted with the same literal-only rules the class-level
   * `@smrt()` config uses, so an expression the scanner cannot resolve becomes
   * a scan error rather than a silently dropped `expose: false`.
   */
  decoratorConfig?: Record<string, unknown>;

  /** Start line in source */
  line: number;
}

/**
 * Raw parameter definition
 */
export interface RawParameterDefinition {
  /** Parameter name */
  name: string;

  /** Type annotation as string */
  type: string | null;

  /** Whether parameter is optional */
  optional: boolean;

  /** Default value as string */
  defaultValue: string | null;

  /**
   * True when the parameter carries a type annotation the scanner could not
   * express as a string — an intersection, tuple, conditional, mapped,
   * `typeof`, or indexed-access type — or when an inline object literal
   * contains such a member.
   *
   * This is the provenance that separates "the author wrote `any`" from "the
   * scanner gave up": both previously reached the manifest as the string
   * `'any'`. Consumers that must fail closed on an uncertain type (the API
   * wire-ability gate) read this rather than trusting `type`.
   *
   * `type: null` with `typeUnresolved` absent means the parameter simply has
   * no annotation, which is an implicit — and genuinely authored — `any`.
   */
  typeUnresolved?: boolean;

  /**
   * Resolved member types of an INLINE object-literal annotation
   * (`{ onDone: () => void; target: Content }` → `['Function', 'Content']`),
   * flattened across nested literals, arrays, and unions.
   *
   * `extractTypeName` collapses every inline literal to the single string
   * `'object'`, which erases exactly the members a caller needs to judge
   * whether the bag can cross a wire. NAMED bags (an interface, type alias,
   * `Partial<>`/`Pick<>`) are deliberately NOT expanded — resolving them needs
   * cross-file type resolution this AST layer does not do, and they are
   * accepted heuristically by the consumers that care.
   */
  memberTypes?: string[];
  /**
   * For a top-level UNION, each branch with the inline members IT declared.
   *
   * `memberTypes` above flattens across branches, which lets one branch veto
   * another: `{ callback: () => void } | string` is wire-able through its
   * string branch, but the flattened `Function` rejected the whole parameter.
   * A consumer that understands this field MUST prefer it over `memberTypes`
   * for unions. Absent on a non-union parameter and on manifests generated
   * before #2686.
   */
  unionBranches?: ParameterTypeBranch[];
}

/** One branch of a top-level union parameter type (#2686). */
export interface ParameterTypeBranch {
  /** The branch's own type name, e.g. `string` or `object`. */
  type: string;
  /** Inline object members declared by THIS branch only. */
  memberTypes?: string[];
}

// ============================================================================
// Phase 2: Resolved Types (After inheritance resolution)
// ============================================================================

/**
 * Resolved class definition with inheritance chain
 */
export interface ResolvedClassDefinition extends RawClassDefinition {
  /** Full inheritance chain from base to this class */
  inheritanceChain: string[];

  /** STI base class name (if part of STI hierarchy) */
  stiBase: string | null;

  /** Effective table strategy (inherited or declared) */
  effectiveTableStrategy: 'sti' | 'cti';

  /** Whether this class uses STI (convenience boolean) */
  isSTI: boolean;

  /** Whether this class is a framework base class */
  isFrameworkBase: boolean;

  /** All fields including inherited (for STI) */
  allFields: RawFieldDefinition[];

  /** Package this class belongs to (if external) */
  packageName: string | null;
}

// ============================================================================
// Agent surface (#2591)
// ============================================================================

/** The two module-scope helpers the agent-surface matcher recognizes. */
export type AgentSurfaceHelper = 'defineIntent' | 'definePlaybook';

/**
 * Effect classification, mirroring `CapabilityEffect` in
 * `@happyvertical/smrt-types`. Mirrored rather than imported because this
 * package carries no `@happyvertical/*` dependency — core depends on it, and
 * importing back would close the cycle.
 */
export type AgentSurfaceEffect = 'read' | 'write' | 'destructive';

/** A fully resolved classification (#2587's fail-closed rule already applied). */
export interface AgentSurfaceCapability {
  effect: AgentSurfaceEffect;
  idempotent: boolean;
  openWorld: boolean;
}

/** Plane a declaration is valid on. */
export type AgentSurfacePlane = 'browser' | 'server';

/** One emitted view intent (#2588). */
export interface AgentSurfaceIntent {
  kind: 'intent';
  /** Declared, dot-namespaced identity. This is the entry's stable identity. */
  id: string;
  description: string;
  capability: AgentSurfaceCapability;
  target: Record<string, unknown>;
  /** Whether the declaration carried an `inputSchema` object. */
  hasInputSchema: boolean;
  /**
   * Always exactly `['browser']`. An intent moves mounted browser state; a
   * server-side agent reaches one only through the #2446 command/ack bridge,
   * which the referencing PLAYBOOK declares. Typed as the literal tuple rather
   * than the open plane list so the contract cannot be read as wider than it is.
   */
  planes: ['browser'];
  /** Declaring module, relativized by the emitting caller. */
  filePath: string;
}

/** One step of an emitted playbook (#2589). Playbooks cannot nest. */
export type AgentSurfacePlaybookStep =
  | { kind: 'operation'; model: string; action: string }
  | { kind: 'intent'; id: string };

/** One emitted playbook (#2589). */
export interface AgentSurfacePlaybook {
  kind: 'playbook';
  /** Declared registry key. This is the entry's stable identity. */
  key: string;
  title: string;
  description: string;
  steps: AgentSurfacePlaybookStep[];
  planes: AgentSurfacePlane[];
  /** False when `planes` was derived from the step kinds rather than declared. */
  planesDeclared: boolean;
  onStepFailure: 'abort' | 'continue';
  enabled: boolean;
  /** Declaring module, relativized by the emitting caller. */
  filePath: string;
}

/** Why a recognized declaration could not be emitted. */
export type AgentSurfaceDiagnosticCode =
  | 'non-literal-argument'
  | 'not-module-scope'
  | 'argument-count'
  | 'incomplete-declaration'
  | 'invalid-identity'
  | 'svelte-declaration'
  | 'duplicate-identity'
  | 'tool-name-collision';

/**
 * Something a reader of the emitted surface has to know about a declaration.
 *
 * Two kinds, and the difference is whether the entry survived. Every code but
 * `tool-name-collision` reports a declaration that is NOT emitted — never a
 * silent omission, so each of those messages names `useWebMcpTool`, the escape
 * hatch for a genuinely computed tool set. A `tool-name-collision` is
 * advisory: the declaration IS emitted, and the diagnostic records that its
 * derived WebMCP tool name is already spoken for by something outside the
 * declared surface.
 */
export interface AgentSurfaceDiagnostic {
  code: AgentSurfaceDiagnosticCode;
  helper: AgentSurfaceHelper;
  message: string;
  filePath: string;
  line?: number;
  column?: number;
}

/** The declared agent-addressable surface found by one scan. */
export interface AgentSurface {
  intents: AgentSurfaceIntent[];
  playbooks: AgentSurfacePlaybook[];
  diagnostics: AgentSurfaceDiagnostic[];
}

// ============================================================================
// Scan Results
// ============================================================================

/**
 * Result from scanning a single file
 */
export interface FileScanResult {
  /** Source file path */
  filePath: string;

  /** Classes found in file */
  classes: RawClassDefinition[];

  /** Scan errors */
  errors: ScanError[];

  /** Parse time in milliseconds */
  parseTimeMs: number;

  /** Type alias declarations found in file (name → resolved type string) */
  typeAliases: Record<string, string>;

  /** SMRT package imports found in file (package name → Set of imported class names) */
  smrtImports?: Map<string, Set<string>>;

  /**
   * Declared view intents and playbooks found in the file, plus a diagnostic
   * for every recognized declaration that is not statically emittable (#2591).
   * Omitted when the file declares none.
   */
  agentSurface?: AgentSurface;
}

/**
 * Scan error
 */
export interface ScanError {
  /** Error message */
  message: string;

  /** Source file */
  filePath: string;

  /** Line number (1-based) */
  line?: number;

  /** Column number (1-based) */
  column?: number;

  /** Error severity */
  severity: 'error' | 'warning';
}

/**
 * Result from scanning multiple files
 */
export interface ScanResults {
  /** All scanned files */
  files: FileScanResult[];

  /** All classes found (flattened) */
  classes: RawClassDefinition[];

  /** All errors (flattened) */
  errors: ScanError[];

  /** Total parse time in milliseconds */
  totalParseTimeMs: number;

  /** Number of files scanned */
  fileCount: number;

  /** Accumulated type aliases across all files */
  typeAliases: Record<string, string>;

  /** Accumulated SMRT package imports across all files (package name → Set of imported class names) */
  smrtImports?: Map<string, Set<string>>;

  /**
   * The project's declared agent-addressable surface, merged across files with
   * deterministic identity so emission never depends on file order (#2591).
   */
  agentSurface: AgentSurface;
}

// ============================================================================
// Scanner Options
// ============================================================================

/**
 * Configuration options for {@link OxcScanner}.
 *
 * All fields are optional; reasonable defaults are applied when omitted.
 *
 * @see {@link OxcScanner}
 */
export interface OxcScannerOptions {
  /** Glob patterns to include */
  include?: string[];

  /** Glob patterns to exclude */
  exclude?: string[];

  /** Base directory for scanning */
  cwd?: string;

  /** Path to tsconfig.json for module resolution */
  tsconfig?: string;

  /** Whether to follow imports to find base classes */
  followImports?: boolean;

  /** Known base classes (avoid resolution) */
  baseClasses?: string[];

  /** Include private methods in output */
  includePrivateMethods?: boolean;

  /** Include static methods in output */
  includeStaticMethods?: boolean;

  /** External package manifests for base class resolution */
  externalManifests?: Map<string, ExternalManifest>;

  /**
   * Follow symbolic links while discovering files. Defaults to `false`.
   *
   * A package's own sources are real files, while a pnpm `node_modules` is a
   * symlink graph with cycles: every store entry links back out to its
   * siblings, so a link-following walk reaches the same real directory once per
   * path that leads to it and never terminates in practice. Discovery therefore
   * stays on real directories unless a caller explicitly opts back in.
   */
  followSymbolicLinks?: boolean;

  /**
   * Match module-scope `defineIntent()` / `definePlaybook()` declarations and
   * report `.svelte` declarations the scanner can never read (#2591). Defaults
   * to `true`.
   */
  agentSurface?: boolean;

  /**
   * Glob patterns searched for `.svelte` declarations the scanner cannot read.
   * Only used when {@link OxcScannerOptions.agentSurface} is enabled.
   */
  svelteInclude?: string[];

  /**
   * Glob patterns searched for `defineIntent` / `definePlaybook` declarations,
   * independently of {@link OxcScannerOptions.include}.
   *
   * A model scan is routinely narrowed to where models live, but an intent
   * sidecar lives beside the component that uses it; binding declaration
   * discovery to the class glob would silently drop those. Only used when
   * {@link OxcScannerOptions.agentSurface} is enabled.
   */
  agentSurfaceInclude?: string[];
}

/**
 * Describes a pre-loaded manifest from an installed SMRT package, used by
 * {@link InheritanceResolver} to resolve base classes that originate outside
 * the local project source.
 *
 * Build tooling (e.g. the SMRT CLI / vitest plugin) loads each installed
 * `@happyvertical/smrt-*` package's `manifest.json` and converts it into an
 * `ExternalManifest` before passing it to the scanner.
 *
 * @see {@link OxcScannerOptions.externalManifests}
 * @see {@link InheritanceResolver.addExternalManifest}
 */
export interface ExternalManifest {
  /** npm package name, e.g. `'@happyvertical/smrt-profiles'`. */
  packageName: string;
  /** SemVer version string of the installed package. */
  packageVersion: string;
  /** All class definitions exported by the package, keyed by class name. */
  classes: Map<string, RawClassDefinition>;
}

// ============================================================================
// Field Type Inference
// ============================================================================

/**
 * The set of SMRT column types that the scanner can infer for a field.
 *
 * | Value | DB column type | Notes |
 * |---|---|---|
 * | `text` | `TEXT` / `VARCHAR` | Default for `string` and unknown types |
 * | `integer` | `INTEGER` | `number` with `= 0` initialiser |
 * | `decimal` | `DECIMAL` | `number` with `= 0.0` initialiser |
 * | `boolean` | `BOOLEAN` | `boolean` annotation or literal initialiser |
 * | `datetime` | `DATETIME` | `Date` annotation |
 * | `json` | `JSON` / `TEXT` | Arrays, `Record<>`, object types |
 * | `foreignKey` | `UUID` by default (FK column) | `@foreignKey(Class)` decorator |
 * | `crossPackageRef` | `UUID` by default (no FK constraint) | `@crossPackageRef('@pkg:Class')` decorator |
 * | `oneToMany` | — (virtual) | `@oneToMany(Class)` decorator |
 * | `manyToMany` | — (virtual) | `@manyToMany(Class)` decorator |
 * | `meta` | Stored in `_meta_data` | STI child field wrapped in `Meta<T>` |
 * | `unknown` | — | Could not be determined |
 *
 * @see {@link FieldTypeInference} for the full inference result shape.
 */
export type InferredFieldType =
  | 'text'
  | 'integer'
  | 'decimal'
  | 'boolean'
  | 'datetime'
  | 'json'
  | 'foreignKey'
  | 'crossPackageRef'
  | 'oneToMany'
  | 'manyToMany'
  | 'meta'
  | 'unknown';

/**
 * Result produced by {@link ManifestAdapter.inferFieldType} for a single field.
 *
 * In addition to the inferred `type`, carries the `source` of the inference
 * so callers can distinguish authoritative decorator-driven results from
 * heuristic guesses and provide better diagnostics.
 *
 * @see {@link InferredFieldType} for valid `type` values.
 * @see {@link ManifestAdapter.inferFieldType} for inference priority rules.
 */
export interface FieldTypeInference {
  /** Inferred SMRT type */
  type: InferredFieldType;

  /** Related class for relationship types */
  related?: string;

  /** Default value if extractable */
  defaultValue?: unknown;

  /** Whether field is required */
  required: boolean;

  /** Inference source for debugging */
  source: 'helper' | 'decorator' | 'annotation' | 'heuristic' | 'default';

  /** Underlying type for meta fields (e.g., 'string' inside Meta<string>) */
  underlyingType?: InferredFieldType;

  /**
   * Decorator-derived metadata that should be merged into the manifest
   * field's `_meta` object. Used by `@crossPackageRef`, `@manyToMany`,
   * `@meta` to carry options (`validate`, `through`, `indexed`, `idType`,
   * etc.) that don't fit on the top-level FieldDefinition.
   */
  _meta?: Record<string, unknown>;
}
