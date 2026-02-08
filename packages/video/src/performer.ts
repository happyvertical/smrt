/**
 * Performer Model
 *
 * Represents the physical likeness/face DNA for consistent face generation.
 * A Performer can play multiple Characters (PersonalityProfiles).
 * Ensures face consistency via IP-Adapter FaceID.
 */

import type { SmrtObjectOptions } from '@happyvertical/smrt-core';
import { foreignKey, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { Profile } from '@happyvertical/smrt-profiles';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

/**
 * Performer DNA for IP-Adapter FaceID consistency
 */
export interface PerformerDNA {
  /** Gender */
  gender: 'male' | 'female' | 'neutral';

  /** Age range */
  ageRange:
    | 'child'
    | 'teen'
    | 'young_adult'
    | 'adult'
    | 'middle_aged'
    | 'senior';

  /** Face embedding for IP-Adapter FaceID (512-dim vector) */
  faceEmbedding?: number[];

  /** Default clothing style (can be overridden per Character) */
  defaultClothing?: {
    style: 'business' | 'casual' | 'formal' | 'outdoor';
    colors?: string[];
    description?: string;
  };

  /** IP-Adapter weight for consistency (0.5-1.0) */
  ipAdapterWeight: number;

  /** FaceID weight for face consistency */
  faceIdWeight?: number;
}

/**
 * Performer status
 */
export type PerformerStatus = 'pending' | 'ready';

/**
 * Performer creation options
 */
export interface PerformerOptions extends SmrtObjectOptions {
  /** Human-readable name */
  name?: string;

  /** Description */
  description?: string | null;

  /** Performer DNA for consistent face generation */
  dna?: PerformerDNA;

  /** Reference images for IP-Adapter (multiple angles/expressions) */
  referenceAssetIds?: string[];

  /** Generated seed image asset ID */
  seedImageAssetId?: string | null;

  /** Default voice profile for this performer */
  voiceProfileId?: string | null;

  /** Performer status */
  status?: PerformerStatus;

  /** 1-1 profile record for this performer */
  profileId?: string | null;

  /** Tenant ID for multi-tenant isolation */
  tenantId?: string | null;
}

/**
 * Performer - The physical likeness/face DNA
 *
 * A Performer represents a person's visual identity for consistent
 * face generation across multiple Characters. One Performer can play
 * many Characters (e.g., same face as "Evening Anchor" and "Weekend Host").
 *
 * @example
 * ```typescript
 * import { Performer } from '@happyvertical/smrt-video';
 *
 * const performer = new Performer({
 *   name: 'Alex Bentley',
 *   dna: {
 *     gender: 'male',
 *     ageRange: 'adult',
 *     ipAdapterWeight: 0.75,
 *   },
 *   referenceAssetIds: ['ref-img-1', 'ref-img-2'],
 * });
 * await performer.save();
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
export class Performer extends SmrtObject {
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /** Human-readable name */
  name: string = '';

  /** Description */
  description: string | null = null;

  /** Performer DNA for consistent face generation */
  dna: PerformerDNA = {
    gender: 'neutral',
    ageRange: 'adult',
    ipAdapterWeight: 0.7,
  };

  /** Reference images for IP-Adapter (multiple angles/expressions) */
  referenceAssetIds: string[] = [];

  /** Generated seed image asset ID */
  seedImageAssetId: string | null = null;

  /** Default voice profile for this performer */
  voiceProfileId: string | null = null;

  /** Performer status */
  status: PerformerStatus = 'pending';

  /** 1-1 profile record for this performer */
  @foreignKey(() => Profile)
  profileId: string | null = null;

  constructor(options: PerformerOptions = {}) {
    super(options);

    if (options.name !== undefined) this.name = options.name;
    if (options.description !== undefined)
      this.description = options.description;
    if (options.dna !== undefined) this.dna = options.dna;
    if (options.referenceAssetIds !== undefined)
      this.referenceAssetIds = options.referenceAssetIds;
    if (options.seedImageAssetId !== undefined)
      this.seedImageAssetId = options.seedImageAssetId;
    if (options.voiceProfileId !== undefined)
      this.voiceProfileId = options.voiceProfileId;
    if (options.status !== undefined) this.status = options.status;
    if (options.profileId !== undefined) this.profileId = options.profileId;
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
  }

  /** Check if the performer has reference images */
  get hasReferences(): boolean {
    return this.referenceAssetIds.length > 0;
  }

  /** Check if the performer has a face embedding */
  get hasFaceEmbedding(): boolean {
    return (
      Array.isArray(this.dna.faceEmbedding) && this.dna.faceEmbedding.length > 0
    );
  }

  /** Check if the performer is ready for generation */
  get isReady(): boolean {
    return this.status === 'ready' && this.hasReferences;
  }
}
