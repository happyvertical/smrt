import { SmrtObject, SmrtObjectOptions } from '@smrt/core';
export interface ProfileRelationshipTermOptions extends SmrtObjectOptions {
    relationshipId?: string;
    startedAt?: Date;
    endedAt?: Date;
}
export declare class ProfileRelationshipTerm extends SmrtObject {
    relationshipId: import('@smrt/core').Field;
    startedAt: import('@smrt/core').Field;
    endedAt: import('@smrt/core').Field;
    constructor(options?: ProfileRelationshipTermOptions);
    /**
     * Check if this term is currently active
     *
     * @returns True if active (no end date or end date in future)
     */
    isActive(): boolean;
    /**
     * End this term
     *
     * @param endedAt - End date for the term (defaults to now)
     */
    end(endedAt?: Date): Promise<void>;
    /**
     * Get the duration of this term in days
     *
     * @returns Duration in days
     */
    getDurationDays(): number;
}
//# sourceMappingURL=ProfileRelationshipTerm.d.ts.map