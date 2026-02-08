/**
 * CharacterCollection - Collection manager for Character instances
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { Character } from './character.js';

export class CharacterCollection extends SmrtCollection<Character> {
  static readonly _itemClass = Character;

  /** Find all characters belonging to a specific tenant */
  async findByTenant(tenantId: string): Promise<Character[]> {
    return (await this.list({ where: { tenantId } })) as Character[];
  }

  /** Find all global characters (without a tenant) */
  async findGlobal(): Promise<Character[]> {
    return (await this.list({ where: { tenantId: null } })) as Character[];
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
