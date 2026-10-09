import type { Cookbook } from './types.ts';

export const DEFAULT_EXPORT_NAME = 'my-app';

/** `<name>.cookbook.json`, with the name reduced to a safe slug. */
export function exportFileName(name?: string): string {
  const slug = (name ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${slug || DEFAULT_EXPORT_NAME}.cookbook.json`;
}

export function serializeCookbook(cookbook: Cookbook): string {
  return `${JSON.stringify(cookbook, null, 2)}\n`;
}

/** Offer the cookbook as a `<name>.cookbook.json` download. */
export function downloadCookbook(cookbook: Cookbook, name?: string): void {
  const url = URL.createObjectURL(
    new Blob([serializeCookbook(cookbook)], { type: 'application/json' }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = exportFileName(name);
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
