/**
 * Fixtures for the mcp-advisor registry-backed tool tests.
 *
 * Importing this module triggers the `@smrt()` decorators, which register the
 * classes (with config) into the global ObjectRegistry. Field metadata is
 * populated from the generated test manifest at decoration time, so these
 * classes expose real fields via `ObjectRegistry.getFields(...)`.
 *
 * Each class deliberately exercises a different decorator-config shape so the
 * advisor handlers' branching (boolean vs object api/mcp, exclude lists,
 * hooks, custom methods, constraints) is covered.
 */

import { field } from '../../decorators/index.js';
import { SmrtObject } from '../../object.js';
import { smrt } from '../../registry.js';

/**
 * Rich object: object-form api/mcp with include lists, cli enabled, hooks,
 * a custom method, and fields carrying constraints (min/max/maxLength).
 */
@smrt({
  api: { include: ['list', 'get', 'create', 'update', 'archive'] },
  mcp: { include: ['list', 'get'] },
  cli: true,
  hooks: {
    beforeSave: 'validateAdvisor',
    afterSave: 'indexAdvisor',
  },
})
export class AdvisorRichProduct extends SmrtObject {
  @field({
    required: true,
    maxLength: 120,
    description: 'Product display name',
  })
  title: string = '';

  @field({ min: 0, max: 1000 })
  quantity: number = 0;

  @field({ default: 0.0 })
  rate: number = 0.0;

  /** A custom domain method that should surface in get-object-config. */
  async recalculate(): Promise<number> {
    return this.quantity * this.rate;
  }
}

/**
 * Boolean-config object: api/mcp enabled via `true`, cli disabled. Exercises
 * the boolean branches in list-registered-objects and get-object-config.
 */
@smrt({
  api: true,
  mcp: true,
  cli: false,
})
export class AdvisorBooleanWidget extends SmrtObject {
  @field({ required: true })
  label: string = '';
}

/**
 * Exclude-config object: api/mcp use `exclude` lists. Exercises the
 * preview-api-endpoints exclusion path and the `exclude !== undefined`
 * enabled-detection branch.
 */
@smrt({
  api: { exclude: ['delete'] },
  mcp: { exclude: ['delete'] },
})
export class AdvisorExcludeNote extends SmrtObject {
  @field({ required: true })
  body: string = '';
}
