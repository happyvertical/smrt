import { SmrtObject, SmrtObjectOptions } from '@smrt/core';
import { ProfileRelationshipTerm } from './ProfileRelationshipTerm';
export interface ProfileRelationshipOptions extends SmrtObjectOptions {
    fromProfileId?: string;
    toProfileId?: string;
    typeId?: string;
    contextProfileId?: string;
}
export declare class ProfileRelationship extends SmrtObject {
    fromProfileId: import('@smrt/core').Field;
    toProfileId: import('@smrt/core').Field;
    typeId: import('@smrt/core').Field;
    contextProfileId: import('@smrt/core').Field;
    terms: import('@smrt/core').Field;
    constructor(options?: ProfileRelationshipOptions);
    /**
     * Get the relationship type slug
     *
     * @returns The slug of the relationship type
     */
    getTypeSlug(): Promise<string>;
    /**
     * Add a term (time period) to this relationship
     *
     * @param startedAt - Start date of the term
     * @param endedAt - Optional end date of the term
     */
    addTerm(startedAt: Date, endedAt?: Date): Promise<void>;
    /**
     * End the current active term
     *
     * @param endedAt - End date for the term
     */
    endCurrentTerm(endedAt: Date): Promise<void>;
    /**
     * Get all terms for this relationship
     *
     * @returns Array of ProfileRelationshipTerm instances
     */
    getTerms(): Promise<ProfileRelationshipTerm[]>;
    /**
     * Get the active term (no end date)
     *
     * @returns Current term or null if none active
     */
    getActiveTerm(): Promise<ProfileRelationshipTerm | null>;
}
//# sourceMappingURL=ProfileRelationship.d.ts.map