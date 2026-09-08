import {
  field,
  ObjectRegistry,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildReportDefinition } from '../compiler.js';
import { groupBy, report } from '../decorators.js';

describe('report field decorator compatibility', () => {
  beforeEach(() => {
    ObjectRegistry.clear();
  });

  afterEach(() => {
    ObjectRegistry.clear();
  });

  it('preserves group metadata stacked under an exact core field decorator', async () => {
    @smrt({
      packageName: '@fixture/report-source',
      tableName: 'decorator_compatibility_sources_2763',
    })
    class Source extends SmrtObject {
      @field({ type: 'text' })
      name = '';
    }

    @smrt({
      packageName: '@fixture/report-output',
      tableName: 'decorator_compatibility_reports_2763',
    })
    @report({ source: Source })
    class Report extends SmrtObject {
      @field({ type: 'text' })
      @groupBy('name')
      name = '';
    }

    expect(
      ObjectRegistry.getClassByConstructor(Report)?.fields.get('name'),
    ).toMatchObject({
      type: 'text',
      _meta: { __report: { kind: 'group', sourceColumn: 'name' } },
    });
    await expect(buildReportDefinition(Report)).resolves.toMatchObject({
      fields: [
        {
          fieldName: 'name',
          report: { kind: 'group', sourceColumn: 'name' },
        },
      ],
    });
  });
});
