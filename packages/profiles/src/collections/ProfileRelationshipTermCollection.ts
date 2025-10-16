/**
 * ProfileRelationshipTermCollection - Collection manager for ProfileRelationshipTerm objects
 *
 * Provides querying for relationship terms (temporal data).
 */

import { SmrtCollection } from '@smrt/core';
import { ProfileRelationshipTerm } from '../models/ProfileRelationshipTerm';

export class ProfileRelationshipTermCollection extends SmrtCollection<ProfileRelationshipTerm> {
  static readonly _itemClass = ProfileRelationshipTerm;

  /**
   * Get all terms for a relationship
   *
   * @param relationshipId - The relationship UUID
   * @returns Array of ProfileRelationshipTerm instances
   */
  async getByRelationship(
    relationshipId: string,
  ): Promise<ProfileRelationshipTerm[]> {
    return await this.list({
      where: { relationshipId },
      orderBy: ['startedAt DESC'],
    });
  }

  /**
   * Get the active term for a relationship (no end date or future end date)
   *
   * @param relationshipId - The relationship UUID
   * @returns Active term or null
   */
  async getActiveTerm(
    relationshipId: string,
  ): Promise<ProfileRelationshipTerm | null> {
    const terms = await this.getByRelationship(relationshipId);

    for (const term of terms) {
      if (term.isActive()) {
        return term;
      }
    }

    return null;
  }

  /**
   * Get all historical (ended) terms for a relationship
   *
   * @param relationshipId - The relationship UUID
   * @returns Array of ended ProfileRelationshipTerm instances
   */
  async getHistoricalTerms(
    relationshipId: string,
  ): Promise<ProfileRelationshipTerm[]> {
    const terms = await this.getByRelationship(relationshipId);
    return terms.filter((term) => !term.isActive());
  }
}
