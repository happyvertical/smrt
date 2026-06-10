/**
 * Video Workflow Model
 *
 * Manages ComfyUI workflow templates for video generation.
 */

import { createLogger } from '@happyvertical/logger';
import type { SmrtObjectOptions } from '@happyvertical/smrt-core';
import { SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

const logger = createLogger({ level: 'info' });

/**
 * Node mapping for dynamic parameter injection
 */
export interface NodeMapping {
  /**
   * Node ID for anchor seed image input
   */
  seedImage?: string;

  /**
   * Node ID for TTS audio input
   */
  audioFile?: string;

  /**
   * Node ID for base motion video input
   */
  baseVideo?: string;

  /**
   * Node ID for final video output
   */
  outputVideo?: string;

  /**
   * Node ID for text prompt input
   */
  prompt?: string;

  /**
   * Node ID for negative prompt input
   */
  negativePrompt?: string;

  /**
   * Node ID for sampler/scheduler settings
   */
  sampler?: string;

  /**
   * Node ID for video duration control
   */
  duration?: string;

  /**
   * Additional custom node mappings
   */
  [key: string]: string | undefined;
}

/**
 * Workflow type classification
 */
export type WorkflowType =
  | 'prebake'
  | 'broadcast'
  | 'lipsync'
  | 'postprod'
  | 'custom';

/**
 * Video workflow creation options
 */
export interface VideoWorkflowOptions extends SmrtObjectOptions {
  /**
   * Human-readable name for the workflow
   */
  name?: string;

  /**
   * Description of what this workflow does
   */
  description?: string | null;

  /**
   * Workflow type classification
   * @default 'custom'
   */
  workflowType?: WorkflowType;

  /**
   * ComfyUI API format JSON
   */
  workflowJson?: object | null;

  /**
   * Node ID mappings for dynamic parameter injection
   */
  nodeMapping?: NodeMapping;

  /**
   * Estimated processing time in seconds
   */
  estimatedTime?: number;

  /**
   * Whether this workflow is active/usable
   * @default true
   */
  isActive?: boolean;

  /**
   * ComfyUI models required by this workflow
   */
  requiredModels?: string[];

  /**
   * Tenant ID for multi-tenant isolation
   */
  tenantId?: string | null;
}

/**
 * ComfyUI workflow template for video generation
 *
 * VideoWorkflow stores ComfyUI workflow definitions with node mappings
 * for dynamic parameter injection. This allows the Histrio agent to
 * inject anchor images, audio, and other inputs at runtime.
 *
 * @example
 * ```typescript
 * import { VideoWorkflow } from '@happyvertical/smrt-video';
 *
 * const workflow = new VideoWorkflow({
 *   name: 'Wan 2.6 + EchoMimic',
 *   description: 'Full broadcast generation with lip-sync',
 *   workflowType: 'broadcast',
 *   workflowJson: comfyuiWorkflowJson,
 *   nodeMapping: {
 *     seedImage: '1',
 *     audioFile: '5',
 *     outputVideo: '12',
 *   },
 *   estimatedTime: 600, // 10 minutes
 *   requiredModels: ['wan_2.6_t2v_14b_fp8', 'echomimic_v2'],
 * });
 * await workflow.save();
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
export class VideoWorkflow extends SmrtObject {
  /**
   * Tenant ID for multi-tenant isolation
   */
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /**
   * Human-readable name for the workflow
   */
  name: string = '';

  /**
   * Description of what this workflow does
   */
  description: string | null = null;

  /**
   * Workflow type classification
   * - prebake: Pre-generate base motion from seed image
   * - broadcast: Full video generation pipeline
   * - lipsync: Lip-sync only (requires base video + audio)
   * - postprod: Post-production overlays and effects
   * - custom: User-defined workflow
   */
  workflowType: WorkflowType = 'custom';

  /**
   * ComfyUI API format JSON
   * This is the workflow definition that will be sent to ComfyUI
   */
  workflowJson: object | null = null;

  /**
   * Node ID mappings for dynamic parameter injection
   * Maps semantic names to ComfyUI node IDs
   */
  nodeMapping: NodeMapping = {};

  /**
   * Estimated processing time in seconds
   * Used for progress estimation
   */
  estimatedTime: number = 300;

  /**
   * Whether this workflow is active/usable
   */
  isActive: boolean = true;

  /**
   * ComfyUI models required by this workflow
   * Used for validation before queuing
   */
  requiredModels: string[] = [];

  constructor(options: VideoWorkflowOptions = {}) {
    super(options);

    if (options.name !== undefined) this.name = options.name;
    if (options.description !== undefined)
      this.description = options.description;
    if (options.workflowType !== undefined)
      this.workflowType = options.workflowType;
    if (options.workflowJson !== undefined)
      this.workflowJson = options.workflowJson;
    if (options.nodeMapping !== undefined)
      this.nodeMapping = options.nodeMapping;
    if (options.estimatedTime !== undefined)
      this.estimatedTime = options.estimatedTime;
    if (options.isActive !== undefined) this.isActive = options.isActive;
    if (options.requiredModels !== undefined)
      this.requiredModels = options.requiredModels;
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
  }

  /**
   * Check if the workflow has all required node mappings
   */
  get hasRequiredMappings(): boolean {
    const required = ['outputVideo'];
    return required.every((key) => this.nodeMapping[key] !== undefined);
  }

  /**
   * Get a copy of the workflow JSON with injected parameters
   *
   * Parameter injection follows ComfyUI node structure conventions:
   * - seedImage, audioFile, baseVideo → node.inputs.image (file path)
   * - prompt → node.inputs.text (string)
   * - Other parameters → node.inputs[paramKey]
   *
   * @param params - Key-value pairs of parameters to inject
   * @returns Modified workflow JSON or null if no workflowJson set
   */
  injectParameters(params: Record<string, any>): object | null {
    if (!this.workflowJson) return null;

    const workflow = JSON.parse(JSON.stringify(this.workflowJson));
    const warnings: string[] = [];

    for (const [paramKey, nodeId] of Object.entries(this.nodeMapping)) {
      if (nodeId && params[paramKey] !== undefined) {
        // Validate nodeId exists in workflow
        if (!workflow[nodeId]) {
          warnings.push(
            `Node mapping '${paramKey}' references node '${nodeId}' which does not exist in workflow`,
          );
          continue;
        }

        // Inject parameter into the node
        workflow[nodeId].inputs = workflow[nodeId].inputs || {};

        // Map parameters to ComfyUI node input field names
        if (
          paramKey === 'seedImage' ||
          paramKey === 'audioFile' ||
          paramKey === 'baseVideo'
        ) {
          workflow[nodeId].inputs.image = params[paramKey];
        } else if (paramKey === 'prompt') {
          workflow[nodeId].inputs.text = params[paramKey];
        } else {
          workflow[nodeId].inputs[paramKey] = params[paramKey];
        }
      }
    }

    // Log warnings if any (in development)
    if (warnings.length > 0 && process.env.NODE_ENV !== 'production') {
      logger.warn(
        `[VideoWorkflow] Parameter injection warnings:\n${warnings.join('\n')}`,
      );
    }

    return workflow;
  }
}
