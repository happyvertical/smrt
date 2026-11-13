/**
 * Optional installed-surface port. The existing SMRT consumer plugin replaces
 * this module with its manifest-derived web module; plain Svelte hosts retain
 * an empty resolver and the generic screens.
 */
import type {
  RecipeSurface,
  RecipeSurfaceLoadContext,
} from '@happyvertical/smrt-types';

/** No component imports without a host generation plugin. */
export const recipeSurfaces: Readonly<
  Partial<
    Record<
      string,
      readonly {
        surface: RecipeSurface;
        load: (context?: RecipeSurfaceLoadContext) => Promise<unknown>;
      }[]
    >
  >
> = Object.freeze({});

/** Missing installed surfaces use the generic screen fallback. */
export async function resolveExport(
  _specifier: string,
  _exportName: string,
  _context?: RecipeSurfaceLoadContext,
): Promise<unknown> {
  return undefined;
}
