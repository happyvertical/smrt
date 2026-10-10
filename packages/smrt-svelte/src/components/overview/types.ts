import type { Component } from 'svelte';

/**
 * Types of the customizable overview surface (#3727): the declarative overview
 * data model, the widget contract, and the page-load contract, plus their
 * limits. Shared by the Svelte-free `./overview/server` entry and the
 * component barrel.
 */

/** Narrowest and widest a widget can be, in grid columns. */
export const OVERVIEW_MIN_SPAN = 1;
export const OVERVIEW_MAX_SPAN = 4;
/** Default cap on widgets in one overview. */
export const OVERVIEW_DEFAULT_MAX_WIDGETS = 24;
/** Widget ids: short, URL-safe, stable. */
export const OVERVIEW_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** Overview (page) ids may be dotted or scoped, e.g. `events.home`. */
export const OVERVIEW_PAGE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/;
/** Widget type ids: lowercase kebab, so they are safe in selectors and keys. */
export const WIDGET_TYPE_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

/** An option value is a JSON primitive: options are flat data, never code. */
export type OverviewOptionValue = string | number | boolean | null;
export type OverviewOptions = Record<string, OverviewOptionValue>;

/**
 * One widget on an overview. `version` is the widget type's option-schema
 * version the options were written against (absent means 1).
 */
export interface OverviewWidget {
  id: string;
  type: string;
  /** Column span, 1 to 4. */
  span: number;
  options: OverviewOptions;
  version?: number;
}

/** The resolved, declarative overview: an ordered list of widgets. */
export interface OverviewDocument {
  widgets: OverviewWidget[];
}

/** A change to a widget that exists in the base document. */
export interface OverviewWidgetPatch {
  span?: number;
  options?: OverviewOptions;
  version?: number;
}

/**
 * The sparse, JSON-serializable delta a host stores (tenant default or user
 * override) on top of the page's default document. Unknown ids are ignored
 * on read, so a default that ships later still appears.
 */
export interface OverviewOverride {
  version: 1;
  /** Widget ids in display order; unlisted widgets keep their slots. */
  order?: string[];
  /** Ids of base widgets the user removed. */
  removed?: string[];
  /** Widgets the user added (ids never collide with the base). */
  added?: OverviewWidget[];
  /** Span and option changes to base widgets, by id. */
  changed?: Record<string, OverviewWidgetPatch>;
}

/** What a page declares: which widgets may appear and the default layout. */
export interface OverviewDefinition {
  /** Stable id of this overview (e.g. `events.home`). */
  id: string;
  /** Widget types allowed here. Omit to allow every registered type. */
  allowed?: readonly string[];
  /**
   * Models the overview may read. When set, a `model` option outside the list
   * is invalid. Confines data sources on top of the loader's own authorization.
   */
  models?: readonly string[];
  /** The default arrangement. */
  defaults: readonly OverviewWidget[];
  /** Cap on widgets (default {@link OVERVIEW_DEFAULT_MAX_WIDGETS}). */
  maxWidgets?: number;
}

export type OverviewIssueCode =
  | 'malformed'
  | 'duplicate_id'
  | 'unknown_type'
  | 'type_not_allowed'
  | 'too_many'
  | 'invalid_span'
  | 'invalid_options'
  | 'future_version'
  | 'migration_failed';

/** A widget (or override entry) that was dropped or rejected, and why. */
export interface OverviewIssue {
  widgetId: string | null;
  type: string | null;
  code: OverviewIssueCode;
  /** Developer-facing detail; not localized. */
  message: string;
  /** Option-level problems when `code` is `invalid_options`. */
  options?: WidgetOptionIssue[];
}

// ---------------------------------------------------------------------------
// Option schema

export type WidgetOptionType =
  | 'text'
  | 'markdown'
  | 'identifier'
  | 'model'
  | 'integer'
  | 'number'
  | 'boolean'
  | 'enum';

export interface WidgetOptionChoice {
  value: string;
  /** Label text or an i18n key. */
  label: string;
}

/**
 * One option of a widget. The shape mirrors the generated screens' field
 * (`name`/`label`/`help`/`required`) so the option editor reads like any other
 * generated form.
 */
export interface WidgetOptionField {
  key: string;
  type: WidgetOptionType;
  /** Label text or an i18n key. */
  label: string;
  /** Help text or an i18n key. */
  help?: string;
  required?: boolean;
  default?: OverviewOptionValue;
  /** `integer` and `number` bounds. */
  min?: number;
  max?: number;
  /** `text`, `markdown`: maximum length (defaults 200 and 10000). */
  maxLength?: number;
  /** `enum`: the closed set of values. */
  choices?: readonly WidgetOptionChoice[];
}

