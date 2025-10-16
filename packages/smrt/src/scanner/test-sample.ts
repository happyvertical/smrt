/**
 * Sample SMRT classes for testing the AST scanner
 */

import { SmrtObject } from '../object';

// Mock decorator function for testing
function smrt(_config?: any) {
  return (target: any) => target;
}

// Simple Content class
@smrt({
  api: {
    exclude: ['delete'],
  },
  mcp: {
    include: ['list', 'get', 'create'],
  },
  cli: true,
})
class Content extends SmrtObject {
  title = '';
  body?: string;
  status = 'draft';
  published = false;
  category = 'general';
  tags: string[] = [];

  async generateSummary(maxLength: number): Promise<string> {
    return this.body?.substring(0, maxLength) || '';
  }

  static findByCategory(_category: string) {
    // Static method example
    return [];
  }

  private validateContent(): boolean {
    return this.title.length > 0;
  }
}

// Simple Category class
@smrt()
class Category extends SmrtObject {
  name = '';
  description?: string;
  active = true;

  constructor(options: any) {
    super(options);
    Object.assign(this, options);
  }
}

// Test class with custom actions for AI agent workflows
@smrt({
  mcp: {
    include: ['list', 'get', 'research', 'report', 'analyze'],
  },
  api: {
    include: ['list', 'get', 'research', 'report'],
  },
})
class TestAgent extends SmrtObject {
  name = '';
  source = '';
  lastSynced?: Date;

  // Custom action methods
  async research(options: any = {}): Promise<any> {
    return {
      action: 'research',
      source: this.source,
      results: options.query
        ? `Research results for: ${options.query}`
        : 'General research complete',
      timestamp: new Date(),
    };
  }

  async report(options: any = {}): Promise<any> {
    return {
      action: 'report',
      type: options.type || 'summary',
      content: `Generated ${options.type || 'summary'} report for ${this.name}`,
      timestamp: new Date(),
    };
  }

  async analyze(options: any = {}): Promise<any> {
    return {
      action: 'analyze',
      analysis: `Analysis of ${this.name}: ${options.criteria || 'general analysis'}`,
      confidence: 0.85,
      timestamp: new Date(),
    };
  }

  // Standard method that should not appear in MCP tools
  private validateSource(): boolean {
    return this.source.length > 0;
  }
}

export { Content, Category, TestAgent };
