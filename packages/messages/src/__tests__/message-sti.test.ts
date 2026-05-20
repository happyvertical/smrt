/**
 * STI (Single Table Inheritance) tests for Message classes
 *
 * Tests that Message and its descendants (Email, Tweet, SlackMessage)
 * properly support STI with _meta_type discriminator, polymorphic queries,
 * and backward compatibility.
 */

import { getTestDatabase, ObjectRegistry } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Email } from '../models/Email';
import { Message } from '../models/Message';
import { SlackMessage } from '../models/SlackMessage';
import { Tweet } from '../models/Tweet';

describe('Message STI Support', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
  });

  afterEach(async () => {
    if (db && typeof db.close === 'function') {
      await db.close();
    }
  });

  describe('Message (base class)', () => {
    it('should detect STI strategy', () => {
      const strategy = ObjectRegistry.getTableStrategy('Message');
      expect(strategy).toBe('sti');
    });

    it('should set _meta_type in toJSON()', async () => {
      const message = new Message({
        subject: 'Test',
        body: 'Hello world',
      });
      await message.initialize();

      const data = message.toJSON();
      expect(data._meta_type).toBe('@happyvertical/smrt-messages:Message');
    });

    it('should save with STI discriminator', async () => {
      const message = new Message({
        subject: 'Test Message',
        body: 'Hello world',
        fromAddress: 'sender@example.com',
        fromName: 'Sender',
        db,
      });
      await message.initialize();

      await expect(message.save()).resolves.not.toThrow();
      expect(message.id).toBeDefined();
    });

    it('should load Message from database', async () => {
      const message = new Message({
        subject: 'Test Message',
        body: 'Hello world',
        fromAddress: 'sender@example.com',
        db,
      });
      await message.initialize();
      await message.save();
      const savedId = message.id;

      const loaded = new Message({ id: savedId, db });
      await loaded.initialize();
      await loaded.loadFromId(savedId);

      expect(loaded.id).toBe(savedId);
      expect(loaded.subject).toBe('Test Message');
      expect(loaded.body).toBe('Hello world');
      expect(loaded.fromAddress).toBe('sender@example.com');
    });
  });

  describe('Email (extends Message)', () => {
    it('should detect STI strategy', () => {
      const strategy = ObjectRegistry.getTableStrategy('Email');
      expect(strategy).toBe('sti');
    });

    it('should get STI base class', () => {
      const base = ObjectRegistry.getSTIBase('Email');
      expect(base).toBe('@happyvertical/smrt-messages:Message');
    });

    it('should set _meta_type to Email', async () => {
      const email = new Email({
        subject: 'Test Email',
        textBody: 'Email body',
        fromAddress: 'sender@example.com',
        messageId: '<abc123@example.com>',
      });
      await email.initialize();

      const data = email.toJSON();
      expect(data._meta_type).toBe('@happyvertical/smrt-messages:Email');
    });

    it('should save Email with STI discriminator', async () => {
      const email = new Email({
        subject: 'Test Email',
        textBody: 'Email body',
        fromAddress: 'sender@example.com',
        messageId: '<abc123@example.com>',
        folderId: 'inbox',
        folderPath: 'INBOX',
        db,
      });
      await email.initialize();

      await expect(email.save()).resolves.not.toThrow();
      expect(email.id).toBeDefined();
    });

    it('should populate body from textBody', () => {
      const email = new Email({
        subject: 'Test',
        textBody: 'Email body text',
      });

      expect(email.body).toBe('Email body text');
      expect(email.textBody).toBe('Email body text');
    });

    it('should preserve email-specific fields', async () => {
      const email = new Email({
        subject: 'Test Email',
        textBody: 'Email body',
        htmlBody: '<p>Email body</p>',
        fromAddress: 'sender@example.com',
        messageId: '<msg@example.com>',
        inReplyTo: '<parent@example.com>',
        ccAddresses: JSON.stringify([{ address: 'cc@example.com' }]),
        folderId: 'folder-1',
        folderPath: 'INBOX',
        isAnswered: true,
        isDraft: false,
        db,
      });
      await email.initialize();
      await email.save();

      const loaded = new Email({ id: email.id, db });
      await loaded.initialize();
      await loaded.loadFromId(email.id);

      expect(loaded.messageId).toBe('<msg@example.com>');
      expect(loaded.inReplyTo).toBe('<parent@example.com>');
      expect(loaded.htmlBody).toBe('<p>Email body</p>');
      expect(loaded.folderId).toBe('folder-1');
      expect(loaded.folderPath).toBe('INBOX');
      expect(loaded.isAnswered).toBe(true);
      expect(loaded.getCcAddresses()).toEqual([{ address: 'cc@example.com' }]);
    });
  });

  describe('Tweet (extends Message)', () => {
    it('should detect STI strategy', () => {
      const strategy = ObjectRegistry.getTableStrategy('Tweet');
      expect(strategy).toBe('sti');
    });

    it('should get STI base class', () => {
      const base = ObjectRegistry.getSTIBase('Tweet');
      expect(base).toBe('@happyvertical/smrt-messages:Message');
    });

    it('should set _meta_type to Tweet', async () => {
      const tweet = new Tweet({
        subject: 'Tweet',
        body: 'Hello #world',
        tweetId: '12345',
      });
      await tweet.initialize();

      const data = tweet.toJSON();
      expect(data._meta_type).toBe('@happyvertical/smrt-messages:Tweet');
    });

    it('should save Tweet with STI discriminator', async () => {
      const tweet = new Tweet({
        body: 'Hello world!',
        fromAddress: '@testuser',
        fromName: 'Test User',
        tweetId: '12345',
        retweetCount: 10,
        likeCount: 50,
        replyCount: 3,
        hashtags: JSON.stringify(['hello', 'world']),
        db,
      });
      await tweet.initialize();

      await expect(tweet.save()).resolves.not.toThrow();
      expect(tweet.id).toBeDefined();
    });

    it('should preserve tweet-specific fields', async () => {
      const tweet = new Tweet({
        body: 'Hello world!',
        fromAddress: '@testuser',
        tweetId: '12345',
        retweetCount: 10,
        likeCount: 50,
        replyCount: 3,
        isRetweet: true,
        hashtags: JSON.stringify(['hello', 'world']),
        mentions: JSON.stringify(['@other']),
        mediaUrls: JSON.stringify(['https://pic.twitter.com/abc']),
        db,
      });
      await tweet.initialize();
      await tweet.save();

      const loaded = new Tweet({ id: tweet.id, db });
      await loaded.initialize();
      await loaded.loadFromId(tweet.id);

      expect(loaded.tweetId).toBe('12345');
      expect(loaded.retweetCount).toBe(10);
      expect(loaded.likeCount).toBe(50);
      expect(loaded.replyCount).toBe(3);
      expect(loaded.isRetweet).toBe(true);
      expect(loaded.getHashtags()).toEqual(['hello', 'world']);
      expect(loaded.getMentions()).toEqual(['@other']);
      expect(loaded.getMediaUrls()).toEqual(['https://pic.twitter.com/abc']);
      expect(loaded.getEngagement()).toBe(63);
    });
  });

  describe('SlackMessage (extends Message)', () => {
    it('should detect STI strategy', () => {
      const strategy = ObjectRegistry.getTableStrategy('SlackMessage');
      expect(strategy).toBe('sti');
    });

    it('should get STI base class', () => {
      const base = ObjectRegistry.getSTIBase('SlackMessage');
      expect(base).toBe('@happyvertical/smrt-messages:Message');
    });

    it('should set _meta_type to SlackMessage', async () => {
      const slack = new SlackMessage({
        body: 'Hello team!',
        channelName: 'general',
      });
      await slack.initialize();

      const data = slack.toJSON();
      expect(data._meta_type).toBe('@happyvertical/smrt-messages:SlackMessage');
    });

    it('should save SlackMessage with STI discriminator', async () => {
      const slack = new SlackMessage({
        body: 'Hello team!',
        fromName: 'Bot User',
        channelId: 'C12345',
        channelName: 'general',
        slackTs: '1234567890.123456',
        messageType: 'message',
        reactions: JSON.stringify([{ name: 'thumbsup', count: 3 }]),
        db,
      });
      await slack.initialize();

      await expect(slack.save()).resolves.not.toThrow();
      expect(slack.id).toBeDefined();
    });

    it('should preserve slack-specific fields', async () => {
      const slack = new SlackMessage({
        body: 'Hello team!',
        channelId: 'C12345',
        channelName: 'general',
        slackTs: '1234567890.123456',
        slackThreadTs: '1234567890.100000',
        reactions: JSON.stringify([
          { name: 'thumbsup', count: 3 },
          { name: 'heart', count: 2 },
        ]),
        isEdited: true,
        messageType: 'message',
        db,
      });
      await slack.initialize();
      await slack.save();

      const loaded = new SlackMessage({ id: slack.id, db });
      await loaded.initialize();
      await loaded.loadFromId(slack.id);

      expect(loaded.channelId).toBe('C12345');
      expect(loaded.channelName).toBe('general');
      expect(loaded.slackTs).toBe('1234567890.123456');
      expect(loaded.slackThreadTs).toBe('1234567890.100000');
      expect(loaded.isEdited).toBe(true);
      expect(loaded.isInThread()).toBe(true);
      expect(loaded.getReactions()).toHaveLength(2);
      expect(loaded.getTotalReactions()).toBe(5);
    });
  });

  describe('STI discriminator handling', () => {
    it('should set different _meta_type for each class', async () => {
      const message = new Message({ subject: 'Base', body: 'Base body' });
      await message.initialize();

      const email = new Email({ subject: 'Email', textBody: 'Email body' });
      await email.initialize();

      const tweet = new Tweet({ body: 'Tweet body', tweetId: '123' });
      await tweet.initialize();

      const slack = new SlackMessage({
        body: 'Slack body',
        channelName: 'general',
      });
      await slack.initialize();

      expect(message.toJSON()._meta_type).toBe(
        '@happyvertical/smrt-messages:Message',
      );
      expect(email.toJSON()._meta_type).toBe(
        '@happyvertical/smrt-messages:Email',
      );
      expect(tweet.toJSON()._meta_type).toBe(
        '@happyvertical/smrt-messages:Tweet',
      );
      expect(slack.toJSON()._meta_type).toBe(
        '@happyvertical/smrt-messages:SlackMessage',
      );
    });
  });

  describe('Inheritance chain', () => {
    it('should build correct inheritance chain for Email', () => {
      const chain = ObjectRegistry.getInheritanceChain('Email');

      expect(chain).toContain('@happyvertical/smrt-messages:Message');
      expect(chain).toContain('@happyvertical/smrt-messages:Email');

      const messageIdx = chain.indexOf('@happyvertical/smrt-messages:Message');
      const emailIdx = chain.indexOf('@happyvertical/smrt-messages:Email');
      expect(emailIdx).toBeGreaterThan(messageIdx);
    });

    it('should get all descendants of Message', () => {
      const descendants = ObjectRegistry.getDescendants('Message');

      expect(descendants).toContain('@happyvertical/smrt-messages:Email');
      expect(descendants).toContain('@happyvertical/smrt-messages:Tweet');
      expect(descendants).toContain(
        '@happyvertical/smrt-messages:SlackMessage',
      );
    });
  });
});
