/**
 * Presentation metadata helpers (#3599): `@field({ ui: { widget } })` hints,
 * the own-field display label, and selector-slot lookup.
 *
 * Pure and dependency-free so it is safe in browser bundles
 * (`@happyvertical/smrt-core/ui-metadata`). The manifest generator, the MCP /
 * WebMCP tool descriptors, the knowledge projection and host UIs all read the
 * same rules from here.
 */

import type {
  ManifestUISelector,
  QualifiedClassName,
  SmartObjectManifest,
} from './scanner/types.js';

/** Widget hints a field may declare via `@field({ ui: { widget } })`. */
export const FIELD_UI_WIDGETS = [
  'textarea',
  'currency',
  'email',
  'url',
  'phone',
] as const;

export type FieldUIWidget = (typeof FIELD_UI_WIDGETS)[number];

/** Manifest field types each widget may be applied to. */
export const FIELD_UI_WIDGET_TYPES: Readonly<
  Record<FieldUIWidget, readonly string[]>
> = {
  textarea: ['text'],
  email: ['text'],
  url: ['text'],
  phone: ['text'],
  // Money is integer minor units (repo invariant); a decimal field is a rate.
  currency: ['integer'],
};

export function isFieldUIWidget(value: unknown): value is FieldUIWidget {
  return (
    typeof value === 'string' &&
    (FIELD_UI_WIDGETS as readonly string[]).includes(value)
  );
}

/**
 * Fields tried, in order, when a model declares no
 * `@smrt({ display: { label } })`.
 */
export const DEFAULT_DISPLAY_LABEL_FIELDS = [
  'name',
  'title',
  'label',
  'code',
] as const;

/** Field kinds that can never be a record's label (they are not its own value). */
const NON_LABEL_FIELD_TYPES = new Set([
  'foreignKey',
  'crossPackageRef',
  'oneToMany',
  'manyToMany',
  'json',
  'meta',
]);

interface LabelCandidate {
  type?: string;
  sensitive?: boolean;
  transient?: boolean;
  _meta?: { sensitive?: unknown; transient?: unknown } | undefined;
}

/**
 * Why `fieldName` cannot label a record of this model, or `null` when it can.
 * Used both to validate an explicit declaration and to filter the default
 * candidates.
 */
export function displayLabelFieldProblem(
  fields: Record<string, LabelCandidate>,
  fieldName: string,
): string | null {
  const field = fields[fieldName];
  if (!field) return `it is not a field of this model`;
  if (field.sensitive === true || field._meta?.sensitive === true) {
    return `it is a sensitive field`;
  }
  if (field.transient === true || field._meta?.transient === true) {
    return `it is a transient field`;
  }
  if (field.type && NON_LABEL_FIELD_TYPES.has(field.type)) {
    return `a ${field.type} field is not the record's own value`;
  }
  return null;
}

/**
 * The own field generic pickers and assistants use to label a record: the
 * declared `display.label` when present, otherwise the first of
 * {@link DEFAULT_DISPLAY_LABEL_FIELDS} that is a usable own field. `undefined`
 * when the model has none (it should then ship a selector).
 */
export function resolveDisplayLabelField(
  fields: Record<string, LabelCandidate>,
  declared?: string,
): string | undefined {
  if (declared !== undefined) {
    return displayLabelFieldProblem(fields, declared) === null
      ? declared
      : undefined;
  }
  return DEFAULT_DISPLAY_LABEL_FIELDS.find(
    (name) => displayLabelFieldProblem(fields, name) === null,
  );
}

/**
 * Sentence appended to generated tool descriptions (#3599), including its
 * leading separator; empty when the model has no label field.
 */
export function describeDisplayLabel(labelField: string | undefined): string {
  return labelField
    ? `. Records are identified by their \`${labelField}\` field.`
    : '';
}

type SelectorHost = Pick<SmartObjectManifest, 'uiSelectors'>;

/**
 * The selector slot registered for a model, or `undefined`. Hosts render the
 * package-owned component registered under `slot.slotId` for any
 * `@foreignKey` / `@crossPackageRef` field whose target is `qualifiedName`, and
 * fall back to a generic picker labelled by the model's display label field.
 *
 * Pass every manifest in scope; the first selector found wins.
 */
export function findSelectorFor(
  manifests: SelectorHost | readonly SelectorHost[],
  qualifiedName: QualifiedClassName | string,
): ManifestUISelector | undefined {
  const list = Array.isArray(manifests)
    ? (manifests as readonly SelectorHost[])
    : [manifests as SelectorHost];
  for (const manifest of list) {
    for (const selector of Object.values(manifest.uiSelectors ?? {})) {
      if (selector.selects === qualifiedName) return selector;
    }
  }
  return undefined;
}
