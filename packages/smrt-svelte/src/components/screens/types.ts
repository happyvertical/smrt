import type { Snippet } from 'svelte';
import type { WidgetRegistry } from '../overview/registry.js';
import type {
  OverviewDefinition,
  OverviewOverride,
  WidgetLoadContext,
} from '../overview/types.js';
import type { CoreWidgetLoaders } from '../overview/widgets/core.js';
import type { ScreenRelation } from './relations.js';
import type { FieldRole } from './roles.js';

/**
 * Structural types for the manifest-derived record screens (#3718).
 *
 * These mirror the browser-safe `SmrtWebCollectionDefinition` that the SMRT
 * build emits and the `ResolvedObjectFieldPolicy` that `@happyvertical/smrt-fields`
 * resolves, without importing either package: smrt-svelte stays below the
 * domain layer in the dependency graph, and an app passes the generated
 * definition and resolved policy straight in as props.
 */

/** Persisted public wire types emitted by generated web collections. */
export type ScreenFieldType =
  | 'text'
  | 'integer'
  | 'decimal'
  | 'boolean'
  | 'datetime'
  | 'json'
  | 'foreignKey'
  | 'crossPackageRef';

/**
 * How a value is presented: `money` (integer minor units), `date` (a
 * business date, shown without a time), `datetime`, `percent` (a rate, `0.08`
 * shows as `8%`).
 */
export type ScreenFieldFormat = 'money' | 'date' | 'datetime' | 'percent';

/** Static `@field({ ui })` presentation hints from the manifest. */
export interface ScreenFieldUIHints {
  basic?: boolean;
  group?: string;
  order?: number;
  locked?: boolean;
  /**
   * `currency` on a TEXT field is the currency-code picker (the manifest
   * meaning); on an INTEGER field it is read as the legacy money hint.
   */
  widget?: 'textarea' | 'currency' | 'email' | 'url' | 'phone';
  /** Manifest presentation format (`@field({ ui: { format } })`). */
  format?: ScreenFieldFormat;
}

/** Browser-safe subset of one generated web field definition. */
export interface ScreenFieldDefinition {
  type: ScreenFieldType;
  required?: boolean;
  nullable?: boolean;
  default?: unknown;
  /** Developer-authored `@field({ description })`; the code-seed help text. */
  description?: string;
  ui?: ScreenFieldUIHints;
  /**
   * What the field means on a record page (`deriveFieldRoles`). Explicit
   * roles are authoritative: name heuristics never add to them.
   */
  role?: FieldRole | readonly FieldRole[];
  /** Allowed values; a text field with an enum edits as a select. */
  enum?: readonly string[];
  /** Presentation format; wins over `ui.format`. */
  format?: ScreenFieldFormat;
  /** This field is the record's display label (the `title` role). */
  display?: boolean;
}

export type ScreenRelationshipKind =
  | 'foreignKey'
  | 'crossPackageRef'
  | 'oneToMany'
  | 'manyToMany';

/**
 * One manifest-derived relationship edge, structurally the generated
 * `SmrtWebRelationship`: `field` is the FK field on this model and
 * `relatedCollection` the sibling collection's name (the key in
 * `collectionDefinitions`), not a qualified model id.
 */
export interface ScreenRelationshipDefinition {
  field: string;
  kind: ScreenRelationshipKind;
  relatedCollection: string;
  /**
   * `items`: the declaring (child) model is the line items of the target
   * (`@foreignKey(Order, { role: 'items' })`); `deriveScreenRelations`
   * classifies the relation `items`.
   */
  role?: 'items';
}

/** Structural subset of a generated `SmrtWebCollectionDefinition`. */
export interface ScreenCollectionDefinition {
  /** Collection name (the key in `collectionDefinitions`); used to resolve relationships. */
  name?: string;
  /** Canonical qualified model identity (`@package/name:ClassName`). */
  objectRef: string;
  /** Simple class name, used to derive default titles. */
  className: string;
  /** Primary-key field name. Defaults to `id`. */
  idField?: string;
  fields: Readonly<Record<string, ScreenFieldDefinition>>;
  /** Manifest-derived relationship edges; the source of `deriveScreenRelations`. */
  relationships?: readonly ScreenRelationshipDefinition[];
}

