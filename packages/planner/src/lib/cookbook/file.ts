import type { Cookbook } from './types.ts';

export const DEFAULT_EXPORT_NAME = 'my-app';

/** A name reduced to a file- and directory-safe slug; empty when nothing survives. */
export function slugify(name?: string): string {
  return (name ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** `<name>.cookbook.json`, with the name reduced to a safe slug. */
export function exportFileName(name?: string): string {
  return `${slugify(name) || DEFAULT_EXPORT_NAME}.cookbook.json`;
}

/** The bytes of the file `downloadCookbook` writes. */
export function exportFileSize(cookbook: Cookbook): number {
  return new TextEncoder().encode(serializeCookbook(cookbook)).length;
}

/** "3.6 KB" / "12 KB" / "640 bytes", for a note beside a file or a prompt. */
export function formatSize(bytes: number): string {
  if (bytes < 1000) return `${bytes} bytes`;
  const kb = bytes / 1024;
  return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
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
