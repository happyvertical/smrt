/**
 * Label model - SMRT wrapper for repository labels
 *
 * Represents a label that can be applied to issues and PRs.
 */

import {
  foreignKey,
  SmrtObject,
  type SmrtObjectOptions,
  smrt,
} from '@happyvertical/smrt-core';

export interface LabelOptions extends SmrtObjectOptions {
  repositoryId?: string;
  name?: string;
  color?: string;
  description?: string;
}

@smrt({
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get', 'create'] },
  cli: { include: ['list', 'get', 'create', 'update', 'delete'] },
})
export class Label extends SmrtObject {
  /**
   * Repository this label belongs to
   */
  @foreignKey('Repository')
  repositoryId?: string;

  /**
   * Label name
   */
  name: string = '';

  /**
   * Label color (hex without #)
   */
  color: string = '';

  /**
   * Label description
   */
  description: string = '';

  constructor(options: LabelOptions = {}) {
    super(options);
    if (options.repositoryId !== undefined)
      this.repositoryId = options.repositoryId;
    if (options.name !== undefined) this.name = options.name;
    if (options.color !== undefined) this.color = options.color;
    if (options.description !== undefined)
      this.description = options.description;
  }

  /**
   * Check if this is a type label (bug, feature, etc.)
   */
  isTypeLabel(): boolean {
    const typePatterns = [
      /^type:/i,
      /^kind:/i,
      /^bug$/i,
      /^feature$/i,
      /^enhancement$/i,
      /^docs$/i,
      /^chore$/i,
    ];
    return typePatterns.some((p) => p.test(this.name));
  }

  /**
   * Check if this is a priority label
   */
  isPriorityLabel(): boolean {
    const priorityPatterns = [
      /^p[0-4]$/i,
      /^priority:/i,
      /^critical$/i,
      /^high$/i,
      /^medium$/i,
      /^low$/i,
    ];
    return priorityPatterns.some((p) => p.test(this.name));
  }

  /**
   * Check if this is a status label
   */
  isStatusLabel(): boolean {
    const statusPatterns = [
      /^status:/i,
      /^wip$/i,
      /^in.?progress$/i,
      /^blocked$/i,
      /^needs.?review$/i,
      /^ready$/i,
    ];
    return statusPatterns.some((p) => p.test(this.name));
  }

  /**
   * Get the label category
   *
   * @returns Category name
   */
  getCategory(): 'type' | 'priority' | 'status' | 'area' | 'other' {
    if (this.isTypeLabel()) return 'type';
    if (this.isPriorityLabel()) return 'priority';
    if (this.isStatusLabel()) return 'status';
    if (this.name.includes(':')) return 'area';
    return 'other';
  }

  /**
   * Parse priority level from label name
   *
   * @returns Priority level 0-4 or null
   */
  getPriorityLevel(): number | null {
    const match = this.name.match(/p([0-4])/i);
    if (match) {
      return parseInt(match[1], 10);
    }
    if (/critical/i.test(this.name)) return 0;
    if (/high/i.test(this.name)) return 1;
    if (/medium/i.test(this.name)) return 2;
    if (/low/i.test(this.name)) return 3;
    return null;
  }

  /**
   * Get label with # prefix for hex color
   */
  getHexColor(): string {
    return this.color.startsWith('#') ? this.color : `#${this.color}`;
  }

  /**
   * Create a label in the repository
   */
  async createInRepository(): Promise<void> {
    if (!this.repositoryId) {
      throw new Error('Label must have a repositoryId');
    }

    const { RepositoryCollection } = await import(
      '../collections/Repositories'
    );
    const collection = await RepositoryCollection.create(this.options);
    const repo = await collection.get({ id: this.repositoryId });

    if (!repo) {
      throw new Error(`Repository ${this.repositoryId} not found`);
    }

    const client = await repo.getClient();
    await client.createLabel({
      name: this.name,
      color: this.color,
      description: this.description,
    });

    await this.save();
  }

  /**
   * Update this label in the repository
   */
  async updateInRepository(): Promise<void> {
    if (!this.repositoryId) {
      throw new Error('Label must have a repositoryId');
    }

    const { RepositoryCollection } = await import(
      '../collections/Repositories'
    );
    const collection = await RepositoryCollection.create(this.options);
    const repo = await collection.get({ id: this.repositoryId });

    if (!repo) {
      throw new Error(`Repository ${this.repositoryId} not found`);
    }

    const client = await repo.getClient();
    await client.updateLabel(this.name, {
      name: this.name,
      color: this.color,
      description: this.description,
    });

    await this.save();
  }
}
