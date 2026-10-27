import { storableText } from './json-storage.js';
/** Advisory model observations only; never verified OCR/source geometry. */
export interface ObservedImageRegions {
  version: 1;
  coordinateSpace: 'display-oriented';
  regions: {
    id: string;
    text: string;
    rect: [number, number, number, number];
  }[];
}
export function normalizeObservedImageRegions(
  value: unknown,
): ObservedImageRegions | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const object = value as Record<string, unknown>;
  if (
    object.version !== 1 ||
    object.coordinateSpace !== 'display-oriented' ||
    !Array.isArray(object.regions) ||
    object.regions.length > 64
  )
    return;
  const ids = new Set<string>();
  const regions: ObservedImageRegions['regions'] = [];
  for (const item of object.regions) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return;
    const r = item as Record<string, unknown>;
    if (
      typeof r.id !== 'string' ||
      !storableText(r.id) ||
      !r.id.trim() ||
      r.id.length > 64 ||
      ids.has(r.id) ||
      typeof r.text !== 'string' ||
      !storableText(r.text) ||
      !r.text.trim() ||
      r.text.length > 300 ||
      !validObservedRect(r.rect)
    )
      return;
    ids.add(r.id);
    regions.push({ id: r.id, text: r.text, rect: [...r.rect] });
  }
  return { version: 1, coordinateSpace: 'display-oriented', regions };
}
export function validObservedRect(
  value: unknown,
): value is [number, number, number, number] {
  return (
    Array.isArray(value) &&
    value.length === 4 &&
    value.every(
      (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1,
    ) &&
    value[2] > 0 &&
    value[3] > 0 &&
    value[0] + value[2] <= 1 &&
    value[1] + value[3] <= 1
  );
}
