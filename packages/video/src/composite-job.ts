/**
 * CompositeJob Model
 *
 * Tracks the progress of compositing a character video onto a scene background.
 */

import type { SmrtObjectOptions } from '@happyvertical/smrt-core';
import { SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

/**
 * Composite job status
 */
export type CompositeJobStatus =
  | 'pending'
  | 'removing_bg'
  | 'analyzing_light'
  | 'compositing'
  | 'complete'
  | 'failed';

/**
 * Composite job creation options
 */
export interface CompositeJobOptions extends SmrtObjectOptions {
  /** Character video asset ID (after lip-sync) */
  characterVideoAssetId?: string | null;

  /** Scene ID to composite onto */
  sceneId?: string | null;

  /** Viewpoint ID (for 360° scenes) */
  viewpointId?: string | null;

  /** Anchor point ID for placement */
  anchorPointId?: string | null;

  /** Character scale */
  scale?: number;

  /** Character position (normalized 0-1) */
  position?: { x: number; y: number };

  /** Job status */
  status?: CompositeJobStatus;

  /** Progress percentage (0-100) */
  progress?: number;

  /** Output video asset ID */
  outputAssetId?: string | null;

  /** Error message if failed */
  errorMessage?: string | null;

  /** Tenant ID for multi-tenant isolation */
  tenantId?: string | null;
}

/**
 * Composite job for tracking virtual production compositing
 *
 * @example
 * ```typescript
 * import { CompositeJob } from '@happyvertical/smrt-video';
 *
 * const job = new CompositeJob({
 *   characterVideoAssetId: 'asset-video-123',
 *   sceneId: 'scene-townhall',
 *   scale: 0.8,
 *   position: { x: 0.5, y: 0.7 },
 * });
 * await job.save();
 * ```
 */
@TenantScoped({ mode: 'optional' })
@smrt({
  tableStrategy: 'sti',
  api: {
    include: ['list', 'get', 'create', 'update'],
  },
  mcp: {
    include: ['list', 'get'],
  },
  cli: true,
})
export class CompositeJob extends SmrtObject {
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /** Character video asset ID (after lip-sync) */
  characterVideoAssetId: string | null = null;

  /** Scene ID to composite onto */
  sceneId: string | null = null;

  /** Viewpoint ID (for 360° scenes) */
  viewpointId: string | null = null;

  /** Anchor point ID for placement */
  anchorPointId: string | null = null;

  /** Character scale */
  scale: number = 1.0;

  /** Character position (normalized 0-1) */
  position: { x: number; y: number } = { x: 0.5, y: 0.5 };

  /** Job status */
  status: CompositeJobStatus = 'pending';

  /** Progress percentage (0-100) */
  progress: number = 0;

  /** Output video asset ID */
  outputAssetId: string | null = null;

  /** Error message if failed */
  errorMessage: string | null = null;

  constructor(options: CompositeJobOptions = {}) {
    super(options);

    if (options.characterVideoAssetId !== undefined)
      this.characterVideoAssetId = options.characterVideoAssetId;
    if (options.sceneId !== undefined) this.sceneId = options.sceneId;
    if (options.viewpointId !== undefined)
      this.viewpointId = options.viewpointId;
    if (options.anchorPointId !== undefined)
      this.anchorPointId = options.anchorPointId;
    if (options.scale !== undefined) this.scale = options.scale;
    if (options.position !== undefined) this.position = options.position;
    if (options.status !== undefined) this.status = options.status;
    if (options.progress !== undefined) this.progress = options.progress;
    if (options.outputAssetId !== undefined)
      this.outputAssetId = options.outputAssetId;
    if (options.errorMessage !== undefined)
      this.errorMessage = options.errorMessage;
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
  }

  /** Check if the job is complete */
  get isComplete(): boolean {
    return this.status === 'complete' && this.outputAssetId !== null;
  }

  /** Check if the job is in progress */
  get isProcessing(): boolean {
    return (
      this.status !== 'pending' &&
      this.status !== 'complete' &&
      this.status !== 'failed'
    );
  }
}
