/**
 * Shapes for the SMRT mobile contract pipeline:
 * manifest.json (+ allowlist) → MobileContract → generated Kotlin/Swift DTOs.
 */

/** One field entry in a SMRT manifest's `objects[*].fields` map. */
export interface SmrtManifestField {
  type?: string;
  required?: boolean;
  related?: string;
  /** Current SMRT manifests emit `default`; amaru-era manifests used `defaultValue`. */
  default?: unknown;
  defaultValue?: unknown;
  _meta?: Record<string, unknown>;
}

/** One object entry in a SMRT manifest (model or collection). */
export interface SmrtManifestObject {
  name: string;
  className?: string;
  qualifiedName?: string;
  collection?: string | null;
  packageName?: string;
  fields?: Record<string, SmrtManifestField>;
  schema?: { tableName?: string } | null;
}

/** The subset of a SMRT `manifest.json` the codegen consumes. */
export interface SmrtManifest {
  version?: number | string;
  packageName?: string;
  objects: Record<string, SmrtManifestObject> | SmrtManifestObject[];
}

export interface MobileContractField {
  sourceName: string;
  name: string;
  kotlinType: string;
  swiftType: string;
  nullable: boolean;
  /** Kotlin default-value expression, or null for required (id). */
  kotlinDefault: string | null;
}

export interface MobileContractObject {
  name: string;
  qualifiedName: string;
  dtoName: string;
  tableName: string | null;
  hasTenantId: boolean;
  fields: MobileContractField[];
}

export interface MobileContractOptions {
  manifests: SmrtManifest[];
  /** Object names (or qualified names) exposed to mobile. */
  allowlist: string[];
  /** Kotlin package the domain DTOs are emitted into. */
  kotlinPackage: string;
  /** Provenance label recorded in the contract (e.g. the manifest path). */
  sourceLabel?: string;
}

export interface MobileContract {
  schemaVersion: number;
  contractVersion: string;
  sourceLabel: string;
  sourceHash: string;
  objectAllowlist: string[];
  objectCount: number;
  kotlin: { packageName: string };
  typeMappings: Record<string, string>;
  objects: MobileContractObject[];
}