export type WidgetOptionIssueCode =
  | 'required'
  | 'invalid_type'
  | 'too_long'
  | 'out_of_range'
  | 'not_in_choices'
  | 'invalid_format'
  | 'not_allowed'
  | 'unknown_option';

export interface WidgetOptionIssue {
  key: string;
  code: WidgetOptionIssueCode;
}

export type WidgetOptionsResult =
  | { ok: true; options: OverviewOptions }
  | { ok: false; issues: WidgetOptionIssue[] };

/** Extra confinement applied while validating options. */
export interface WidgetOptionsContext {
  /** Models a `model` option may name; omit for no list. */
  models?: readonly string[];
}

// ---------------------------------------------------------------------------
// Widget contract

/** Where a widget's data stands in the grid. */
export type WidgetStatus = 'ready' | 'loading' | 'error';

/**
 * Props every widget component receives. The grid mounts a component only
 * when its data is ready (it draws loading and error states itself), so
 * `data` is whatever the widget's `load` returned, or `undefined` for a
 * widget without a loader. Treat `data` as untrusted shape: check it.
 */
export interface WidgetComponentProps<Data = unknown> {
  id: string;
  options: OverviewOptions;
  data: Data | undefined;
  span: number;
  /** Heading shown by the frame (the `title` option, else the type title). */
  title: string;
  /** BCP-47 locale for number formatting. */
  locale: string;
  /** The host's renderer for icon names that are not built in. */
  iconComponent?: Component<{ name: string; size?: number }>;
}

/**
 * Context a widget `load` runs with. The host builds it inside the page's
 * server load from the request principal: the user's permissions, the
 * tenant-scoped collections, the locale. Index keys carry host capabilities
 * (for example a permission-checked `db` or `fetch`).
 */
export interface WidgetLoadContext {
  /** The overview being loaded. */
  overviewId: string;
  /** Aborts when the load times out or the request ends. */
  signal?: AbortSignal;
  locale?: string;
  [capability: string]: unknown;
}

/**
 * Server loader of one widget. Receives validated options only, and the
 * request's context. Must return JSON-serializable data and must authorize
 * through `ctx` (never trust the option values for access).
 */
export type WidgetLoad<
  Data = unknown,
  Ctx extends WidgetLoadContext = WidgetLoadContext,
> = (options: OverviewOptions, ctx: Ctx) => Data | Promise<Data>;

/** Upgrades stored options from an older schema version to the current one. */
export type WidgetMigrate = (
  options: Record<string, unknown>,
  fromVersion: number,
) => Record<string, unknown> | null;

/** A module (or component) a lazy widget resolves to. */
export type WidgetComponentModule<Data> =
  | Component<WidgetComponentProps<Data>>
  | { default: Component<WidgetComponentProps<Data>> };

/** What `registerWidget` takes. */
export interface WidgetDefinition<Data = unknown> {
  /** Lowercase kebab id, e.g. `metric`. */
  type: string;
  /** Title text or an i18n key. */
  title: string;
  /** Short description or an i18n key (shown in the add list). */
  description?: string;
  /** Shell icon name drawn in the add list. */
  icon?: string;
  /** Option-schema version, a positive integer (default 1). */
  version?: number;
  /** The widget's options, as fields. */
  options: readonly WidgetOptionField[];
  /** Renders the widget. */
  component?: Component<WidgetComponentProps<Data>>;
  /**
   * Resolves the component lazily (dynamic import by export ref). A page
   * resolves these before rendering with `resolveWidgetComponents`.
   */
  loadComponent?: () => Promise<WidgetComponentModule<Data>>;
  /** Server loader; absent for widgets that render from options alone. */
  load?: WidgetLoad<Data>;
  /** Overview ids this widget may appear in; omit for any. */
  allowedIn?: readonly string[];
  /** Upgrades options stored at an older version. */
  migrate?: WidgetMigrate;
  /** Span a new widget starts with (default 1). */
  defaultSpan?: number;
  minSpan?: number;
  maxSpan?: number;
}

/** A registered definition with every default filled in. */
export interface RegisteredWidget<Data = unknown>
  extends Omit<WidgetDefinition<Data>, 'version' | 'defaultSpan'> {
  version: number;
  defaultSpan: number;
  minSpan: number;
  maxSpan: number;
}

// ---------------------------------------------------------------------------
// Loaded overview (serializable, server to client)

export type LoadedWidgetErrorCode = 'load_failed' | 'timeout' | 'invalid_data';

/** A widget with its loaded data. JSON-serializable. */
export interface LoadedWidget extends OverviewWidget {
  status: 'ready' | 'error';
  data?: unknown;
  error?: { code: LoadedWidgetErrorCode };
}

/** What a page's server load returns for the client to render. */
export interface LoadedOverview {
  overviewId: string;
  widgets: LoadedWidget[];
  issues: OverviewIssue[];
}
