import { SmrtObject, SmrtObjectOptions } from '../../../../../core/smrt/src';
/**
 * Options for Product initialization
 */
export interface ProductOptions extends SmrtObjectOptions {
    name?: string;
    description?: string;
    category?: string;
    manufacturer?: string;
    model?: string;
    price?: number;
    inStock?: boolean;
    specifications?: Record<string, any>;
    tags?: string[];
}
/**
 * Product information for knowledge base queries
 */
export declare class Product extends SmrtObject {
    name: string;
    description: string;
    category: string;
    manufacturer: string;
    model: string;
    price: number;
    inStock: boolean;
    specifications: Record<string, any>;
    tags: string[];
    constructor(options?: ProductOptions);
    getSpecification(key: string): Promise<any>;
    updateSpecification(key: string, value: any): Promise<void>;
    static searchByText(_query: string): Promise<Product[]>;
    static findByManufacturer(_manufacturer: string): Promise<Product[]>;
}
//# sourceMappingURL=Product.d.ts.map