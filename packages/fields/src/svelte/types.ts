/**
 * Shared types for the field-policy Svelte primitives.
 */

/**
 * Props for the PolicyField headless snippet escape hatch — all the data a
 * fully custom renderer needs.
 */
export interface PolicyFieldSnippetProps {
  id: string;
  helpId: string;
  visible: boolean;
  label: string | null;
  help: string | null;
  defaultValue: unknown;
  required: boolean;
  /** Resolved visibility tier from the policy. */
  tier: 'basic' | 'advanced' | 'hidden';
}

/**
 * Browser-safe subset of a generated SMRT web field definition. This mirrors
 * the `@smrt/web` wire contract without making the reusable Svelte package
 * depend on an application's generated virtual module.
 */
export interface ObjectFormFieldDefinition {
  /**
   * The persisted public wire types emitted by generated web collections.
   * There is deliberately no `select` wire type: applications render
   * select-like controls by registering a field-specific renderer for a text
   * (or other persisted) wire field.
   */
  type: ObjectFormWireType;
  required?: boolean;
  default?: unknown;
  description?: string;
  ui?: {
    basic?: boolean;
    group?: string;
    order?: number;
    locked?: boolean;
  };
}

/** Browser-observable scalar types emitted by a generated web collection. */
export type ObjectFormWireType =
  | 'text'
  | 'integer'
  | 'decimal'
  | 'boolean'
  | 'datetime'
  | 'json'
  | 'foreignKey'
  | 'crossPackageRef';

/** Structural subset of a generated `SmrtWebCollectionDefinition`. */
export interface ObjectFormCollectionDefinition {
  /** Canonical qualified model identity, never a simple class name. */
  objectRef: string;
  /** Browser-safe generated field definitions. */
  fields: Readonly<Record<string, ObjectFormFieldDefinition>>;
}

/** Generated custom-action client shape, intentionally independent of smrt-web. */
export interface ObjectFormPolicyClient {
  resolveBatch(input: { objectRefs: string[] }): Promise<unknown>;
}

/** Resolved definition and policy consumed by `ObjectForm`. */
export interface ObjectFormResolvedSource {
  definition: ObjectFormCollectionDefinition;
  policy: import('../types.js').ResolvedObjectFieldPolicy;
}

/**
 * Per-app source contract. The source owns generated definitions and the
 * app's custom-action transport; ObjectForm never imports a client runtime.
 */
export interface ObjectFormSource {
  load(objectRef: string): Promise<ObjectFormResolvedSource>;
}

/** A field selected from the safe web-definition × resolved-policy overlap. */
export interface ObjectFormField {
  name: string;
  definition: ObjectFormFieldDefinition;
  group: string | null;
  order: number | null;
}

/** Props shared by built-in and app-registered ObjectForm input renderers. */
export interface FieldInputProps {
  id: string;
  name: string;
  /** Resolved human-facing label for controls whose native name is absent. */
  label?: string | null;
  field: ObjectFormField;
  value: unknown;
  required: boolean;
  disabled: boolean;
  onvaluechange: (value: unknown) => void;
  /** Reports parser validity to the host form/editor. */
  onvaliditychange?: (valid: boolean) => void;
}

/** Data exposed to an ObjectForm per-field snippet override. */
export interface ObjectFormFieldSnippetProps {
  id: string;
  helpId: string;
  field: ObjectFormField;
  value: unknown;
  required: boolean;
  disabled: boolean;
  setValue(value: unknown): void;
  setValidity(valid: boolean): void;
}
