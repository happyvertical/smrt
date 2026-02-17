/**
 * Tests for sender classes
 */

import { describe, expect, it } from 'vitest';
import { EmailAccount } from '../models/EmailAccount';
import { SlackAccount } from '../models/SlackAccount';
import { TwitterAccount } from '../models/TwitterAccount';
import { EmailSender } from '../senders/EmailSender';
import { SlackSender } from '../senders/SlackSender';
import { TweetSender } from '../senders/TweetSender';

// ============================================================================
// EmailSender
// ============================================================================

describe('EmailSender', () => {
  it('reports correct providerType', () => {
    const mockClient = {
      isConnected: () => true,
      send: async () => ({
        messageId: 'msg-1',
        accepted: ['a@b.com'],
        rejected: [],
        response: 'ok',
      }),
    } as any;

    const account = new EmailAccount({ email: 'test@test.com' });
    const sender = new EmailSender(mockClient, account);

    expect(sender.providerType).toBe('email');
    expect(sender.isReady()).toBe(true);
  });

  it('isReady reflects client connection', () => {
    const disconnectedClient = { isConnected: () => false } as any;
    const account = new EmailAccount();
    const sender = new EmailSender(disconnectedClient, account);
    expect(sender.isReady()).toBe(false);
  });
});

// ============================================================================
// SlackSender
// ============================================================================

describe('SlackSender', () => {
  it('reports correct providerType', () => {
    const account = new SlackAccount({
      name: 'Test Slack',
      workspaceId: 'W123',
      isActive: true,
    });
    const sender = new SlackSender(account);

    expect(sender.providerType).toBe('slack');
  });

  it('isReady checks account active state', () => {
    const activeAccount = new SlackAccount({ isActive: true });
    const inactiveAccount = new SlackAccount({ isActive: false });

    expect(new SlackSender(activeAccount).isReady()).toBe(true);
    expect(new SlackSender(inactiveAccount).isReady()).toBe(false);
  });
});

// ============================================================================
// TweetSender
// ============================================================================

describe('TweetSender', () => {
  it('reports correct providerType', () => {
    const account = new TwitterAccount({
      handle: '@test',
      twitterUserId: '123',
      isActive: true,
    });
    const sender = new TweetSender(account);

    expect(sender.providerType).toBe('twitter');
  });

  it('isReady checks account active state', () => {
    const activeAccount = new TwitterAccount({ isActive: true });
    const inactiveAccount = new TwitterAccount({ isActive: false });

    expect(new TweetSender(activeAccount).isReady()).toBe(true);
    expect(new TweetSender(inactiveAccount).isReady()).toBe(false);
  });
});
