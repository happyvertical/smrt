/**
 * Cookbook v1: parse, validate and migrate (browser-safe; no Node imports).
 * Types live in `@happyvertical/smrt-types`; see `agents/cookbook.md`.
 */

export { parseRecipeExportRef } from './export-ref.js';
export * from './validate.js';

/** Browser-safe names shared by permission catalogs, MCP and assistant adapters. */
export const APP_TOOL_NAMES = [
  'app.describe',
  'app.addField',
  'app.renameField',
  'app.hideField',
  'app.showField',
  'app.removeField',
  'app.addList',
  'app.renameList',
  'app.removeList',
  'app.undo',
  'app.history',
] as const;
export type AppToolName = (typeof APP_TOOL_NAMES)[number];

/** Shared permission/tool metadata; importing names must not load the server adapter. */
export const COOKBOOK_TOOL_NAMES = [
  'recipes.search',
  'recipes.describe',
  'recipes.enable',
  'recipes.disable',
  'recipes.configure',
  'cookbook.listTemplates',
  'cookbook.apply',
  ...APP_TOOL_NAMES,
] as const;
export type CookbookToolName = (typeof COOKBOOK_TOOL_NAMES)[number];