export type ScreenFieldVisibility = 'basic' | 'advanced' | 'hidden';

/**
 * One field's resolved policy. Structurally satisfied by smrt-fields'
 * `ResolvedFieldPolicy`, so a resolved policy can be passed unchanged.
 */
export interface ScreenFieldPolicy {
  visibility: ScreenFieldVisibility;
  label?: string | null;
  help?: string | null;
  order?: number | null;
  group?: string | null;
  required?: boolean;
  hasDefault?: boolean;
  defaultValue?: unknown;
  locked?: boolean;
}

/** Structurally satisfied by smrt-fields' `ResolvedObjectFieldPolicy`. */
export interface ScreenPolicy {
  objectRef: string;
  fields: Readonly<Record<string, ScreenFieldPolicy>>;
}

export type ScreenMode = 'list' | 'view' | 'edit';

/** How a field is rendered and edited. */
export type ScreenInputKind =
  | 'text'
  | 'textarea'
  | 'email'
  | 'url'
  | 'tel'
  | 'integer'
  | 'decimal'
  | 'money'
  | 'boolean'
  | 'datetime'
  | 'json'
  | 'reference'
  | 'select';

/** A field selected and decorated for one screen. */
export interface ScreenField {
  name: string;
  label: string;
  /** Help text (policy help, else the manifest description). */
  help: string | null;
  type: ScreenFieldType;
  kind: ScreenInputKind;
  required: boolean;
  /** `basic` fields show first; `advanced` ones sit behind a disclosure. */
  tier: 'basic' | 'advanced';
  group: string | null;
  order: number | null;
  definition: ScreenFieldDefinition;
  /** The field's roles (`deriveFieldRoles`); set by `deriveScreenFields`. */
  roles?: readonly FieldRole[];
  /** Choices of a `select` field (the definition's `enum`). */
  options?: readonly string[];
}

/** Why a draft value could not become a payload value. */
export type ScreenFieldErrorCode =
  | 'required'
  | 'invalid_integer'
  | 'invalid_decimal'
  | 'invalid_money'
  | 'invalid_datetime'
  | 'invalid_json';

/** A row from the backing collection. */
export type ScreenRecord = Readonly<Record<string, unknown>>;

/** Draft value held by an edit form: booleans stay booleans, the rest text. */
export type ScreenDraftValue = string | boolean;
export type ScreenDraft = Record<string, ScreenDraftValue>;

/** Data access a {@link RecipeScreens} instance drives. Transport-neutral. */
export interface RecipeScreensSource {
  list(): Promise<readonly ScreenRecord[]>;
  /** Optional: when absent the record is looked up in the loaded list. */
  get?(id: string): Promise<ScreenRecord | undefined>;
  create?(values: Record<string, unknown>): Promise<ScreenRecord | undefined>;
  update?(
    id: string,
    values: Record<string, unknown>,
  ): Promise<ScreenRecord | undefined>;
  delete?(id: string): Promise<void>;
}

export type RecipeScreenView = 'list' | 'view' | 'create' | 'edit';

// Component props (declared here so the barrel never re-exports types from .svelte files)

export interface ListScreenProps {
  /** Generated browser-safe collection definition. */
  definition: ScreenCollectionDefinition;
  /** Resolved field policy for the same object; omit for the code seed. */
  policy?: ScreenPolicy | null;
  /** Rows to show. */
  rows: readonly ScreenRecord[];
  /** Page title. Defaults to the pluralized class name. */
  title?: string;
  /** Subtitle under the title. */
  description?: string;
  /** Explicit column field names, in order (overrides the derived set). */
  columns?: readonly string[];
  /** Cap on derived columns. */
  maxColumns?: number;
  /** Rows per page. */
  pageSize?: number;
  /** Show the search box. */
  searchable?: boolean;
  loading?: boolean;
  /** Load failure message; rows already present stay visible. */
  error?: string | null;
  /** ISO 4217 code used by money fields. */
  currency?: string;
  /** BCP-47 locale for number and date formatting. */
  locale?: string;
  /** Render the page header (title and create action). */
  showHeader?: boolean;
  /** Row activation (click or Enter). */
  onselect?: (row: ScreenRecord) => void;
  /** When set, a create action is offered. */
  oncreate?: () => void;
  onretry?: () => void;
  /** Extra header actions, rendered before the create action. */
  extraActions?: Snippet;
}

