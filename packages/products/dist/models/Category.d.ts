import { SmrtObject, SmrtObjectOptions } from '../../../../../core/smrt/src';
/**
 * Options for Category initialization
 */
export interface CategoryOptions extends SmrtObjectOptions {
    name?: string;
    description?: string;
    parentId?: string;
    level?: number;
    productCount?: number;
    active?: boolean;
}
/**
 * Product knowledge base category for organizing product information
 */
export declare class Category extends SmrtObject {
    name: string;
    description: string;
    parentId?: string;
    level: number;
    productCount: number;
    active: boolean;
    constructor(options?: CategoryOptions);
    getProducts(): Promise<never[]>;
    getSubcategories(): Promise<never[]>;
    updateProductCount(): Promise<void>;
    static getRootCategories(): Promise<Category[]>;
}
//# sourceMappingURL=Category.d.ts.map