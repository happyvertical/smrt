/**
 * Declared recipes for smrt-content (#4409): user-facing units of
 * functionality an app or agent can pick instead of the whole package.
 * The scanner reads these statics into the `recipes` array of `manifest.json`
 * and `smrt-knowledge.json`; nothing here runs at that point.
 *
 * @packageDocumentation
 */

import { SmrtRecipe } from '@happyvertical/smrt-core';
import { Content } from './content.js';
import { ContentContribution } from './content-contribution.js';
import { ContentContributor } from './content-contributor.js';
import { ContentCorrection } from './content-correction.js';
import { ContentReview } from './content-review.js';
import { ContentVersion } from './content-version.js';

/**
 * Articles: Write pieces, publish them, and keep the record straight.
 *
 * The `Article` subclass is closed to the generated surfaces, so the nav
 * entry is the exposed base `Content` narrowed to `type = 'article'`, the
 * value the package's own screens and assistant use for an article.
 */
export class ArticlesRecipe extends SmrtRecipe {
  static id = 'content.articles';
  static help = './articles.recipe.md';
  static label = 'Articles';
  static summary =
    'Write articles, publish them, and keep a record of every change, review and correction.';
  static synonyms = [
    'articles',
    'posts',
    'blog',
    'news',
    'stories',
    'drafts',
    'publishing',
  ];
  static section = {
    id: 'publish',
    label: 'Publish',
    icon: 'fileText',
    description: 'What you write, record and put out.',
  };
  static models = [
    Content,
    ContentVersion,
    ContentCorrection,
    ContentReview,
    ContentContribution,
    ContentContributor,
  ];
  static nav = [
    {
      label: 'Articles',
      model: Content,
      key: 'articles',
      icon: 'fileText',
      description: 'Every article, from first draft to published.',
      noun: 'article',
      filter: { field: 'type', value: 'article' },
    },
    {
      label: 'Versions',
      model: ContentVersion,
      icon: 'layers',
      description: 'Each saved state of an article, so nothing is lost.',
      noun: 'version',
    },
    {
      label: 'Corrections',
      model: ContentCorrection,
      icon: 'edit',
      description: 'Fixes made to an article after it went out.',
      noun: 'correction',
    },
    {
      label: 'Reviews',
      model: ContentReview,
      icon: 'eye',
      description: 'What the checks found before an article went out.',
      noun: 'review',
    },
    {
      label: 'Contributions',
      model: ContentContribution,
      icon: 'chat',
      description: 'Pieces sent in by readers and outside writers.',
      noun: 'contribution',
    },
  ];
  static options = {
    Content: {
      fields: {
        title: { order: 1 },
        name: { label: 'Short name', order: 2 },
        type: { label: 'Kind', order: 3, default: 'article' },
        status: { order: 4 },
        description: { label: 'Summary', order: 5 },
        body: { order: 6 },
        author: { order: 7 },
        publish_date: { label: 'Published on', order: 8 },
        category: { label: 'Section', order: 9 },
        tags: { order: 10 },
        language: { visibility: 'advanced' },
        state: { visibility: 'advanced' },
        url: { label: 'Web address', visibility: 'advanced' },
        source: { visibility: 'advanced' },
        original_url: { label: 'Original web address', visibility: 'advanced' },
        thumbnailAssetId: { label: 'Picture', visibility: 'advanced' },
        tenantId: { visibility: 'hidden' },
        variant: { visibility: 'hidden' },
        fileKey: { visibility: 'hidden' },
        bodyFormat: { visibility: 'hidden' },
        metadata: { visibility: 'hidden' },
      },
    },
    ContentVersion: {
      fields: {
        contentId: { label: 'Article', order: 1 },
        version: { label: 'Version number', order: 2 },
        kind: { order: 3 },
        summary: { order: 4 },
        title: { order: 5 },
        status: { order: 6 },
        createdAt: { label: 'Saved on', order: 7 },
        description: { label: 'Summary at the time', visibility: 'advanced' },
        body: { label: 'Text at the time', visibility: 'advanced' },
        tenantId: { visibility: 'hidden' },
        snapshot: { visibility: 'hidden' },
        metadata: { visibility: 'hidden' },
        updatedAt: { visibility: 'hidden' },
      },
    },
    ContentCorrection: {
      fields: {
        contentId: { label: 'Article', order: 1 },
        correctionType: { label: 'Kind', order: 2 },
        status: { order: 3 },
        summary: { order: 4 },
        incorrectText: { label: 'What was wrong', order: 5 },
        correctedText: { label: 'What it should say', order: 6 },
        publicNote: { label: 'Note to readers', order: 7 },
        publishedAt: { label: 'Published on', order: 8 },
        contentVersionId: { label: 'Version', visibility: 'advanced' },
        factId: { visibility: 'hidden' },
        replacementFactId: { visibility: 'hidden' },
        tenantId: { visibility: 'hidden' },
        metadata: { visibility: 'hidden' },
        createdAt: { visibility: 'hidden' },
        updatedAt: { visibility: 'hidden' },
      },
    },
    ContentReview: {
      fields: {
        contentId: { label: 'Article', order: 1 },
        kind: { order: 2 },
        policyKey: { label: 'Policy', order: 3 },
        status: { label: 'Outcome', order: 4 },
        summary: { order: 5 },
        reviewer: { order: 6 },
        createdAt: { label: 'Reviewed on', order: 7 },
        contentVersionId: { label: 'Version', visibility: 'advanced' },
        findings: { visibility: 'hidden' },
        tenantId: { visibility: 'hidden' },
        metadata: { visibility: 'hidden' },
        updatedAt: { visibility: 'hidden' },
      },
    },
    ContentContribution: {
      fields: {
        title: { order: 1 },
        contributorName: { label: 'From', order: 2 },
        contributionTypeKey: { label: 'Kind', order: 3 },
        status: { order: 4 },
        channel: { label: 'Arrived by', order: 5 },
        description: { label: 'Summary', order: 6 },
        body: { order: 7 },
        editorNotes: { label: 'Your notes', order: 8 },
        contributorId: { label: 'Contributor', order: 9 },
        contributorEmail: { label: 'Email', visibility: 'advanced' },
        promotedContentId: { label: 'Published as', visibility: 'advanced' },
        intakeDecision: { visibility: 'advanced' },
        revisionCount: { label: 'Times revised', visibility: 'advanced' },
        threadKey: { visibility: 'hidden' },
        sourceMessageId: { visibility: 'hidden' },
        approvedAt: { visibility: 'hidden' },
        promotedAt: { visibility: 'hidden' },
        rejectedAt: { visibility: 'hidden' },
        withdrawnAt: { visibility: 'hidden' },
        requestedChangesAt: { visibility: 'hidden' },
        tenantId: { visibility: 'hidden' },
        metadata: { visibility: 'hidden' },
        createdAt: { visibility: 'hidden' },
        updatedAt: { visibility: 'hidden' },
      },
    },
    ContentContributor: {
      fields: {
        name: { order: 1 },
        email: { order: 2 },
        trustLevel: { label: 'Trust', order: 3 },
        profileId: { label: 'Person', visibility: 'advanced' },
        tenantId: { visibility: 'hidden' },
        metadata: { visibility: 'hidden' },
        createdAt: { visibility: 'hidden' },
        updatedAt: { visibility: 'hidden' },
      },
    },
  } as const;
}
