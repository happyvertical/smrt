/**
 * Inheritance state derived while a parent was not yet registered.
 *
 * A class whose `extends` link does not resolve gets a partial chain (it ends
 * at the class itself, or at the last ancestor that resolved). That chain, the
 * fields merged from it, and a table name chosen from it hold only until the
 * registry changes: a parent that registers later must change all of them.
 *
 * The marker lives on the registration itself under a registered symbol, so
 * every copy of smrt-core loaded into one process (they share the registry
 * entries through `globalThis`) sees the same marker and none of them mistakes
 * a partial chain for a complete one.
 *
 * Internal: not re-exported from the package entry points.
 */
import { getRegistryGeneration } from './generation';
import type { RegisteredClass } from './types';

const PARTIAL_CHAIN = Symbol.for('smrt.registry.partialInheritanceChain');

type MarkedRegistration = RegisteredClass & { [PARTIAL_CHAIN]?: number };

/**
 * Registry generation at which a partial chain was computed for this class,
 * or `undefined` when its stored chain (if any) is complete.
 */
export function partialChainGeneration(
  registered: RegisteredClass,
): number | undefined {
  return (registered as MarkedRegistration)[PARTIAL_CHAIN];
}

/** Record that this class's stored chain is partial as of `generation`. */
export function markPartialChain(
  registered: RegisteredClass,
  generation: number,
): void {
  (registered as MarkedRegistration)[PARTIAL_CHAIN] = generation;
}

/** Record that this class's stored chain (if any) is complete. */
export function clearPartialChain(registered: RegisteredClass): void {
  delete (registered as MarkedRegistration)[PARTIAL_CHAIN];
}

/**
 * Table names an object or collection derived while its class's chain was
 * partial, keyed by the holder, with the generation they were derived at.
 */
const partialTableNames = new WeakMap<object, number>();
let anyPartialTableName = false;

/**
 * Note that `holder` just derived its table name from `registered`'s chain.
 * Only a derivation from a partial chain is tracked.
 */
export function rememberTableNameDerivation(
  holder: object,
  registered: RegisteredClass | undefined,
): void {
  if (!registered || partialChainGeneration(registered) === undefined) return;
  partialTableNames.set(holder, getRegistryGeneration());
  anyPartialTableName = true;
}

/**
 * Whether `holder` derived its table name from a partial chain and the registry
 * has changed since, so the name must be derived again. Consumes the record.
 */
export function tableNameDerivationIsStale(holder: object): boolean {
  if (!anyPartialTableName) return false;
  const generation = partialTableNames.get(holder);
  if (generation === undefined || generation === getRegistryGeneration()) {
    return false;
  }
  partialTableNames.delete(holder);
  return true;
}