export interface DetailScreenProps {
  definition: ScreenCollectionDefinition;
  /** Resolved field policy for the same object; omit for the code seed. */
  policy?: ScreenPolicy | null;
  record: ScreenRecord;
  /** Page title. Defaults to the first basic text field, else the class name. */
  title?: string;
  /** Explicit field names, in order (overrides the derived set). */
  fields?: readonly string[];
  /** ISO 4217 code used by money fields. */
  currency?: string;
  /** BCP-47 locale for number and date formatting. */
  locale?: string;
  showHeader?: boolean;
  /** Label for the back action; defaults to the pluralized class name. */
  backLabel?: string;
  /** Mutation in flight; locks the delete confirmation. */
  deleting?: boolean;
  onback?: () => void;
  onedit?: () => void;
  /** When set, a Delete action with a confirmation is offered. */
  ondelete?: () => void | Promise<void>;
  /** Extra header actions, rendered before Edit and Delete. */
  extraActions?: Snippet;
  /** Extra content under the fields. */
  children?: Snippet;
  /**
   * Relations of this model (`deriveScreenRelations`). The `reference` ones
   * map a FK field to its target model, which `labels` is keyed by.
   */
  relations?: readonly ScreenRelation[];
  /** Link for a reference field's value; `undefined` renders no link. */
  hrefFor?: (field: ScreenField, id: string) => string | undefined;
  /**
   * Display label for a referenced record, keyed by target model id
   * (`relation.model`); `undefined` falls back to the raw id.
   */
  labels?: Readonly<Record<string, (id: string) => string | undefined>>;
}

/** What a submit handler may return to report server-side field problems. */
export interface EditFormSubmitResult {
  fieldErrors?: Readonly<Record<string, string>>;
}

export interface EditFormProps {
  definition: ScreenCollectionDefinition;
  /** Resolved field policy for the same object; omit for the code seed. */
  policy?: ScreenPolicy | null;
  /** The record being edited; omit to create a new one. */
  record?: ScreenRecord;
  /** Page title. Defaults to "New x" / "Edit x" from the class name. */
  title?: string;
  /** Explicit field names, in order (overrides the derived set). */
  fields?: readonly string[];
  /** ISO 4217 code used by money fields. */
  currency?: string;
  showHeader?: boolean;
  /** True while the host is persisting; locks the form. */
  submitting?: boolean;
  /** Server-reported field messages, keyed by field name. */
  fieldErrors?: Readonly<Record<string, string>>;
  /** A form-level failure message from the host. */
  error?: string | null;
  /** Receives wire-ready values for the displayed fields. */
  onsubmit: (
    values: Record<string, unknown>,
    context: { isNew: boolean },
    // biome-ignore lint/suspicious/noConfusingVoidType: a handler that returns nothing (sync or async) is the common case.
  ) => void | EditFormSubmitResult | Promise<void | EditFormSubmitResult>;
  oncancel?: () => void;
}

export type RecordScreenMode = 'view' | 'edit';

/**
 * Props of `RecordScreen`: the record view (#3718 record view). The detail
 * header and fields sit at the top, a customizable overview of related
 * records below; `mode: 'edit'` opens the edit form beside the header on
 * desktop and in a full-screen sheet on phones.
 */
