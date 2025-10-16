import { SmrtObjectOptions } from '../../../core/smrt/src';
/**
 * Options for creating a Tag instance
 */
export interface TagOptions extends SmrtObjectOptions {
    slug?: string;
    name?: string;
    context?: string;
    parentSlug?: string;
    level?: number;
    description?: string;
    metadata?: string | Record<string, any>;
}
/**
 * Options for creating a TagAlias instance
 */
export interface TagAliasOptions extends SmrtObjectOptions {
    tagSlug?: string;
    alias?: string;
    language?: string;
    context?: string;
}
/**
 * Tag metadata structure (flexible, application-specific)
 */
export interface TagMetadata {
    color?: string;
    backgroundColor?: string;
    icon?: string;
    emoji?: string;
    usageCount?: number;
    lastUsed?: string;
    trending?: boolean;
    featured?: boolean;
    sortOrder?: number;
    showInNav?: boolean;
    displayFormat?: string;
    aiGenerated?: boolean;
    confidence?: number;
    source?: string;
    reviewStatus?: string;
    [key: string]: any;
}
/**
 * Tag hierarchy result structure
 */
export interface TagHierarchy {
    ancestors: import('./tag').Tag[];
    current: import('./tag').Tag;
    descendants: import('./tag').Tag[];
}
//# sourceMappingURL=types.d.ts.map