import { SmrtCollection } from '@happyvertical/smrt-core';
import type { Content } from './content';
import type { CreateContentVersionOptions } from './content-governance';
import { ContentVersion } from './content-version';

export class ContentVersionCollection extends SmrtCollection<ContentVersion> {
  static readonly _itemClass = ContentVersion;

  async listForContent(contentId: string): Promise<ContentVersion[]> {
    return this.list({
      where: { contentId },
      orderBy: 'version ASC',
    });
  }

  async getLatestForContent(contentId: string): Promise<ContentVersion | null> {
    const versions = await this.listForContent(contentId);
    return versions.length > 0 ? versions[versions.length - 1] : null;
  }

  async getVersion(
    contentId: string,
    versionNumber: number,
  ): Promise<ContentVersion | null> {
    return this.get({
      contentId,
      version: versionNumber,
    });
  }

  async getNextVersionNumber(contentId: string): Promise<number> {
    const latest = await this.getLatestForContent(contentId);
    return latest ? latest.version + 1 : 1;
  }

  async createSnapshot(
    content: Content,
    options: CreateContentVersionOptions = {},
  ): Promise<ContentVersion> {
    if (!content.id) {
      throw new Error('Cannot create a version for unsaved content');
    }

    const version = await this.getNextVersionNumber(content.id as string);
    const snapshot = {
      id: content.id,
      slug: content.slug,
      context: content.context,
      name: content.name,
      type: content.type,
      variant: content.variant,
      fileKey: content.fileKey,
      author: content.author,
      title: content.title,
      description: content.description,
      body: content.body,
      publish_date: content.publish_date,
      url: content.url,
      source: content.source,
      original_url: content.original_url,
      language: content.language,
      tags: [...content.tags],
      category: content.category,
      status: content.status,
      state: content.state,
      metadata: content.metadata,
      thumbnailAssetId: content.thumbnailAssetId,
      tenantId: content.tenantId,
      _meta_type: content.toJSON()._meta_type,
    };

    return this.create({
      contentId: content.id as string,
      version,
      kind: options.kind || 'manual',
      title: content.title,
      description: content.description || '',
      body: content.body,
      status: content.status,
      summary: options.summary || '',
      snapshot: JSON.stringify(snapshot),
      metadata: JSON.stringify(options.metadata || {}),
      tenantId: content.tenantId,
    });
  }

  async restoreIntoContent(
    content: Content,
    versionNumber: number,
  ): Promise<Content> {
    if (!content.id) {
      throw new Error('Cannot restore an unsaved content item');
    }

    const version = await this.getVersion(content.id as string, versionNumber);
    if (!version) {
      throw new Error(
        `Content version ${versionNumber} not found for content ${content.id}`,
      );
    }

    const snapshot = version.getSnapshot();
    const keysToRestore = [
      'name',
      'type',
      'variant',
      'fileKey',
      'author',
      'title',
      'description',
      'body',
      'publish_date',
      'url',
      'source',
      'original_url',
      'language',
      'tags',
      'category',
      'status',
      'state',
      'metadata',
      'thumbnailAssetId',
    ];

    for (const key of keysToRestore) {
      if (snapshot[key] !== undefined) {
        (content as any)[key] = snapshot[key];
      }
    }

    await content.save();
    return content;
  }
}
