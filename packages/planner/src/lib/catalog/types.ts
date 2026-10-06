/**
 * The static package catalog: the shape of `catalog.json`, which
 * `pnpm catalog:generate` writes from the published `@happyvertical/smrt-*`
 * packages' `manifest.json` (and `smrt-knowledge.json` where present).
 *
 * Everything the browser needs is here, so the app never loads a package.
 */

/** Field types as the s-m-r-t manifest names them. */
export type CatalogFieldType =
  | 'text'
  | 'integer'
  | 'decimal'
  | 'boolean'
  | 'datetime'
  | 'json'
  | 'foreignKey'
  | 'crossPackageRef'
  | (string & {});

/** A field's static UI hints, from `@field({ ui })` (`_meta.ui` in the manifest). */
export interface CatalogFieldUI {
  /** Seeds the field into the "basic" tier, shown before the advanced ones. */
  basic?: boolean;
  /** Grouping key for form sections. */
  group?: string;
  /** Relative sort order, ascending. */
  order?: number;
  /** Seeds the field's policy as locked. */
  locked?: boolean;
}

export interface CatalogField {
  name: string;
  type: CatalogFieldType;
  required: boolean;
  /** Manifest default, when it is a plain JSON value. */
  default?: string | number | boolean | null;
  /** Referenced model (a class name in this package, or a qualified name). */
  related?: string;
  /** Allowed values, when the manifest declares an enumeration. */
  enum?: string[];
  /** `@field({ ui })` hints: `basic`, `group`, `order`, `locked`. */
  ui?: CatalogFieldUI;
  /**
   * Framework-managed (tenant id, timestamps): shown in the catalog but never
   * in generated forms.
   */
  system?: boolean;
}

export interface CatalogRoute {
  method: string;
  /** Path as the REST generator mounts it, without the `/api` prefix. */
  path: string;
}

export interface CatalogOperation {
  /** CRUD verb or method name this surface performs. */
  operation: string;
  /** Tool or command name. */
  name: string;
}

export interface CatalogMethod {
  name: string;
  async: boolean;
  /** `name: type` parameter strings, optional ones suffixed with `?`. */
  parameters: string[];
  returnType: string;
  /** An MCP tool exists for this method, so an AI agent can call it. */
  aiCallable: boolean;
}

export interface CatalogModel {
  /** `@scope/pkg:Class` qualified name. */
  id: string;
  /** Class name, e.g. `Product`. */
  name: string;
  /** Collection (REST resource) name, e.g. `products`. */
  collection: string;
  /** Qualified name of the model this one extends, when it is an STI child. */
  extends?: string;
  fields: CatalogField[];
  /** Generated REST routes. */
  rest: CatalogRoute[];
  /** Generated MCP tools. */
  mcp: CatalogOperation[];
  /** Generated CLI commands. */
  cli: CatalogOperation[];
  /** Public methods, with whether an AI agent can call them. */
  methods: CatalogMethod[];
  /** Qualified names of the models this model's fields reference. */
  references: string[];
  /**
   * False for internal models (junction tables and the like) that expose no
   * REST, MCP or CLI surface; they are listed but get no generated views.
   */
  exposed: boolean;
}

export interface CatalogPackage {
  /** Short name used in URLs and the selection, e.g. `products`. */
  id: string;
  /** Full npm name, e.g. `@happyvertical/smrt-products`. */
  packageName: string;
  version: string;
  description: string;
  models: CatalogModel[];
  /** Ids of other catalog packages this one needs (manifest + model refs). */
  dependencies: string[];
  /** Where the surfaces came from: the knowledge artifact or the manifest. */
  surfaceSource: 'knowledge' | 'manifest';
}

export interface Catalog {
  /** Schema version of this file. */
  schema: 1;
  /** Registry the catalog was generated from. */
  registry: string;
  /** Sorted by id. */
  packages: CatalogPackage[];
}
