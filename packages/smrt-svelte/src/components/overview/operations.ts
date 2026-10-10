/**
 * Structured overview operations (#3727 phase 4): the batch an assistant (or
 * any other non-UI caller) applies to an overview, and the description it
 * reads first.
 *
 * An operation is data, never code: `add`, `configure`, `move`, `resize` and
 * `remove`, with the same option vocabulary the grid's own editor uses. A batch
 * is planned against the page's definition and the current override with the
 * phase-1 model and then checked with {@link checkOverviewOverride}, so it can
 * only produce an override the save endpoint would accept. A batch is atomic:
 * one invalid operation rejects the whole batch and nothing is returned to
 * apply. Nothing here loads data or runs a query.
 *
 * Svelte-free; on both `./overview` and `./overview/server`.
 */

import {
  checkOverviewOverride,
  diffOverview,
  nextWidgetId,
  resolveOverview,
} from './model.js';
import type { WidgetRegistry } from './registry.js';
import { defaultWidgetOptions, validateWidgetOptions } from './schema.js';
import {
  OVERVIEW_DEFAULT_MAX_WIDGETS,
  OVERVIEW_ID_PATTERN,
  type OverviewDefinition,
  type OverviewDocument,
  type OverviewIssue,
  type OverviewOptions,
  type OverviewOptionValue,
  type OverviewOverride,
  type OverviewWidget,
  type RegisteredWidget,
  type WidgetOptionField,
  type WidgetOptionIssue,
} from './types.js';

/** Most operations one batch may carry. */
export const OVERVIEW_MAX_OPERATIONS = 20;

/** Add a widget at the end (or at `index`). */
export interface OverviewAddOperation {
  op: 'add';
  type: string;
  span?: number;
  options?: OverviewOptions;
  /** Position once added (default: the end). */
  index?: number;
}

/**
 * Change a widget's options. The given keys are merged onto the current
 * options; a `null` value clears that key back to its default.
 */
export interface OverviewConfigureOperation {
  op: 'configure';
  id: string;
  options: Record<string, OverviewOptionValue>;
}

/** Move a widget so it sits at `index` once it is taken out of the list. */
export interface OverviewMoveOperation {
  op: 'move';
  id: string;
  index: number;
}

/** Set a widget's column span. */
export interface OverviewResizeOperation {
  op: 'resize';
  id: string;
  span: number;
}

/** Remove a widget. */
export interface OverviewRemoveOperation {
  op: 'remove';
  id: string;
}

export type OverviewOperation =
  | OverviewAddOperation
  | OverviewConfigureOperation
  | OverviewMoveOperation
  | OverviewResizeOperation
  | OverviewRemoveOperation;

export type OverviewOperationKind = OverviewOperation['op'];

export const OVERVIEW_OPERATION_KINDS: readonly OverviewOperationKind[] = [
  'add',
  'configure',
  'move',
  'resize',
  'remove',
];

export type OverviewOperationIssueCode =
  | 'malformed'
  | 'too_many_operations'
  | 'unknown_widget'
  | 'unknown_type'
  | 'type_not_allowed'
  | 'invalid_options'
  | 'invalid_span'
  | 'invalid_index'
  | 'limit'
  | 'rejected';

/** Why one operation (or the batch) was rejected. */
export interface OverviewOperationIssue {
  /** Zero-based position of the operation in the batch; `null` for the batch. */
  index: number | null;
  op: string | null;
  widgetId: string | null;
  code: OverviewOperationIssueCode;
  /** Developer- and model-facing detail; not localized. */
  message: string;
  /** Option-level problems when `code` is `invalid_options`. */
  options?: WidgetOptionIssue[];
}

/** What one applied operation did. */
export interface OverviewOperationResult {
  index: number;
  op: OverviewOperationKind;
  /** The widget it touched (the new id for an `add`). */
  id: string;
}

export type OverviewPlan =
  | {
      ok: true;
      /** The canonical override to persist (`null` = back to defaults). */
      override: OverviewOverride | null;
      /** The document the override resolves to. */
      document: OverviewDocument;
      results: OverviewOperationResult[];
      /** True when the batch changes nothing. */
      unchanged: boolean;
    }
  | { ok: false; issues: OverviewOperationIssue[] };

