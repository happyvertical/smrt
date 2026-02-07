/**
 * Scene Model
 *
 * Represents a virtual production scene (background environment).
 * Supports 360° panoramas, standard images, and video backgrounds.
 */

import type { SmrtObjectOptions } from '@happyvertical/smrt-core';
import { SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

/**
 * Viewpoint extracted from 360° scene
 */
export interface SceneViewpoint {
  /** Viewpoint identifier */
  id: string;

  /** Human-readable name */
  name: string;

  /** Horizontal rotation (-180 to 180°) */
  pan: number;

  /** Vertical rotation (-90 to 90°) */
  tilt: number;

  /** Field of view (60-120°) */
  fov: number;

  /** Generated rectilinear image asset ID */
  extractedAssetId?: string;

  /** Viewpoint-specific lighting profile */
  lightingProfile?: LightingProfile;
}

/**
 * Lighting profile for IC-Light matching
 */
export interface LightingProfile {
  /** Dominant light direction (normalized vector) */
  direction?: { x: number; y: number; z: number };

  /** Light color temperature (Kelvin) */
  colorTemperature?: number;

  /** Ambient light intensity (0-1) */
  ambientIntensity?: number;

  /** Key light intensity (0-1) */
  keyLightIntensity?: number;

  /** Shadow softness (0-1) */
  shadowSoftness?: number;

  /** Environment map asset ID for reflections */
  envMapAssetId?: string;
}

/**
 * Anchor point for character placement in scene
 */
export interface AnchorPoint {
  /** Anchor point identifier */
  id: string;

  /** Human-readable name */
  name: string;

  /** Position as normalized coordinates (0-1) */
  position: { x: number; y: number };

  /** Suggested character scale at this point */
  suggestedScale: number;

  /** Ground plane Y coordinate for perspective */
  groundY: number;

  /** Optional viewpoint this anchor belongs to */
  viewpointId?: string;
}

/**
 * Scene source type
 */
export type SceneSourceType =
  | 'image'
  | 'video'
  | 'panorama_360'
  | 'panorama_180';

/**
 * Scene projection type
 */
export type SceneProjection = 'equirectangular' | 'cubemap';

/**
 * Scene status
 */
export type SceneStatus = 'pending' | 'processing' | 'ready' | 'failed';

/**
 * Scene creation options
 */
export interface SceneOptions extends SmrtObjectOptions {
  /** Human-readable name */
  name?: string;

  /** Description */
  description?: string | null;

  /** Source media asset ID */
  sourceAssetId?: string | null;

  /** Type of source media */
  sourceType?: SceneSourceType;

  /** Projection type for panoramas */
  projection?: SceneProjection | null;

  /** Extracted camera angles from 360° panoramas */
  viewpoints?: SceneViewpoint[];

  /** Lighting analysis for IC-Light matching */
  lightingProfile?: LightingProfile | null;

  /** Location metadata */
  location?: {
    name: string;
    coordinates?: { lat: number; lng: number };
  } | null;

  /** Anchor points for character placement */
  anchorPoints?: AnchorPoint[];

  /** Scene status */
  status?: SceneStatus;

  /** Tenant ID for multi-tenant isolation */
  tenantId?: string | null;
}

/**
 * Scene for virtual production compositing
 *
 * Supports 360° panoramas, standard images, and video backgrounds
 * with viewpoint extraction, lighting analysis, and character placement.
 *
 * @example
 * ```typescript
 * import { Scene } from '@happyvertical/smrt-video';
 *
 * const scene = new Scene({
 *   name: 'Town Hall Exterior',
 *   sourceAssetId: 'asset-townhall-pano',
 *   sourceType: 'panorama_360',
 *   projection: 'equirectangular',
 * });
 * await scene.save();
 * ```
 */
@TenantScoped({ mode: 'optional' })
@smrt({
  tableStrategy: 'sti',
  api: {
    include: ['list', 'get', 'create', 'update', 'delete'],
  },
  mcp: {
    include: ['list', 'get'],
  },
  cli: true,
})
export class Scene extends SmrtObject {
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /** Human-readable name */
  name: string = '';

  /** Description */
  description: string | null = null;

  /** Source media asset ID */
  sourceAssetId: string | null = null;

  /** Type of source media */
  sourceType: SceneSourceType = 'image';

  /** Projection type for panoramas */
  projection: SceneProjection | null = null;

  /** Extracted camera angles from 360° panoramas */
  viewpoints: SceneViewpoint[] = [];

  /** Lighting analysis for IC-Light matching */
  lightingProfile: LightingProfile | null = null;

  /** Location metadata */
  location: {
    name: string;
    coordinates?: { lat: number; lng: number };
  } | null = null;

  /** Anchor points for character placement */
  anchorPoints: AnchorPoint[] = [];

  /** Scene status */
  status: SceneStatus = 'pending';

  constructor(options: SceneOptions = {}) {
    super(options);

    if (options.name !== undefined) this.name = options.name;
    if (options.description !== undefined)
      this.description = options.description;
    if (options.sourceAssetId !== undefined)
      this.sourceAssetId = options.sourceAssetId;
    if (options.sourceType !== undefined) this.sourceType = options.sourceType;
    if (options.projection !== undefined) this.projection = options.projection;
    if (options.viewpoints !== undefined) this.viewpoints = options.viewpoints;
    if (options.lightingProfile !== undefined)
      this.lightingProfile = options.lightingProfile;
    if (options.location !== undefined) this.location = options.location;
    if (options.anchorPoints !== undefined)
      this.anchorPoints = options.anchorPoints;
    if (options.status !== undefined) this.status = options.status;
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
  }

  /** Check if this is a 360° panorama */
  get isPanorama(): boolean {
    return (
      this.sourceType === 'panorama_360' || this.sourceType === 'panorama_180'
    );
  }

  /** Check if the scene has viewpoints extracted */
  get hasViewpoints(): boolean {
    return this.viewpoints.length > 0;
  }

  /** Check if the scene is ready for compositing */
  get isReady(): boolean {
    return this.status === 'ready' && this.sourceAssetId !== null;
  }
}
