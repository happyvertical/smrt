import type { Blueprint } from './types.ts';

export const EXPORT_FILENAME = 'smrt-blueprint.json';

export function serializeBlueprint(blueprint: Blueprint): string {
  return `${JSON.stringify(blueprint, null, 2)}\n`;
}

/** Offer the blueprint as a `smrt-blueprint.json` download. */
export function downloadBlueprint(blueprint: Blueprint): void {
  const url = URL.createObjectURL(
    new Blob([serializeBlueprint(blueprint)], { type: 'application/json' }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = EXPORT_FILENAME;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