export interface PlanOverviewOperationsInput {
  definition: OverviewDefinition;
  registry: WidgetRegistry;
  /** The current override (untrusted JSON; `null` for none). */
  override: unknown;
  /** The operations (untrusted JSON from a model). */
  operations: unknown;
  /** Batch cap (default {@link OVERVIEW_MAX_OPERATIONS}). */
  maxOperations?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const OPERATION_KEYS: Record<OverviewOperationKind, readonly string[]> = {
  add: ['op', 'type', 'span', 'options', 'index'],
  configure: ['op', 'id', 'options'],
  move: ['op', 'id', 'index'],
  resize: ['op', 'id', 'span'],
  remove: ['op', 'id'],
};

function cloneWidget(widget: OverviewWidget): OverviewWidget {
  return { ...widget, options: { ...widget.options } };
}

function describeOptionIssues(issues: readonly WidgetOptionIssue[]): string {
  return issues
    .map((issue) => `${issue.key || '(options)'}: ${issue.code}`)
    .join(', ');
}

function typeAllowed(
  definition: OverviewDefinition,
  def: RegisteredWidget,
): boolean {
  return (
    (!definition.allowed || definition.allowed.includes(def.type)) &&
    (!def.allowedIn || def.allowedIn.includes(definition.id))
  );
}

/** Widget types an overview allows, in registration order. */
export function allowedWidgetTypes(
  definition: OverviewDefinition,
  registry: WidgetRegistry,
): RegisteredWidget[] {
  return registry.list().filter((def) => typeAllowed(definition, def));
}

/**
 * Plan a batch of operations against an overview. Total: never throws, never
 * mutates its input. On success, persist (or `controller.restore`) the
 * returned `override`; on failure nothing may be applied.
 */
export function planOverviewOperations(
  input: PlanOverviewOperationsInput,
): OverviewPlan {
  const { definition, registry } = input;
  const max = input.maxOperations ?? OVERVIEW_MAX_OPERATIONS;
  const batchIssue = (
    code: OverviewOperationIssueCode,
    message: string,
  ): OverviewPlan => ({
    ok: false,
    issues: [{ index: null, op: null, widgetId: null, code, message }],
  });
  if (!Array.isArray(input.operations) || input.operations.length === 0) {
    return batchIssue('malformed', 'operations must be a non-empty array');
  }
  if (input.operations.length > max) {
    return batchIssue(
      'too_many_operations',
      `a batch holds at most ${max} operations`,
    );
  }

  const resolved = resolveOverview(definition, input.override, registry);
  const current = diffOverview(resolved.base, resolved.document);
  const widgets = resolved.document.widgets.map(cloneWidget);
  const cap = definition.maxWidgets ?? OVERVIEW_DEFAULT_MAX_WIDGETS;
  const reserved = new Set<string>([
    ...resolved.base.widgets.map((widget) => widget.id),
    ...widgets.map((widget) => widget.id),
    ...(current?.removed ?? []),
  ]);
  const context = { models: definition.models };
  const issues: OverviewOperationIssue[] = [];
  const results: OverviewOperationResult[] = [];

  input.operations.forEach((raw, index) => {
    const op = isRecord(raw) && typeof raw.op === 'string' ? raw.op : null;
    const widgetId =
      isRecord(raw) && typeof raw.id === 'string' ? raw.id : null;
    const fail = (
      code: OverviewOperationIssueCode,
      message: string,
      extra: Partial<OverviewOperationIssue> = {},
    ): void => {
      issues.push({ index, op, widgetId, code, message, ...extra });
    };
    if (!isRecord(raw) || op === null) {
      fail('malformed', 'operation must be an object with an "op"');
      return;
    }
    if (!(OVERVIEW_OPERATION_KINDS as readonly string[]).includes(op)) {
      fail(
        'malformed',
        `unknown op "${op}"; use one of ${OVERVIEW_OPERATION_KINDS.join(', ')}`,
      );
      return;
    }
    const kind = op as OverviewOperationKind;
    const extra = Object.keys(raw).filter(
      (key) => !OPERATION_KEYS[kind].includes(key),
    );
    if (extra.length) {
      fail('malformed', `unknown field(s) for ${kind}: ${extra.join(', ')}`);
      return;
    }

    const spanFor = (def: RegisteredWidget, value: unknown): number | null => {
      if (
        typeof value !== 'number' ||
        !Number.isInteger(value) ||
        value < def.minSpan ||
        value > def.maxSpan
      ) {
        fail(
          'invalid_span',
          `span for "${def.type}" must be an integer from ${def.minSpan} to ${def.maxSpan}`,
        );
        return null;
      }
      return value;
    };
    const indexFor = (value: unknown, length: number): number | null => {
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
        fail('invalid_index', 'index must be a non-negative integer');
        return null;
      }
      return Math.min(value, length);
    };
    const find = (): {
      position: number;
      widget: OverviewWidget;
      def: RegisteredWidget | undefined;
    } | null => {
      const position =
        widgetId === null || !OVERVIEW_ID_PATTERN.test(widgetId)
          ? -1
          : widgets.findIndex((widget) => widget.id === widgetId);
      if (position < 0) {
        fail(
          'unknown_widget',
          `no widget "${widgetId ?? ''}" on this overview; ids are ${
            widgets.map((widget) => widget.id).join(', ') || '(none)'
          }`,
        );
        return null;
      }
      const widget = widgets[position] as OverviewWidget;
      return { position, widget, def: registry.get(widget.type) };
    };

    if (kind === 'add') {
      const type = typeof raw.type === 'string' ? raw.type : '';
      const def = registry.get(type);
      if (!def) {
        fail('unknown_type', `widget type "${type}" is not registered`);
        return;
      }
      if (!typeAllowed(definition, def)) {
        fail(
          'type_not_allowed',
          `widget type "${type}" is not allowed on this overview; allowed: ${
            allowedWidgetTypes(definition, registry)
              .map((entry) => entry.type)
              .join(', ') || '(none)'
          }`,
        );
        return;
      }
      if (widgets.length >= cap) {
        fail('limit', `an overview holds at most ${cap} widgets`);
        return;
      }
      if (raw.options !== undefined && !isRecord(raw.options)) {
        fail('invalid_options', 'options must be an object');
        return;
      }
      const checked = validateWidgetOptions(
        def.options,
        { ...defaultWidgetOptions(def.options), ...(raw.options ?? {}) },
        context,
      );
      if (!checked.ok) {
        fail(
          'invalid_options',
          `options do not match "${type}": ${describeOptionIssues(checked.issues)}`,
          { options: checked.issues },
        );
        return;
      }
      const span =
        raw.span === undefined ? def.defaultSpan : spanFor(def, raw.span);
      if (span === null) return;
      const at =
        raw.index === undefined
          ? widgets.length
          : indexFor(raw.index, widgets.length);
      if (at === null) return;
      const id = nextWidgetId(reserved);
      reserved.add(id);
      widgets.splice(at, 0, {
        id,
        type,
        span,
        options: checked.options,
        version: def.version,
      });
      results.push({ index, op: kind, id });
      return;
    }

    const found = find();
    if (!found) return;
    const { position, widget, def } = found;

    if (kind === 'remove') {
      widgets.splice(position, 1);
      results.push({ index, op: kind, id: widget.id });
      return;
    }
    if (kind === 'move') {
      const rest = widgets.filter((entry) => entry.id !== widget.id);
      const at = indexFor(raw.index, rest.length);
      if (at === null) return;
      rest.splice(at, 0, widget);
      widgets.splice(0, widgets.length, ...rest);
      results.push({ index, op: kind, id: widget.id });
      return;
    }
    if (!def) {
      fail('unknown_type', `widget type "${widget.type}" is not registered`);
      return;
    }
    if (kind === 'resize') {
      const span = spanFor(def, raw.span);
      if (span === null) return;
      widgets[position] = { ...widget, span };
      results.push({ index, op: kind, id: widget.id });
      return;
    }
    // configure
    if (!isRecord(raw.options)) {
      fail('invalid_options', 'options must be an object');
      return;
    }
    const checked = validateWidgetOptions(
      def.options,
      { ...widget.options, ...raw.options },
      context,
    );
    if (!checked.ok) {
      fail(
        'invalid_options',
        `options do not match "${widget.type}": ${describeOptionIssues(checked.issues)}`,
        { options: checked.issues },
      );
      return;
    }
    widgets[position] = {
      ...widget,
      options: checked.options,
      version: def.version,
    };
    results.push({ index, op: kind, id: widget.id });
  });

