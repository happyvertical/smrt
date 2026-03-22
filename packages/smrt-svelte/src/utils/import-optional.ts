/**
 * Load an optional dependency without forcing bundlers to statically include it.
 */
export async function importOptional<TModule = unknown>(
  moduleName: string,
): Promise<TModule> {
  const name = moduleName;
  return import(/* @vite-ignore */ name) as Promise<TModule>;
}
