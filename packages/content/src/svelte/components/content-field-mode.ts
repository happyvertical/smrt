/**
 * Simple vs full editor fields.
 *
 * `full` (the default) keeps every field and the long-standing labels.
 * `simple` is for everyday editors — a title, the story, images, author,
 * summary and tags: it hides Type, State, URL, File key (and, in
 * ContentEditor, references), collapses the Details section, uses plain
 * labels, and marks optional fields "(optional)". A `fields` allow-list
 * overrides either mode's choice of fields.
 */
export type ContentFieldMode = 'simple' | 'full';

export type ContentStatusFieldName =
  | 'type'
  | 'state'
  | 'status'
  | 'publish_date';
export type ContentMetadataFieldName =
  | 'author'
  | 'description'
  | 'tags'
  | 'url'
  | 'fileKey';

export const SIMPLE_STATUS_FIELDS: readonly ContentStatusFieldName[] = [
  'status',
  'publish_date',
];
export const FULL_STATUS_FIELDS: readonly ContentStatusFieldName[] = [
  'type',
  'state',
  'status',
  'publish_date',
];
export const SIMPLE_METADATA_FIELDS: readonly ContentMetadataFieldName[] = [
  'author',
  'description',
  'tags',
];
export const FULL_METADATA_FIELDS: readonly ContentMetadataFieldName[] = [
  'author',
  'description',
  'tags',
  'url',
  'fileKey',
];

/** The fields to render: an explicit allow-list wins over the mode. */
export function resolveContentFields<T extends string>(
  mode: ContentFieldMode,
  fields: readonly T[] | undefined,
  simple: readonly T[],
  full: readonly T[],
): Set<T> {
  return new Set(fields ?? (mode === 'simple' ? simple : full));
}
