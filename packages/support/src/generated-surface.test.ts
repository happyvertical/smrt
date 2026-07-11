/**
 * Generated-surface configuration tests (#1926): the case-side models expose
 * read-only generated API/CLI/MCP (writes go through the closed service
 * facade), configuration models expose full CRUD, and the intake dedup /
 * uniqueness contracts are carried by `conflictColumns` exactly as shipped.
 */

import { ObjectRegistry } from '@happyvertical/smrt-core';
import { describe, expect, it } from 'vitest';
// Import the package entry so every model registers.
import {
  SERVICE_TIME_ENTRY_STATUS_TRANSITIONS,
  SUPPORT_CASE_STATUS_TRANSITIONS,
} from './index.js';

type SurfaceConfig = {
  include?: string[];
};

function smrtConfigOf(className: string): {
  api?: SurfaceConfig | boolean;
  mcp?: SurfaceConfig | boolean;
  cli?: SurfaceConfig | boolean;
  conflictColumns?: string[];
} {
  const metadata = ObjectRegistry.getObjectMetadata(className);
  expect(metadata, `expected ${className} in the ObjectRegistry`).toBeTruthy();
  return (metadata?.config ?? {}) as ReturnType<typeof smrtConfigOf>;
}

function includeList(surface: SurfaceConfig | boolean | undefined): string[] {
  if (!surface || surface === true) return [];
  return surface.include ?? [];
}

const READ_ONLY_MODELS = [
  'SupportCase',
  'SupportInteraction',
  'SupportCaseEvent',
  'SupportWorkLink',
  'SupportAiRun',
  'SupportServiceTarget',
  'SupportEscalation',
  'ServiceTimeEntry',
  'SupportCharge',
  'SupportCompensation',
  // Commercial terms write only through the `support.manage-plans`-gated
  // SupportPlanAdminService — never via generated CRUD.
  'SupportPlan',
  'SupportCompensationPlan',
];

const FULL_CRUD_MODELS = [
  'SupportChannelBinding',
  'SupportPolicy',
  'SupportSpecialist',
  'SupportQualification',
  'SupportAvailability',
];

describe('generated surfaces', () => {
  it('keeps every case-side model read-only on API, CLI, and MCP', () => {
    for (const className of READ_ONLY_MODELS) {
      const config = smrtConfigOf(className);
      for (const surface of ['api', 'mcp', 'cli'] as const) {
        const ops = includeList(config[surface]);
        expect(ops, `${className}.${surface}`).toEqual(['list', 'get']);
      }
    }
  });

  it('exposes full CRUD APIs on configuration models', () => {
    for (const className of FULL_CRUD_MODELS) {
      const config = smrtConfigOf(className);
      expect(includeList(config.api), `${className}.api`).toEqual([
        'list',
        'get',
        'create',
        'update',
        'delete',
      ]);
      // Non-API surfaces stay read-only even for config models.
      expect(includeList(config.mcp), `${className}.mcp`).toEqual([
        'list',
        'get',
      ]);
    }
  });

  it('carries the intake and uniqueness contracts in conflictColumns', () => {
    expect(smrtConfigOf('SupportInteraction').conflictColumns).toEqual([
      'source_key',
    ]);
    expect(smrtConfigOf('SupportChannelBinding').conflictColumns).toEqual([
      'target_type',
      'target_id',
    ]);
    expect(smrtConfigOf('SupportPlan').conflictColumns).toEqual([
      'tenant_id',
      'plan_key',
    ]);
    expect(smrtConfigOf('SupportSpecialist').conflictColumns).toEqual([
      'tenant_id',
      'profile_id',
    ]);
    expect(smrtConfigOf('SupportQualification').conflictColumns).toEqual([
      'specialist_id',
      'project_id',
    ]);
    expect(smrtConfigOf('SupportServiceTarget').conflictColumns).toEqual([
      'case_id',
      'target_type',
      'cycle',
    ]);
    expect(smrtConfigOf('SupportCharge').conflictColumns).toEqual([
      'time_entry_id',
    ]);
    expect(smrtConfigOf('SupportCompensation').conflictColumns).toEqual([
      'time_entry_id',
    ]);
  });

  it('publishes coherent lifecycle maps', () => {
    // Every transition target is itself a known status.
    for (const [from, targets] of Object.entries(
      SUPPORT_CASE_STATUS_TRANSITIONS,
    )) {
      for (const to of targets) {
        expect(
          SUPPORT_CASE_STATUS_TRANSITIONS[to],
          `case ${from} → ${to}`,
        ).toBeDefined();
      }
    }
    for (const [from, targets] of Object.entries(
      SERVICE_TIME_ENTRY_STATUS_TRANSITIONS,
    )) {
      for (const to of targets) {
        expect(
          SERVICE_TIME_ENTRY_STATUS_TRANSITIONS[to],
          `time entry ${from} → ${to}`,
        ).toBeDefined();
      }
    }
    // Approved entries only exit through explicit correction.
    expect(SERVICE_TIME_ENTRY_STATUS_TRANSITIONS.approved).toEqual([
      'corrected',
    ]);
    expect(SERVICE_TIME_ENTRY_STATUS_TRANSITIONS.corrected).toEqual([]);
  });
});
