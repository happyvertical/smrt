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
 * | `foreignKey` | `TEXT` (FK column) | `@foreignKey(Class)` decorator |
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
}
