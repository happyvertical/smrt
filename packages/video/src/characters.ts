/**
 * CharacterCollection - Collection manager for Character instances
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { queryGlobal } from '@happyvertical/smrt-tenancy';
import { Character } from './character.js';

export class CharacterCollection extends SmrtCollection<Character> {
  static readonly _itemClass = Character;

  /** Find all characters belonging to a specific tenant */
  async findByTenant(tenantId: string): Promise<Character[]> {
    return (await this.list({ where: { tenantId } })) as Character[];
  }

  /**
   * Find all global characters (no tenant association).
   *
   * Routes through the shared tenant-global helper so it does not throw under
   * an active tenant context (an explicit `tenant_id IS NULL` filter would be
   * flagged as an isolation violation). (#1600)
   */
  async findGlobal(): Promise<Character[]> {
    return queryGlobal<Character>(this);
  }

  /** Find characters by performer */
  async findByPerformer(performerId: string): Promise<Character[]> {
    return (await this.list({ where: { performerId } })) as Character[];
  }

  /** Find characters that are ready for video generation */
  async findReady(): Promise<Character[]> {
    return (await this.list({ where: { status: 'ready' } })) as Character[];
  }
}
