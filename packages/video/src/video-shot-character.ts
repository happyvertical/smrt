/**
 * VideoShotCharacter - Join model linking VideoShots to Characters
 *
 * Replaces the old single personalityProfileId FK on VideoContent.
 * Supports multiple characters per shot with role and ordering.
 */

import type { SmrtObjectOptions } from '@happyvertical/smrt-core';
import { foreignKey, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import { Character } from './character.js';
import { VideoShot } from './video-shot.js';

/**
 * Character role within a shot
 */
export type VideoShotCharacterRole = 'primary' | 'secondary' | 'background';

/**
 * VideoShotCharacter creation options
 */
export interface VideoShotCharacterOptions extends SmrtObjectOptions {
  /** Video shot ID */
  videoShotId?: string | null;

  /** Character ID */
  characterId?: string | null;

  /** Role of the character in this shot */
  role?: VideoShotCharacterRole;

  /** Order/layer position within the shot */
  position?: number;

  /** Tenant ID for multi-tenant isolation */
  tenantId?: string | null;
}

/**
 * Join model linking a VideoShot to a Character
 *
 * @example
 * ```typescript
 * import { VideoShotCharacter } from '@happyvertical/smrt-video';
 *
 * const link = new VideoShotCharacter({
 *   videoShotId: 'shot-123',
 *   characterId: 'char-456',
 *   role: 'primary',
 *   position: 0,
 * });
 * await link.save();
 * ```
 */
@TenantScoped({ mode: 'optional' })
@smrt({
  tableStrategy: 'sti',
  api: {
    include: ['list', 'get', 'create', 'delete'],
  },
  mcp: {
    include: ['list', 'get'],
  },
  cli: true,
})
export class VideoShotCharacter extends SmrtObject {
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /** Video shot ID */
  @foreignKey(() => VideoShot)
  videoShotId: string | null = null;

  /** Character ID */
  @foreignKey(() => Character)
  characterId: string | null = null;

  /** Role of the character in this shot */
  role: VideoShotCharacterRole = 'primary';

  /** Order/layer position within the shot */
  position: number = 0;

  constructor(options: VideoShotCharacterOptions = {}) {
    super(options);

    if (options.videoShotId !== undefined)
      this.videoShotId = options.videoShotId;
    if (options.characterId !== undefined)
      this.characterId = options.characterId;
    if (options.role !== undefined) this.role = options.role;
    if (options.position !== undefined) this.position = options.position;
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
  }
}
