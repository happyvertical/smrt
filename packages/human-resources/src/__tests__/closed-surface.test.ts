import { ObjectRegistry } from '@happyvertical/smrt-core';
import {
  isApiActionEnabledForObject,
  MCPGenerator,
} from '@happyvertical/smrt-core/generators';
import { describe, expect, it } from 'vitest';
import {
  Employment,
  EmploymentChange,
  EmploymentChangeCollection,
  EmploymentCollection,
  EmploymentTerm,
  EmploymentTermCollection,
  HeldQualification,
  HeldQualificationChange,
  HeldQualificationChangeCollection,
  HeldQualificationCollection,
  Qualification,
  QualificationCollection,
} from '../index.js';
import * as write from '../write.js';

const PACKAGE = '@happyvertical/smrt-human-resources';
const MODELS = [
  Employment,
  EmploymentTerm,
  EmploymentChange,
  Qualification,
  HeldQualification,
  HeldQualificationChange,
];
const COLLECTIONS = [
  EmploymentCollection,
  EmploymentTermCollection,
  EmploymentChangeCollection,
  QualificationCollection,
  HeldQualificationCollection,
  HeldQualificationChangeCollection,
];
const ACTIONS = ['list', 'get', 'create', 'update', 'delete'] as const;

/** No generated operation: an empty include list, or the transport turned off. */
function closed(value: unknown): boolean {
  return (
    value === false ||
    (typeof value === 'object' &&
      value !== null &&
      Array.isArray((value as { include?: unknown }).include) &&
      (value as { include: unknown[] }).include.length === 0)
  );
}

describe('HR records are sensitive by default', () => {
  for (const model of MODELS) {
    it(`${model.name} requires a tenant and publishes no generated read or write`, () => {
      const name = `${PACKAGE}:${model.name}`;
      const config = ObjectRegistry.getConfig(model.name);
      expect(config.sensitive).toBe(true);
      // The collection's decorator merges over the model's, so `cli` reads
      // `false` instead of an empty include list; both publish nothing.
      for (const transport of ['api', 'mcp', 'cli'] as const)
        expect(closed(config[transport]), transport).toBe(true);
      for (const action of ACTIONS)
        expect(isApiActionEnabledForObject(name, action), action).toBe(false);
      expect(ObjectRegistry.getTenantScopedConfig(name)?.mode).toBe('required');
    });
  }

  for (const collection of COLLECTIONS) {
    it(`${collection.name} is registered closed, so its methods are not generated operations`, () => {
      const name = `${PACKAGE}:${collection.name}`;
      expect(ObjectRegistry.getClass(name), 'registered').toBeDefined();
      const config = ObjectRegistry.getConfig(name);
      for (const transport of ['api', 'mcp', 'cli'] as const)
        expect(closed(config[transport]), transport).toBe(true);
      for (const action of ACTIONS)
        expect(isApiActionEnabledForObject(name, action), action).toBe(false);
    });
  }

  it('inserts rows through one helper built on public core APIs, with no route into collection internals', () => {
    // `draftHr` used to cast its way to the collection's protected
    // `createUnsaved()`; the only insert path is now `insertHr`.
    expect(Object.keys(write).sort()).toEqual([
      'assertHrWrite',
      'hasHrWrite',
      'insertHr',
      'persistHr',
    ]);
  });

  it('generates no MCP tool for any employment or qualification model or collection', async () => {
    const tools = await new MCPGenerator({}).generateTools();
    expect(
      tools
        .map((tool) => tool.name)
        .filter((name) => /employ|qualif/i.test(name)),
    ).toEqual([]);
  });
});
