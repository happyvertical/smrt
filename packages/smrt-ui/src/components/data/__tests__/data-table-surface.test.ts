import { describe, expect, it } from 'vitest';
import type { DataSurfaceVisibleCommand } from '../data-surface.js';
import {
  DATA_TABLE_SURFACE_CONTROL_IDS,
  dataTableCommandFromDataSurfaceCommand,
} from '../data-table-surface.js';

const identity = { surfaceId: 'pin', kind: 'table' as const };

function command(
  controlId: string,
  payload?: DataSurfaceVisibleCommand['payload'],
): DataSurfaceVisibleCommand {
  return {
    version: 1,
    commandId: 'pin',
    identity,
    expectedRevision: 0,
    controlId,
    ...(payload === undefined ? {} : { payload }),
  };
}

/**
 * A minimal, valid payload for each canonical table controlId — proof that
 * `DATA_TABLE_SURFACE_CONTROL_IDS` names exactly the ids
 * `dataTableCommandFromDataSurfaceCommand` translates, not a superset or
 * subset. Consumers (e.g. `@happyvertical/smrt-svelte`'s
 * `mountListDataSurface`) rely on this enumeration to distinguish "a table
 * command whose payload failed to translate" from "a genuinely unknown
 * control" — drift here would silently break that distinction.
 */
const VALID_PAYLOADS: Record<string, DataSurfaceVisibleCommand['payload']> = {
  'set-search': { search: 'x' },
  'set-filters': { filters: [] },
  'set-sorting': { sorting: [] },
  'toggle-sorting': { columnId: 'title' },
  'set-page': { page: 1 },
  'set-page-size': { pageSize: 25 },
  'set-column-order': { columnIds: ['title'] },
  'set-column-visibility': { columns: [] },
  'set-selected-rows': { rowIds: [] },
  'toggle-row-selection': { rowId: 'a' },
  'set-expanded-rows': { rowIds: [] },
  'toggle-row-expansion': { rowId: 'a' },
  reset: undefined,
};

describe('DATA_TABLE_SURFACE_CONTROL_IDS', () => {
  it('names exactly the ids dataTableCommandFromDataSurfaceCommand translates', () => {
    for (const controlId of DATA_TABLE_SURFACE_CONTROL_IDS) {
      expect(
        dataTableCommandFromDataSurfaceCommand(
          command(controlId, VALID_PAYLOADS[controlId]),
        ),
        `expected controlId "${controlId}" to translate with its documented valid payload`,
      ).not.toBeNull();
    }
  });

  it('does not include a genuinely unknown/custom controlId', () => {
    expect(DATA_TABLE_SURFACE_CONTROL_IDS).not.toContain('refresh');
    expect(DATA_TABLE_SURFACE_CONTROL_IDS).not.toContain('focus');
    expect(
      dataTableCommandFromDataSurfaceCommand(command('a-bespoke-control')),
    ).toBeNull();
  });
});