export interface RecordScreenProps {
  definition: ScreenCollectionDefinition;
  /** Resolved field policy for the same object; omit for the code seed. */
  policy?: ScreenPolicy | null;
  record: ScreenRecord;
  /** Relations of this model (`deriveScreenRelations`). */
  relations?: readonly ScreenRelation[];
  mode: RecordScreenMode;
  /**
   * Loaders of the core widgets; the shell registers them on a registry of
   * its own and runs them in the browser with the record context. A widget
   * without a loader is not offered (and a default using it is dropped).
   */
  loaders?: CoreWidgetLoaders;
  /** An explicit registry (recipe widgets included) instead of one built from `loaders`. */
  registry?: WidgetRegistry;
  /**
   * Host capabilities for the widget loads (a `fetch`, a client, the
   * locale). `overviewId` and `record` are set by the screen.
   */
  widgetContext?: Omit<WidgetLoadContext, 'overviewId' | 'record'>;
  /** The overview to render; defaults to `recordOverview(definition, relations)`. */
  overview?: OverviewDefinition;
  /** The stored layout override for this model kind (host-owned when given). */
  override?: OverviewOverride | null;
  /** Receives the override after each layout edit (`null` = defaults). */
  onoverviewchange?: (
    override: OverviewOverride | null,
  ) => void | Promise<void>;
  /** Layout edit mode; omit to follow the shell's layout editor. */
  layoutEditing?: boolean;
  /** Whether the viewer may customize the layout (default true). */
  canCustomize?: boolean;
  /** Link for a reference field's value. */
  hrefFor?: (field: ScreenField, id: string) => string | undefined;
  /** Display labels for referenced records, keyed by target model id. */
  labels?: Readonly<Record<string, (id: string) => string | undefined>>;
  /** "View all" link of a related-records panel; `undefined` renders none. */
  viewAllHref?: (relation: ScreenRelation) => string | undefined;
  /** Page title. Defaults to the first basic text field, else the class name. */
  title?: string;
  /** Explicit field names, in order (overrides the derived set). */
  fields?: readonly string[];
  /** ISO 4217 code used by money fields. */
  currency?: string;
  /** BCP-47 locale for number and date formatting. */
  locale?: string;
  /** Label for the back action; defaults to the pluralized class name. */
  backLabel?: string;
  /** Mutation in flight; locks the delete confirmation. */
  deleting?: boolean;
  /** True while the host is persisting the edit; locks the form. */
  submitting?: boolean;
  /** Server-reported field messages for the edit form, keyed by field name. */
  fieldErrors?: Readonly<Record<string, string>>;
  /** A form-level failure message from the host. */
  error?: string | null;
  onback?: () => void;
  /** When set, an Edit action is offered (the host switches `mode`). */
  onedit?: () => void;
  /** Closes the edit form (Cancel, the sheet's close button, Escape). */
  oncancel?: () => void;
  /** Receives the edit form's wire-ready values; `EditFormProps['onsubmit']`. */
  onsave?: EditFormProps['onsubmit'];
  /** When set, a Delete action with a confirmation is offered. */
  ondelete?: () => void | Promise<void>;
  /** Extra header actions, rendered before Edit and Delete. */
  extraActions?: Snippet;
  /** Extra content between the fields and the overview. */
  children?: Snippet;
}

export interface RecipeScreensProps {
  definition: ScreenCollectionDefinition;
  /** Resolved field policy for the same object; omit for the code seed. */
  policy?: ScreenPolicy | null;
  source: RecipeScreensSource;
  /** Current screen (bindable). */
  view?: RecipeScreenView;
  /** Record shown by `view` and `edit` (bindable). */
  recordId?: string | null;
  /** List title. Defaults to the pluralized class name. */
  title?: string;
  /** Explicit list columns, in order. */
  columns?: readonly string[];
  /** Explicit view / edit field names, in order. */
  fields?: readonly string[];
  currency?: string;
  locale?: string;
  /** Turn operations off even when the source supports them. */
  can?: { create?: boolean; update?: boolean; delete?: boolean };
  /** Called on every user navigation, for router synchronization. */
  onnavigate?: (view: RecipeScreenView, recordId: string | null) => void;
  /**
   * Every exposed collection definition, keyed by collection name; the
   * record view derives this model's relations from it. Omit for none.
   */
  definitions?: Readonly<Record<string, ScreenCollectionDefinition>>;
  /** Passed to `RecordScreen` for the record view and edit. */
  record?: Pick<
    RecordScreenProps,
    | 'loaders'
    | 'registry'
    | 'widgetContext'
    | 'overview'
    | 'override'
    | 'onoverviewchange'
    | 'layoutEditing'
    | 'canCustomize'
    | 'hrefFor'
    | 'labels'
    | 'viewAllHref'
  >;
}