  if (issues.length > 0) return { ok: false, issues };

  // The same strict check the save endpoint runs: whatever the operations
  // produced must be an override the server would accept.
  const proposed = diffOverview(resolved.base, { widgets });
  const checked = checkOverviewOverride(definition, proposed, registry);
  if (!checked.ok) {
    return { ok: false, issues: checked.issues.map(fromOverviewIssue) };
  }
  const document = resolveOverview(
    definition,
    checked.override,
    registry,
  ).document;
  return {
    ok: true,
    override: checked.override,
    document,
    results,
    unchanged:
      JSON.stringify(checked.override) === JSON.stringify(current ?? null),
  };
}

function fromOverviewIssue(issue: OverviewIssue): OverviewOperationIssue {
  const code: OverviewOperationIssueCode =
    issue.code === 'unknown_type' ||
    issue.code === 'type_not_allowed' ||
    issue.code === 'invalid_options' ||
    issue.code === 'invalid_span'
      ? issue.code
      : issue.code === 'too_many'
        ? 'limit'
        : 'rejected';
  return {
    index: null,
    op: null,
    widgetId: issue.widgetId,
    code,
    message: issue.message,
    ...(issue.options ? { options: issue.options } : {}),
  };
}

// ---------------------------------------------------------------------------
// Description

