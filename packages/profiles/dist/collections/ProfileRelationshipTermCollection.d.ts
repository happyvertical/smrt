import { SmrtCollection } from '@smrt/core';
import { ProfileRelationshipTerm } from '../models/ProfileRelationshipTerm';
export declare class ProfileRelationshipTermCollection extends SmrtCollection<ProfileRelationshipTerm> {
    static readonly _itemClass: typeof ProfileRelationshipTerm;
    /**
     * Get all terms for a relationship
     *
     * @param relationshipId - The relationship UUID
     * @returns Array of ProfileRelationshipTerm instances
     */
    getByRelationship(relationshipId: string): Promise<ProfileRelationshipTerm[]>;
    /**
     * Get the active term for a relationship (no end date or future end date)
     *
     * @param relationshipId - The relationship UUID
     * @returns Active term or null
     */
    getActiveTerm(relationshipId: string): Promise<ProfileRelationshipTerm | null>;
    /**
     * Get all historical (ended) terms for a relationship
     *
     * @param relationshipId - The relationship UUID
     * @returns Array of ended ProfileRelationshipTerm instances
     */
    getHistoricalTerms(relationshipId: string): Promise<ProfileRelationshipTerm[]>;
}
//# sourceMappingURL=ProfileRelationshipTermCollection.d.ts.map