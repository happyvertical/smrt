import { SmrtObject, SmrtObjectOptions } from '@smrt/core';
import { ValidationSchema, ValidatorFunction } from '../types';
export interface ProfileMetafieldOptions extends SmrtObjectOptions {
    slug?: string;
    name?: string;
    description?: string;
    validation?: ValidationSchema;
}
export declare class ProfileMetafield extends SmrtObject {
    name: import('@smrt/core').Field;
    description: import('@smrt/core').Field;
    validation: import('@smrt/core').Field;
    constructor(options?: ProfileMetafieldOptions);
    /**
     * Convenience method for slug-based lookup
     *
     * @param slug - The slug to search for
     * @returns ProfileMetafield instance or null if not found
     */
    static getBySlug(_slug: string): Promise<ProfileMetafield | null>;
    /**
     * Register a custom validator function
     *
     * @param name - Name of the validator (used in validation.custom field)
     * @param validator - The validator function
     */
    static registerValidator(name: string, validator: ValidatorFunction): void;
    /**
     * Get a registered custom validator
     *
     * @param name - Name of the validator
     * @returns The validator function or undefined
     */
    static getValidator(name: string): ValidatorFunction | undefined;
    /**
     * Validate a value against this metafield's validation schema
     *
     * @param value - The value to validate
     * @returns True if valid, throws ValidationError if invalid
     */
    validateValue(value: any): Promise<boolean>;
}
//# sourceMappingURL=ProfileMetafield.d.ts.map