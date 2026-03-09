/**
 * Inheritance resolution module for the SMRT ObjectRegistry.
 *
 * Extracted from registry.ts as part of issue #1006.
 */

import { ConfigurationError } from '../errors';
import type { SmrtObject } from '../object';

/**
 * Build inheritance chain by walking prototype chain
 *
 * Walks from child → parent → ... → SmrtObject, building array from base to child.
 * Stops at SmrtObject (the framework base class).
 */
export function buildInheritanceChain(ctor: typeof SmrtObject): string[] {
  const chain: string[] = [];
  const visited = new Set<Function>();
  let current: any = ctor;

  // Walk up the prototype chain
  while (current?.name) {
    if (current.name === 'SmrtObject') {
      break;
    }

    if (visited.has(current)) {
      throw ConfigurationError.circularInheritance(
        current.name,
        Array.from(chain),
      );
    }

    visited.add(current);
    chain.unshift(current.name);

    current = Object.getPrototypeOf(current);
  }

  return chain;
}
