/**
 * STI tests for Account classes
 *
 * Tests that Account and its descendants (EmailAccount, SlackAccount, TwitterAccount)
 * properly support STI with _meta_type discriminator.
 */

import { getTestDatabase, ObjectRegistry } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Account } from '../models/Account';
import { EmailAccount } from '../models/EmailAccount';
import { SlackAccount } from '../models/SlackAccount';
import { TwitterAccount } from '../models/TwitterAccount';

describe('Account STI Support', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
  });

  afterEach(async () => {
    if (db && typeof db.close === 'function') {
      await db.close();
    }
  });

  describe('Account (base class)', () => {
    it('should detect STI strategy', () => {
      const strategy = ObjectRegistry.getTableStrategy('Account');
      expect(strategy).toBe('sti');
    });

    it('should set _meta_type in toJSON()', async () => {
      const account = new Account({
        name: 'Test Account',
        providerType: 'generic',
      });
      await account.initialize();

      const data = account.toJSON();
      expect(data._meta_type).toBe('@happyvertical/smrt-messages:Account');
    });

    it('should save with STI discriminator', async () => {
      const account = new Account({
        name: 'Test Account',
        providerType: 'generic',
        db,
      });
      await account.initialize();

      await expect(account.save()).resolves.not.toThrow();
      expect(account.id).toBeDefined();
    });

    it('should handle settings JSON', () => {
      const account = new Account({
        name: 'Test',
        settings: JSON.stringify({ key: 'value' }),
      });

      expect(account.getSettings()).toEqual({ key: 'value' });
    });

    it('should handle invalid settings JSON gracefully', () => {
      const account = new Account({
        name: 'Test',
        settings: 'invalid-json',
      });

      expect(account.getSettings()).toEqual({});
    });
  });

  describe('EmailAccount (extends Account)', () => {
    it('should detect STI strategy', () => {
      const strategy = ObjectRegistry.getTableStrategy('EmailAccount');
      expect(strategy).toBe('sti');
    });

    it('should get STI base class', () => {
      const base = ObjectRegistry.getSTIBase('EmailAccount');
      expect(base).toBe('Account');
    });

    it('should set _meta_type to EmailAccount', async () => {
      const account = new EmailAccount({
        name: 'Gmail Account',
        email: 'test@gmail.com',
        providerType: 'gmail',
      });
      await account.initialize();

      const data = account.toJSON();
      expect(data._meta_type).toBe('@happyvertical/smrt-messages:EmailAccount');
    });

    it('should save EmailAccount with STI discriminator', async () => {
      const account = new EmailAccount({
        name: 'Gmail Account',
        email: 'test@gmail.com',
        providerType: 'gmail',
        db,
      });
      await account.initialize();

      await expect(account.save()).resolves.not.toThrow();
      expect(account.id).toBeDefined();
    });

    it('should preserve email-specific fields', async () => {
      const account = new EmailAccount({
        name: 'Gmail Account',
        email: 'test@gmail.com',
        providerType: 'imap',
        syncIntervalMinutes: 15,
        db,
      });
      await account.initialize();
      await account.save();

      const loaded = new EmailAccount({ id: account.id, db });
      await loaded.initialize();
      await loaded.loadFromId(account.id);

      expect(loaded.email).toBe('test@gmail.com');
      expect(loaded.providerType).toBe('imap');
      expect(loaded.syncIntervalMinutes).toBe(15);
    });
  });

  describe('SlackAccount (extends Account)', () => {
    it('should detect STI strategy', () => {
      const strategy = ObjectRegistry.getTableStrategy('SlackAccount');
      expect(strategy).toBe('sti');
    });

    it('should get STI base class', () => {
      const base = ObjectRegistry.getSTIBase('SlackAccount');
      expect(base).toBe('Account');
    });

    it('should set _meta_type to SlackAccount', async () => {
      const account = new SlackAccount({
        name: 'My Workspace',
        workspaceId: 'T12345',
        workspaceName: 'My Company',
      });
      await account.initialize();

      const data = account.toJSON();
      expect(data._meta_type).toBe('@happyvertical/smrt-messages:SlackAccount');
    });

    it('should save with default providerType', async () => {
      const account = new SlackAccount({
        name: 'My Workspace',
        workspaceId: 'T12345',
        workspaceName: 'My Company',
        db,
      });
      await account.initialize();

      expect(account.providerType).toBe('slack');

      await expect(account.save()).resolves.not.toThrow();
    });
  });

  describe('TwitterAccount (extends Account)', () => {
    it('should detect STI strategy', () => {
      const strategy = ObjectRegistry.getTableStrategy('TwitterAccount');
      expect(strategy).toBe('sti');
    });

    it('should get STI base class', () => {
      const base = ObjectRegistry.getSTIBase('TwitterAccount');
      expect(base).toBe('Account');
    });

    it('should set _meta_type to TwitterAccount', async () => {
      const account = new TwitterAccount({
        name: 'My Twitter',
        handle: '@testuser',
        twitterUserId: '12345',
      });
      await account.initialize();

      const data = account.toJSON();
      expect(data._meta_type).toBe(
        '@happyvertical/smrt-messages:TwitterAccount',
      );
    });

    it('should save with default providerType', async () => {
      const account = new TwitterAccount({
        name: 'My Twitter',
        handle: '@testuser',
        twitterUserId: '12345',
        db,
      });
      await account.initialize();

      expect(account.providerType).toBe('twitter');

      await expect(account.save()).resolves.not.toThrow();
    });
  });

  describe('STI discriminator handling', () => {
    it('should set different _meta_type for each account class', async () => {
      const base = new Account({ name: 'Base' });
      await base.initialize();

      const email = new EmailAccount({
        name: 'Email',
        email: 'test@example.com',
      });
      await email.initialize();

      const slack = new SlackAccount({ name: 'Slack', workspaceId: 'T1' });
      await slack.initialize();

      const twitter = new TwitterAccount({ name: 'Twitter', handle: '@test' });
      await twitter.initialize();

      expect(base.toJSON()._meta_type).toBe(
        '@happyvertical/smrt-messages:Account',
      );
      expect(email.toJSON()._meta_type).toBe(
        '@happyvertical/smrt-messages:EmailAccount',
      );
      expect(slack.toJSON()._meta_type).toBe(
        '@happyvertical/smrt-messages:SlackAccount',
      );
      expect(twitter.toJSON()._meta_type).toBe(
        '@happyvertical/smrt-messages:TwitterAccount',
      );
    });
  });

  describe('Inheritance chain', () => {
    it('should build correct inheritance chain for EmailAccount', () => {
      const chain = ObjectRegistry.getInheritanceChain('EmailAccount');

      expect(chain).toContain('Account');
      expect(chain).toContain('EmailAccount');

      const accountIdx = chain.indexOf('Account');
      const emailAccountIdx = chain.indexOf('EmailAccount');
      expect(emailAccountIdx).toBeGreaterThan(accountIdx);
    });

    it('should get all descendants of Account', () => {
      const descendants = ObjectRegistry.getDescendants('Account');

      expect(descendants).toContain('EmailAccount');
      expect(descendants).toContain('SlackAccount');
      expect(descendants).toContain('TwitterAccount');
    });
  });
});
