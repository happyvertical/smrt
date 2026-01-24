/**
 * PullRequest model - SMRT wrapper for pull request operations
 *
 * Extends Issue with PR-specific fields and methods.
 * Uses @happyvertical/repos SDK for actual API calls.
 */

import { smrt } from '@happyvertical/smrt-core';
import { TenantScoped } from '@happyvertical/smrt-tenancy';
import { SYNC_THROTTLE_MS } from '../constants';
import type { MergeMethod, SyncOptions } from '../types';
import { Issue, type IssueOptions } from './Issue';

export interface PullRequestOptions extends IssueOptions {
  headRef?: string;
  baseRef?: string;
  merged?: boolean;
  mergedAt?: Date | null;
  mergeable?: boolean;
  draft?: boolean;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
}

@TenantScoped({ mode: 'optional' })
@smrt({
  api: { include: ['list', 'get', 'create', 'update'] },
  mcp: { include: ['list', 'get', 'sync', 'summarize', 'merge'] },
  cli: { include: ['list', 'get', 'sync', 'summarize', 'merge', 'markReady'] },
})
export class PullRequest extends Issue {
  /**
   * Source branch ref
   */
  headRef: string = '';

  /**
   * Target branch ref
   */
  baseRef: string = '';

  /**
   * Whether the PR has been merged
   */
  merged: boolean = false;

  /**
   * When the PR was merged
   */
  mergedAt: Date | null = null;

  /**
   * Whether the PR can be merged
   */
  mergeable: boolean = true;

  /**
   * Whether this is a draft PR
   */
  draft: boolean = false;

  /**
   * Lines added
   */
  additions: number = 0;

  /**
   * Lines deleted
   */
  deletions: number = 0;

  /**
   * Number of files changed
   */
  changedFiles: number = 0;

  constructor(options: PullRequestOptions = {}) {
    super(options);
    if (options.headRef !== undefined) this.headRef = options.headRef;
    if (options.baseRef !== undefined) this.baseRef = options.baseRef;
    if (options.merged !== undefined) this.merged = options.merged;
    if (options.mergedAt !== undefined) this.mergedAt = options.mergedAt;
    if (options.mergeable !== undefined) this.mergeable = options.mergeable;
    if (options.draft !== undefined) this.draft = options.draft;
    if (options.additions !== undefined) this.additions = options.additions;
    if (options.deletions !== undefined) this.deletions = options.deletions;
    if (options.changedFiles !== undefined)
      this.changedFiles = options.changedFiles;
  }

  /**
   * Sync PR data from the provider
   *
   * @param options - Sync options
   * @returns This PR with updated fields
   */
  async sync(options: SyncOptions = {}): Promise<this> {
    // Check if we recently synced (within 5 minutes)
    if (
      !options.force &&
      this.lastSyncedAt &&
      Date.now() - this.lastSyncedAt.getTime() < SYNC_THROTTLE_MS
    ) {
      return this;
    }

    const client = await this.getClient();
    const prData = await client.getPullRequest(this.number);

    // Update base issue fields
    this.nodeId = prData.id;
    this.title = prData.title;
    this.body = prData.body;
    this.state = prData.state;
    this.author = prData.author.login;
    this.labels = prData.labels.map((l) => l.name);
    this.assignees = prData.assignees.map((a) => a.login);
    this.commentsCount = prData.commentsCount;

    // Update PR-specific fields
    this.headRef = prData.headRef;
    this.baseRef = prData.baseRef;
    this.merged = prData.merged;
    this.mergedAt = prData.mergedAt || null;
    this.mergeable = prData.mergeable;
    this.draft = prData.draft;

    this.lastSyncedAt = new Date();
    await this.save();
    return this;
  }

  /**
   * AI-powered: Generate a summary of PR changes
   *
   * @returns Summary of what this PR does
   */
  async summarize(): Promise<string> {
    return await this.do(
      `Summarize this pull request concisely.

      Title: ${this.title}
      Description: ${this.body}

      Changes: ${this.additions} additions, ${this.deletions} deletions across ${this.changedFiles} files
      Source: ${this.headRef} → ${this.baseRef}

      Provide a 2-3 sentence summary focusing on:
      1. What the PR does
      2. Why it matters
      3. Any notable implementation details`,
    );
  }

