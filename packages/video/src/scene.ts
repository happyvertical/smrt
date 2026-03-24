/**
 * Scene Model
 *
 * Represents a virtual production scene (background environment).
 * Supports 360° panoramas, standard images, and video backgrounds.
 */

import type { Asset } from '@happyvertical/smrt-assets';
import type { SmrtObjectOptions } from '@happyvertical/smrt-core';
import { SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type { SceneAssetRole } from './scene-asset.js';
import {
  assertValidVideoAssetRole,
  assertValidVideoAssetSortOrder,
  legacyVideoAssetMetaTypes,
  listCanonicalOwnedAssetIds,
  listLegacyOwnedAssetIds,
  mergeOwnedAssetIds,
  resolveOwnedAssets,
} from './owned-asset-utils.js';

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

  private async getSceneAssetCollection() {
    const { SceneOwnedAssetCollection } = await import('./scene-assets.js');
    return SceneOwnedAssetCollection.create({ db: this.db });
  }

  private getLegacyFieldAssetIds(role?: SceneAssetRole): string[] {
    if (role === 'source') {
      return this.sourceAssetId ? [this.sourceAssetId] : [];
    }

    if (role === 'env-map') {
      return this.lightingProfile?.envMapAssetId
        ? [this.lightingProfile.envMapAssetId]
        : [];
    }

    if (role === 'viewpoint-extract') {
      return this.viewpoints
        .map((viewpoint) => viewpoint.extractedAssetId || null)
        .filter((assetId): assetId is string => Boolean(assetId));
    }

    return [
      this.sourceAssetId,
      this.lightingProfile?.envMapAssetId || null,
      ...this.viewpoints.map((viewpoint) => viewpoint.extractedAssetId || null),
    ].filter((assetId): assetId is string => Boolean(assetId));
  }

  private setLegacyFieldAssetId(
    role: SceneAssetRole,
    assetId: string,
  ): boolean {
    if (role === 'source') {
      if (this.sourceAssetId === assetId) {
        return false;
      }

      this.sourceAssetId = assetId;
      return true;
    }

    if (role === 'env-map') {
      if ((this.lightingProfile?.envMapAssetId || null) === assetId) {
        return false;
      }

      this.lightingProfile = {
        ...(this.lightingProfile || {}),
        envMapAssetId: assetId,
      };
      return true;
    }

    return false;
  }

  private clearLegacyFieldAssetId(
    assetId: string,
    role?: SceneAssetRole,
  ): boolean {
    let changed = false;

    if ((!role || role === 'source') && this.sourceAssetId === assetId) {
      this.sourceAssetId = null;
      changed = true;
    }

    if (
      (!role || role === 'env-map') &&
      this.lightingProfile?.envMapAssetId === assetId
    ) {
      this.lightingProfile = {
        ...(this.lightingProfile || {}),
        envMapAssetId: undefined,
      };
      changed = true;
    }

    if (!role || role === 'viewpoint-extract') {
      let viewpointChanged = false;
      const nextViewpoints = this.viewpoints.map((viewpoint) => {
        if (viewpoint.extractedAssetId !== assetId) {
          return viewpoint;
        }

        viewpointChanged = true;
        return {
          ...viewpoint,
          extractedAssetId: undefined,
        };
      });

      if (viewpointChanged) {
        this.viewpoints = nextViewpoints;
        changed = true;
      }
    }

    return changed;
  }

  async getAssets(role?: SceneAssetRole): Promise<Asset[]> {
    const canonicalAssetIds = this.id
      ? await listCanonicalOwnedAssetIds({
          tableName: 'scene_assets',
          loadLinks: async () =>
            (await this.getSceneAssetCollection()).getForScene(
              this.id as string,
              role,
            ),
        })
      : [];
    const legacyFieldAssetIds = this.getLegacyFieldAssetIds(role);
    const legacyOwnedAssetIds = this.id
      ? await listLegacyOwnedAssetIds({
          db: this.db,
          ownerColumn: 'scene_id',
          ownerId: this.id,
          role,
          metaTypes: legacyVideoAssetMetaTypes('SceneAsset'),
        })
      : [];

    return resolveOwnedAssets(
      this.db,
      this.tenantId,
      mergeOwnedAssetIds(
        canonicalAssetIds,
        legacyFieldAssetIds,
        legacyOwnedAssetIds,
      ),
    );
  }

  async getAssetByRole(role: SceneAssetRole): Promise<Asset | null> {
    const assets = await this.getAssets(role);
    return assets[0] || null;
  }

  async addAsset(
    asset: Asset,
    role: SceneAssetRole = 'source',
    sortOrder = 0,
  ): Promise<void> {
    if (!this.id || !asset.id) {
      throw new Error('Cannot associate unsaved scene or asset');
    }

    assertValidVideoAssetRole(role);
    assertValidVideoAssetSortOrder(sortOrder);

    const sceneAssets = await this.getSceneAssetCollection();
    await sceneAssets.attach(
      this.id,
      asset.id,
      role,
      sortOrder,
      this.tenantId,
    );

    if (this.setLegacyFieldAssetId(role, asset.id)) {
      await this.save();
    }
  }

  async removeAsset(assetId: string, role?: SceneAssetRole): Promise<void> {
    if (!this.id) {
      return;
    }

    const sceneAssets = await this.getSceneAssetCollection();
    await sceneAssets.detach(this.id, assetId, role);

    if (this.clearLegacyFieldAssetId(assetId, role)) {
      await this.save();
    }
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
