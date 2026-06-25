/**
 * Basic type definitions for UI components
 * These are standalone types that don't depend on SMRT virtual modules
 * to avoid Node.js dependency issues in federation builds
 */

export interface ProductData {
  id?: string;
  created_at?: string;
  updated_at?: string;
  name?: string;
  description?: string;
  category?: string;
  manufacturer?: string;
  model?: string;
  price?: number;
  inStock?: boolean;
  specifications?: Record<string, unknown>;
  tags?: string[];
}

export interface CategoryData {
  id?: string;
  created_at?: string;
  updated_at?: string;
  name?: string;
  description?: string;
  slug?: string;
  parentId?: string;
  level?: number;
  productCount?: number;
  active?: boolean;
}

export interface Request {
  params: Record<string, string>;
  query: Record<string, unknown>;
  json(): Promise<unknown>;
}

export interface Response {
  json(data: unknown, init?: { status?: number }): Response;
  status(code: number): Response;
}
