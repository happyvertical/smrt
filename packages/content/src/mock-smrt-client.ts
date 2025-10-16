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

// Mock data store
const mockContents: ContentData[] = [
  {
    id: '1',
    title: 'Sample Article',
    description: 'A sample content article for demonstration',
    body: 'This is the main content body for the sample article. It demonstrates how content is stored and managed in the SMRT framework.',
    author: 'Demo Author',
    type: 'article',
    status: 'published',
    state: 'active',
    source: 'manual',
    url: null,
    fileKey: null,
    publish_date: new Date('2024-01-15').toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: '2',
    title: 'Web Content Extract',
    description: 'Content extracted from a web page',
    body: 'This content was extracted from a web page using the spider package. It shows how external content can be ingested and managed.',
    author: 'Web Scraper',
    type: 'mirror',
    status: 'draft',
    state: 'active',
    source: 'spider',
    url: 'https://example.com/article',
    fileKey: null,
    publish_date: new Date('2024-01-16').toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: '3',
    title: 'PDF Document Content',
    description: 'Content extracted from a PDF document',
    body: 'This content was extracted from a PDF document using the PDF processing capabilities. It demonstrates document ingestion workflows.',
    author: 'PDF Processor',
    type: 'document',
    status: 'published',
    state: 'highlighted',
    source: 'pdf',
    url: null,
    fileKey: 'documents/sample.pdf',
    publish_date: new Date('2024-01-17').toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
];

class MockApiClient {
  contents = {
    async list(): Promise<ApiResponse<ContentData[]>> {
      // Simulate API delay
      await new Promise((resolve) => setTimeout(resolve, 500));

      return {
        data: [...mockContents],
        success: true,
        message: 'Contents retrieved successfully',
      };
    },

    async get(id: string): Promise<ApiResponse<ContentData>> {
      await new Promise((resolve) => setTimeout(resolve, 200));

      const content = mockContents.find((c) => c.id === id);
      if (!content) {
        throw new Error(`Content with id ${id} not found`);
      }

      return {
        data: content,
        success: true,
        message: 'Content retrieved successfully',
      };
    },

    async create(
      contentData: Partial<ContentData>,
    ): Promise<ApiResponse<ContentData>> {
      await new Promise((resolve) => setTimeout(resolve, 300));

      const newContent: ContentData = {
        id: (mockContents.length + 1).toString(),
        title: contentData.title || 'Untitled Content',
        description: contentData.description || '',
        body: contentData.body || '',
        author: contentData.author || 'Unknown',
        type: contentData.type || 'article',
        status: contentData.status || 'draft',
        state: contentData.state || 'active',
        source: contentData.source || 'manual',
        url: contentData.url || null,
        fileKey: contentData.fileKey || null,
        publish_date: contentData.publish_date || new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        references: contentData.references || [],
      };

      mockContents.push(newContent);

      return {
        data: newContent,
        success: true,
        message: 'Content created successfully',
      };
    },

    async update(
      id: string,
      updates: Partial<ContentData>,
    ): Promise<ApiResponse<ContentData>> {
      await new Promise((resolve) => setTimeout(resolve, 300));

      const index = mockContents.findIndex((c) => c.id === id);
      if (index === -1) {
        throw new Error(`Content with id ${id} not found`);
      }

      const updatedContent = {
        ...mockContents[index],
        ...updates,
        updatedAt: new Date().toISOString(),
      };

      mockContents[index] = updatedContent;

      return {
        data: updatedContent,
        success: true,
        message: 'Content updated successfully',
      };
    },

    async delete(id: string): Promise<ApiResponse<void>> {
      await new Promise((resolve) => setTimeout(resolve, 200));

      const index = mockContents.findIndex((c) => c.id === id);
      if (index === -1) {
        throw new Error(`Content with id ${id} not found`);
      }

      mockContents.splice(index, 1);

      return {
        data: undefined as any,
        success: true,
        message: 'Content deleted successfully',
      };
    },
  };
}

export function createClient(_baseUrl = '/api/v1'): MockApiClient {
  return new MockApiClient();
}

export default createClient;