/** One option field, as a caller that builds operations reads it. */
export interface OverviewOptionDescription {
  key: string;
  type: WidgetOptionField['type'];
  label: string;
  help?: string;
  required?: boolean;
  default?: OverviewOptionValue;
  min?: number;
  max?: number;
  maxLength?: number;
  /** `enum`: the closed set of values. */
  choices?: string[];
  /** `model`: the models this page allows (absent = any model name). */
  models?: string[];
}

/** A widget type the page allows. */
export interface OverviewWidgetTypeDescription {
  type: string;
  title: string;
  description?: string;
  version: number;
  span: { default: number; min: number; max: number };
  options: OverviewOptionDescription[];
}

/** What an overview allows and what it shows now. JSON. */
export interface OverviewDescription {
  id: string;
  canCustomize: boolean;
  customized: boolean;
  maxWidgets: number;
  maxOperations: number;
  widgetTypes: OverviewWidgetTypeDescription[];
  /** The current arrangement, in display order. */
  widgets: Array<OverviewWidget & { index: number; title: string }>;
}

export interface DescribeOverviewInput {
  definition: OverviewDefinition;
  registry: WidgetRegistry;
  override: unknown;
  canCustomize: boolean;
  /** Turns titles, labels and help that are i18n keys into text. */
  translate?: (key: string) => string;
  maxOperations?: number;
}

/** Describe an overview for a caller that builds operations (an assistant). */
export function describeOverview(
  input: DescribeOverviewInput,
): OverviewDescription {
  const { definition, registry } = input;
  const t = input.translate ?? ((key: string) => key);
  const resolved = resolveOverview(definition, input.override, registry);
  const describeField = (
    field: WidgetOptionField,
  ): OverviewOptionDescription => {
    const out: OverviewOptionDescription = {
      key: field.key,
      type: field.type,
      label: t(field.label),
    };
    if (field.help) out.help = t(field.help);
    if (field.required) out.required = true;
    if (field.default !== undefined) out.default = field.default;
    if (field.min !== undefined) out.min = field.min;
    if (field.max !== undefined) out.max = field.max;
    if (field.maxLength !== undefined) out.maxLength = field.maxLength;
    if (field.choices) out.choices = field.choices.map((c) => c.value);
    if (field.type === 'model' && definition.models) {
      out.models = [...definition.models];
    }
    return out;
  };
  const titleOf = (widget: OverviewWidget): string => {
    const title = widget.options.title;
    if (typeof title === 'string' && title) return title;
    const def = registry.get(widget.type);
    return def ? t(def.title) : widget.type;
  };
  return {
    id: definition.id,
    canCustomize: input.canCustomize,
    customized: diffOverview(resolved.base, resolved.document) !== null,
    maxWidgets: definition.maxWidgets ?? OVERVIEW_DEFAULT_MAX_WIDGETS,
    maxOperations: input.maxOperations ?? OVERVIEW_MAX_OPERATIONS,
    widgetTypes: allowedWidgetTypes(definition, registry).map((def) => ({
      type: def.type,
      title: t(def.title),
      ...(def.description ? { description: t(def.description) } : {}),
      version: def.version,
      span: { default: def.defaultSpan, min: def.minSpan, max: def.maxSpan },
      options: def.options.map(describeField),
    })),
    widgets: resolved.document.widgets.map((widget, index) => ({
      ...cloneWidget(widget),
      index,
      title: titleOf(widget),
    })),
  };
}

/**
 * JSON schema of one operation, for a tool's `inputSchema` / `parameters`.
 * Option values are JSON primitives; the per-type fields come from
 * {@link describeOverview}.
 */
export const OVERVIEW_OPERATION_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['op'],
  additionalProperties: false,
  properties: {
    op: { type: 'string', enum: [...OVERVIEW_OPERATION_KINDS] },
    type: {
      type: 'string',
      description: 'add: a widget type the description lists.',
    },
    id: {
      type: 'string',
      description: 'configure/move/resize/remove: an existing widget id.',
    },
    span: {
      type: 'integer',
      minimum: 1,
      maximum: 4,
      description: "add/resize: columns, within the type's span range.",
    },
    index: {
      type: 'integer',
      minimum: 0,
      description: 'add/move: zero-based position.',
    },
    options: {
      type: 'object',
      description:
        'add: the options; configure: keys to change (null resets a key). Only the fields the description lists; values are strings, numbers or booleans.',
      additionalProperties: {
        type: ['string', 'number', 'boolean', 'null'],
      },
    },
  },
};