  /**
   * Merge this pull request
   *
   * @param method - Merge method (merge, squash, rebase)
   */
  async merge(method: MergeMethod = 'squash'): Promise<void> {
    if (this.merged) {
      throw new Error('Pull request is already merged');
    }

    if (this.draft) {
      throw new Error('Cannot merge a draft pull request');
    }

    if (!this.mergeable) {
      throw new Error('Pull request is not mergeable');
    }

    const client = await this.getClient();
    await client.mergePullRequest(this.number, method);

    this.merged = true;
    this.mergedAt = new Date();
    this.state = 'closed';
    this.lastSyncedAt = new Date();
    await this.save();
  }

  /**
   * Mark this draft PR as ready for review
   */
  async markReady(): Promise<void> {
    if (!this.draft) {
      throw new Error('Pull request is not a draft');
    }

    const client = await this.getClient();
    await client.markPRReady(this.number);

    this.draft = false;
    this.lastSyncedAt = new Date();
    await this.save();
  }

  /**
   * Convert this PR back to draft
   */
  async convertToDraft(): Promise<void> {
    if (this.draft) {
      throw new Error('Pull request is already a draft');
    }

    const client = await this.getClient();
    await client.convertPRToDraft(this.number);

    this.draft = true;
    this.lastSyncedAt = new Date();
    await this.save();
  }

  /**
   * Request review from specified users
   *
   * @param reviewers - User logins to request review from
   */
  async requestReviewers(reviewers: string[]): Promise<void> {
    const client = await this.getClient();
    await client.requestReview(this.number, reviewers);
  }

  /**
   * Find related issue for this PR
   *
   * @returns Related Issue or null
   */
  async findLinkedIssue(): Promise<Issue | null> {
    const client = await this.getClient();
    const issue = await client.findIssueForPR(this.number);

    if (!issue) {
      return null;
    }

    // Return as SMRT Issue
    const { IssueCollection } = await import('../collections/Issues');
    const collection = await (IssueCollection as any).create(this.options);
    return await collection.findOne({
      where: { repositoryId: this.repositoryId, number: issue.number },
    });
  }

  /**
   * AI-powered: Check if this PR is ready to merge
   *
   * @returns True if the PR appears ready
   */
  async isReadyToMerge(): Promise<boolean> {
    if (this.draft) return false;
    if (!this.mergeable) return false;
    if (this.state === 'closed') return false;

    return await this.is(
      `This pull request is ready to merge because:
      - It has a clear description of what it does
      - It addresses a specific issue or feature
      - The scope is appropriate (not too large)
      - There are no unresolved review comments`,
    );
  }

  /**
   * AI-powered: Suggest reviewers based on changed files
   *
   * @returns Array of suggested reviewer logins
   */
  async suggestReviewers(): Promise<string[]> {
    const suggestion = await this.do(
      `Based on this pull request's title, description, and scope,
      suggest who should review it.

      Title: ${this.title}
      Description: ${this.body}
      Changes: ${this.changedFiles} files changed

      Consider:
      - Code owners for the affected areas
      - Team members with relevant expertise
      - People who have previously worked on related code

      Return only a comma-separated list of GitHub usernames, nothing else.
      If you cannot determine reviewers, return an empty string.`,
    );

    return suggestion
      .split(',')
      .map((r) => r.trim())
      .filter(Boolean);
  }

  /**
   * Get PR URL
   */
  override getUrl(): string {
    const repo = this._repository;
    if (repo) {
      return `https://github.com/${repo.owner}/${repo.name}/pull/${this.number}`;
    }
    return '';
  }

  /**
   * Get the change size classification
   *
   * @returns Size classification (xs, s, m, l, xl)
   */
  getChangeSize(): 'xs' | 's' | 'm' | 'l' | 'xl' {
    const total = this.additions + this.deletions;

    if (total < 10) return 'xs';
    if (total < 50) return 's';
    if (total < 200) return 'm';
    if (total < 500) return 'l';
    return 'xl';
  }
}
