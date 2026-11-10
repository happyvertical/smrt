import { ObjectRegistry } from '@happyvertical/smrt-core';
import {
  isApiActionEnabledForObject,
  MCPGenerator,
} from '@happyvertical/smrt-core/generators';
import { getTenantScopedConfig } from '@happyvertical/smrt-tenancy';
import { expect, it } from 'vitest';
import {
  PeriodTimecard,
  TimecardAdjustment,
  TimecardReopening,
} from '../rollup.js';

it('keeps timecards and append-only adjustments off all generated surfaces', async () => {
  const tools = await new MCPGenerator().generateTools();
  for (const model of [PeriodTimecard, TimecardAdjustment, TimecardReopening]) {
    const name = `@happyvertical/smrt-timesheets:${model.name}`;
    for (const action of [
      'list',
      'get',
      'create',
      'update',
      'delete',
    ] as const) {
      expect(isApiActionEnabledForObject(name, action)).toBe(false);
    }
    const config = ObjectRegistry.getConfig(name);
    expect(config.cli).toEqual({ include: [] });
    expect(config.mcp).toEqual({ include: [] });
    expect(getTenantScopedConfig(name)?.mode).toBe('required');
    ObjectRegistry.registerOverride(name, {
      api: false,
      mcp: false,
      cli: false,
      tenancy: { mode: 'required' },
    });
    expect(ObjectRegistry.getConfig(name).api).toBe(false);
    expect(ObjectRegistry.getConfig(name).cli).toBe(false);
    expect(ObjectRegistry.getConfig(name).mcp).toBe(false);
    expect(getTenantScopedConfig(name)?.mode).toBe('required');
    expect(
      // The collection's tools reach the same rows, so match its prefix too
      // (#3468: a model-only prefix missed `periodtimecardcollection_*`).
      tools.filter((tool) =>
        new RegExp(`^${model.name.toLowerCase()}(collection)?_`).test(
          tool.name,
        ),
      ),
    ).toEqual([]);
  }
});
