/**
 * Test-only workload used to prove that one generated SvelteKit application
 * keeps the same domain surface under every supported runtime profile.
 *
 * This file is overlaid onto a copy of the shipped template by
 * `copyRuntimeProfileReference()`. It is intentionally not part of the
 * default template or the published template package.
 */

import {
  field,
  ObjectRegistry,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import {
  backgroundEligible,
  withBackgroundJobs,
} from '@happyvertical/smrt-jobs';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

/** The generated action contract shared by REST, CLI, MCP, and WebMCP. */
export const referenceWorkItemActionEffects = Object.freeze({
  prepareForReview: Object.freeze({
    effect: 'write' as const,
    idempotent: true,
    openWorld: false,
    requiresApproval: true,
  }),
  archive: Object.freeze({
    effect: 'destructive' as const,
    idempotent: true,
    openWorld: false,
    requiresApproval: true,
  }),
});

@TenantScoped({ mode: 'required' })
@smrt({
  // Collection persistence uses idempotent upserts; the normal UUID primary
  // key is the fixture's explicit conflict target.
  conflictColumns: ['id'],
  api: {
    include: [
      'list',
      'get',
      'create',
      'update',
      'delete',
      'prepareForReview',
      'archive',
    ],
    writable: ['title', 'status'],
    routes: {
      prepareForReview: {
        method: 'POST',
        effect: 'write',
        idempotent: true,
        openWorld: false,
      },
      archive: {
        method: 'DELETE',
        effect: 'destructive',
        idempotent: true,
        openWorld: false,
      },
    },
  },
  cli: {
    include: [
      'list',
      'get',
      'create',
      'update',
      'delete',
      'prepareForReview',
      'archive',
    ],
  },
  mcp: {
    include: [
      'list',
      'get',
      'create',
      'update',
      'delete',
      'prepareForReview',
      'archive',
    ],
  },
})
export class ReferenceWorkItem extends SmrtObject {
  @tenantId({ required: true })
  tenantId = '';

  @field({ required: true })
  title = '';

  @field({ required: true })
  status = 'draft';

  /** A deliberately integer-valued queue priority. */
  @field({ required: true, sqlType: 'INTEGER' })
  priority: number = 0;

  /**
   * The normal task-runner target. The background allowlist keeps this fixture
   * representative of an app that queues work without opening an arbitrary
   * method-dispatch surface.
   */
  @backgroundEligible()
  async prepareForReview(options: { marker: string }) {
    this.status = 'queued';
    await this.save();
    return { marker: options.marker, status: this.status };
  }

  /** Explicit destructive action kept separate from the queued task. */
  async archive() {
    this.status = 'archived';
    await this.save();
    return { status: this.status };
  }
}

export class ReferenceWorkItemCollection extends SmrtCollection<ReferenceWorkItem> {
  static readonly _itemClass = ReferenceWorkItem;
}

// The mixin mutates the normal model prototype, so normal collection hydration
// and generated transports use one class identity.
withBackgroundJobs(ReferenceWorkItem);
ObjectRegistry.registerCollection(
  'ReferenceWorkItem',
  ReferenceWorkItemCollection,
);
