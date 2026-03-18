/**
 * Mock SMRT Client for Content Service - Temporary implementation for demo purposes
 *
 * This replaces the missing @smrt/client virtual module with a working implementation
 * that demonstrates the intended functionality.
 */

export interface ContentData {
  id?: string;
  references?: any;
  type?: any;
  fileKey?: any;
  author?: any;
  title?: any;
  description?: any;
  body?: any;
  publish_date?: any;
  url?: any;
  source?: any;
  status?: any;
  state?: any;
  createdAt?: string;
  updatedAt?: string;
}

export interface ApiResponse<T> {
  data: T;
  success: boolean;
  message?: string;
}

function getListData(payload: any): ContentData[] {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (Array.isArray(payload?.data)) {
    return payload.data;
  }

  if (Array.isArray(payload?.items)) {
    return payload.items;
  }

  return [];
}

function getItemData<T>(payload: T | { data?: T }): T {
  if (payload && typeof payload === 'object' && 'data' in payload) {
    return payload.data as T;
  }

  return payload as T;
}

class ApiClient {
  constructor(public baseUrl: string) {}

  contents = {
    list: async (): Promise<ApiResponse<ContentData[]>> => {
      const res = await fetch(`${this.baseUrl}/contents`);
      if (!res.ok) throw new Error(await res.text());
      const payload = await res.json();
      return { data: getListData(payload), success: true };
    },

    get: async (id: string): Promise<ApiResponse<ContentData>> => {
      const res = await fetch(`${this.baseUrl}/contents/${id}`);
      if (!res.ok) throw new Error(await res.text());
      const payload = await res.json();
      return { data: getItemData<ContentData>(payload), success: true };
    },

    create: async (
      contentData: Partial<ContentData>,
    ): Promise<ApiResponse<ContentData>> => {
      const res = await fetch(`${this.baseUrl}/contents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(contentData),
      });
      if (!res.ok) throw new Error(await res.text());
      const payload = await res.json();
      return { data: getItemData<ContentData>(payload), success: true };
    },

    update: async (
      id: string,
      updates: Partial<ContentData>,
    ): Promise<ApiResponse<ContentData>> => {
      const res = await fetch(`${this.baseUrl}/contents/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
      if (!res.ok) throw new Error(await res.text());
      const payload = await res.json();
      return { data: getItemData<ContentData>(payload), success: true };
    },

    delete: async (id: string): Promise<ApiResponse<void>> => {
      const res = await fetch(`${this.baseUrl}/contents/${id}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error(await res.text());
      return { data: undefined as any, success: true };
    },
  };
}

export function createClient(baseUrl = '/api/v1'): ApiClient {
  return new ApiClient(baseUrl);
}

export default createClient;
