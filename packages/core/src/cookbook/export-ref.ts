/** Browser-safe manifest export-reference parsing, shared by build and UI consumers. */
import type { RecipeExportRef } from '@happyvertical/smrt-types';

/** Split `'<specifier>#<Name>'`; refuses relative and absolute specifiers. */
export function parseRecipeExportRef(
  ref: RecipeExportRef | string,
): { specifier: string; exportName: string } | null {
  const at = ref.lastIndexOf('#');
  if (at <= 0 || at === ref.length - 1) return null;
  const specifier = ref.slice(0, at);
  const exportName = ref.slice(at + 1);
  if (specifier.startsWith('.') || specifier.startsWith('/')) return null;
  if (/\s/.test(specifier) || !/^[A-Za-z_$][\w$]*$/.test(exportName)) {
    return null;
  }
  return { specifier, exportName };
}
