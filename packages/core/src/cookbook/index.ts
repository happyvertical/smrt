/**
 * Cookbook v1: parse, validate and migrate (browser-safe; no Node imports).
 * Types live in `@happyvertical/smrt-types`; see `agents/cookbook.md`.
 */

export { parseRecipeExportRef } from './export-ref.js';
export * from './validate.js';

/** Shared permission/tool metadata; importing names must not load the server adapter. */
export const COOKBOOK_TOOL_NAMES = [
  'recipes.search',
  'recipes.describe',
  'recipes.enable',
  'recipes.disable',
  'recipes.configure',
  'cookbook.listTemplates',
  'cookbook.apply',
] as const;
export type CookbookToolName = (typeof COOKBOOK_TOOL_NAMES)[number];
