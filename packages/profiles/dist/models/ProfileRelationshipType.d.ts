import { SmrtObject, SmrtObjectOptions } from '../../../../core/smrt/src';
import { ReciprocalHandler } from '../types';
export interface ProfileRelationshipTypeOptions extends SmrtObjectOptions {
    slug?: string;
    name?: string;
    reciprocal?: boolean;
}
export declare class ProfileRelationshipType extends SmrtObject {
    name: any;
    reciprocal: any;
    constructor(options?: ProfileRelationshipTypeOptions);
    /**
     * Convenience method for slug-based lookup
     *
     * @param slug - The slug to search for
     * @returns ProfileRelationshipType instance or null if not found
     */
    static getBySlug(slug: string): Promise<ProfileRelationshipType | null>;
    /**
     * Register a custom reciprocal handler for a relationship type
     *
     * @param slug - The relationship type slug
     * @param handler - The handler function to execute when creating reciprocal relationship
     */
    static registerReciprocalHandler(slug: string, handler: ReciprocalHandler): void;
    /**
     * Get the reciprocal handler for a relationship type
     *
     * @param slug - The relationship type slug
     * @returns The handler function or undefined
     */
    static getReciprocalHandler(slug: string): ReciprocalHandler | undefined;
    /**
     * Check if a relationship type is reciprocal
     *
     * @param slug - The relationship type slug
     * @returns True if reciprocal, false otherwise
     */
    static isReciprocal(slug: string): Promise<boolean>;
}
//# sourceMappingURL=ProfileRelationshipType.d.ts.map