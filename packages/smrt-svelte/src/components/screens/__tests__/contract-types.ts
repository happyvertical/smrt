/**
 * Compile the consumer's actual public barrel, including the smrt-start
 * multiple-inheritance shape that failed in the packed planner release gate.
 * Kept outside *.test.ts so package typecheck includes these assertions.
 */
import type {
  createRecipeScreenEntry,
  createRecipeScreenReferences,
  createRecipeScreensSource,
  RecipeScreensProps,
  ScreenCollectionDefinition,
} from '../index.js';

// The smrt-start REST boundary requires both fields. The transport-neutral
// screen contract must compose with it without redefining them as optional.
interface RestCollection {
  endpoint: string;
  idField?: string;
  actions: readonly string[];
}

export interface EntryDefinition
  extends RestCollection,
    ScreenCollectionDefinition {}

export const sourceAcceptsEntry = (
  definition: EntryDefinition,
): Parameters<typeof createRecipeScreensSource>[0] => definition;
export const entryAcceptsDefinitions = (
  definitions: Readonly<Record<string, EntryDefinition>>,
): Parameters<typeof createRecipeScreenEntry>[0] => definitions;
export const referencesAcceptDefinitions = (
  definitions: Readonly<Record<string, EntryDefinition>>,
): Parameters<typeof createRecipeScreenReferences>[0] => definitions;
export const screensAcceptDefinitions = (
  definitions: Readonly<Record<string, EntryDefinition>>,
): RecipeScreensProps['definitions'] => definitions;

export const transportNeutralDefinition: ScreenCollectionDefinition = {
  objectRef: '@test/records:Record',
  className: 'Record',
  fields: {},
};
