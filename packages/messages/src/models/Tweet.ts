/**
 * Tweet model - Twitter/X message extending the Message STI base
 */

import { smrt } from '@happyvertical/smrt-core';
import type { TweetOptions } from '../types';
import { Message } from './Message';

@smrt({
  tableStrategy: 'sti',
  api: { include: ['list', 'get', 'create'] },
  mcp: { include: ['list', 'get'] },
  cli: true,
})
export class Tweet extends Message {
  tweetId = '';
  retweetCount = 0;
  likeCount = 0;
  replyCount = 0;
  isRetweet = false;
  isReply = false;
  mediaUrls = ''; // JSON array
  hashtags = ''; // JSON array
  mentions = ''; // JSON array

  constructor(options: TweetOptions = {}) {
    super(options);

    if (options.tweetId !== undefined) this.tweetId = options.tweetId;
    if (options.retweetCount !== undefined)
      this.retweetCount = options.retweetCount;
    if (options.likeCount !== undefined) this.likeCount = options.likeCount;
    if (options.replyCount !== undefined) this.replyCount = options.replyCount;
    if (options.isRetweet !== undefined) this.isRetweet = options.isRetweet;
    if (options.isReply !== undefined) this.isReply = options.isReply;
    if (options.mediaUrls !== undefined) this.mediaUrls = options.mediaUrls;
    if (options.hashtags !== undefined) this.hashtags = options.hashtags;
    if (options.mentions !== undefined) this.mentions = options.mentions;
  }

  /**
   * Get media URLs as parsed array
   */
  getMediaUrls(): string[] {
    if (!this.mediaUrls) return [];
    try {
      return JSON.parse(this.mediaUrls);
    } catch {
      return [];
    }
  }

  /**
   * Get hashtags as parsed array
   */
  getHashtags(): string[] {
    if (!this.hashtags) return [];
    try {
      return JSON.parse(this.hashtags);
    } catch {
      return [];
    }
  }

  /**
   * Get mentions as parsed array
   */
  getMentions(): string[] {
    if (!this.mentions) return [];
    try {
      return JSON.parse(this.mentions);
    } catch {
      return [];
    }
  }

  /**
   * Get total engagement count
   */
  getEngagement(): number {
    return this.retweetCount + this.likeCount + this.replyCount;
  }
}
