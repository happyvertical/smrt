/**
 * Magic-link step-up (#4841 follow-up): an authenticated session asks for a
 * link of purpose `step_up`, bound to that session and its user, short lived
 * and single use. Consuming it from the SAME session stamps
 * `reauthenticatedAt` on it; nothing is minted. It never signs anyone in, and
 * a sign-in link never steps up.
 */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UsersMagicLinkTokenCollection } from '../collections/MagicLinkTokenCollection.js';
import { SessionCollection } from '../collections/SessionCollection.js';
import { UserCollection } from '../collections/UserCollection.js';
import {
  MagicLinkError,
  MagicLinkService,
} from '../services/MagicLinkService.js';
import { SessionService } from '../services/SessionService.js';
import {
  DEFAULT_STEP_UP_MAX_AGE_SECONDS,
  requireRecentAuthentication,
  StepUpRequiredError,
} from '../step-up.js';

describe('magic-link step-up', () => {
  let dbPath: string;
  let options: { db: { type: 'sqlite'; url: string } };
  let links: MagicLinkService;
  let tokens: UsersMagicLinkTokenCollection;
  let users: UserCollection;
  let sessions: SessionService;
  let rows: SessionCollection;
  let ownerId: string;
  let otherId: string;

  const magicSession = (userId = ownerId) =>
    sessions.createSession(userId, undefined, { authMethod: 'magic-link' });

  const context = async (sessionId: string) => {
    const ctx = await sessions.loadSessionContext(sessionId);
    if (!ctx) throw new Error('session did not load');
    return ctx;
  };

  beforeEach(async () => {
    dbPath = join(
      tmpdir(),
      `smrt-stepup-ml-${Date.now()}-${Math.random().toString(16).slice(2)}.db`,
    );
    options = { db: { type: 'sqlite', url: dbPath } };
    links = await MagicLinkService.create({ ...options, secret: 'secret' });
    tokens = await UsersMagicLinkTokenCollection.create(options);
    users = await UserCollection.create(options);
    sessions = await SessionService.create(options);
    rows = await SessionCollection.create(options);
    const owner = await users.create({ email: 'owner@example.com' });
    await owner.save();
    ownerId = owner.id as string;
    const other = await users.create({ email: 'other@example.com' });
    await other.save();
    otherId = other.id as string;
  });

  afterEach(() => {
    if (existsSync(dbPath)) rmSync(dbPath, { force: true });
  });

  it('does not count a plain magic-link session as a fresh authentication', async () => {
    const ctx = await context(await magicSession());
    expect(ctx.reauthenticatedAt).toBeNull();
    expect(() => requireRecentAuthentication(ctx)).toThrow(StepUpRequiredError);
  });

  it('stamps the same session once the link is used, and only then passes requireRecentAuthentication', async () => {
    const sessionId = await magicSession();
    const before = await rows.list({});

    const { token, email, expiresAt } = await links.requestStepUp({
      sessionId,
    });
    expect(email).toBe('owner@example.com');
    expect(expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(
      DEFAULT_STEP_UP_MAX_AGE_SECONDS * 1000,
    );
    // Requesting a link proves nothing by itself.
    const pending = await context(sessionId);
    expect(pending.reauthenticatedAt).toBeNull();
    expect(() => requireRecentAuthentication(pending)).toThrow(
      StepUpRequiredError,
    );

    const result = await links.consumeStepUp({ token, sessionId });

    expect(result.sessionId).toBe(sessionId);
    const fresh = await context(sessionId);
    expect(fresh.reauthenticatedAt?.toISOString()).toBe(
      result.reauthenticatedAt,
    );
    expect(() =>
      requireRecentAuthentication(fresh, {
        expectedSessionId: sessionId,
        expectedUserId: ownerId,
      }),
    ).not.toThrow();
    expect(await rows.list({})).toHaveLength(before.length);
  });

  it('caps a step-up link at the step-up window whatever the sign-in expiry', async () => {
    const long = await MagicLinkService.create({
      ...options,
      secret: 'secret',
      tokenExpiry: 3600,
    });
    const sessionId = await magicSession();
    const { expiresAt } = await long.requestStepUp({ sessionId });
    expect(expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(
      DEFAULT_STEP_UP_MAX_AGE_SECONDS * 1000,
    );
    const short = await MagicLinkService.create({
      ...options,
      secret: 'secret',
      tokenExpiry: 60,
    });
    const shortLink = await short.requestStepUp({ sessionId });
    expect(shortLink.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(
      60_000,
    );
  });

  it('refuses a link after it expired, by row or by signature', async () => {
    const sessionId = await magicSession();

    const { token } = await links.requestStepUp({ sessionId });
    const [row] = await tokens.list({});
    if (!row) throw new Error('missing nonce row');
    row.expiresAt = new Date(Date.now() - 1000);
    await row.save();
    await expect(
      links.consumeStepUp({ token, sessionId }),
    ).rejects.toBeInstanceOf(StepUpRequiredError);

    const brief = await MagicLinkService.create({
      ...options,
      secret: 'secret',
      stepUpTokenExpiry: 1,
    });
    const quick = await brief.requestStepUp({ sessionId });
    await new Promise((resolve) => setTimeout(resolve, 2200));
    await expect(
      brief.consumeStepUp({ token: quick.token, sessionId }),
    ).rejects.toBeInstanceOf(StepUpRequiredError);
    expect((await context(sessionId)).reauthenticatedAt).toBeNull();
  });

  it('refuses a link that was already used', async () => {
    const sessionId = await magicSession();
    const { token } = await links.requestStepUp({ sessionId });
    await links.consumeStepUp({ token, sessionId });
    const first = (await context(sessionId)).reauthenticatedAt;
    await new Promise((resolve) => setTimeout(resolve, 15));
    await expect(
      links.consumeStepUp({ token, sessionId }),
    ).rejects.toBeInstanceOf(StepUpRequiredError);
    expect((await context(sessionId)).reauthenticatedAt).toEqual(first);
  });

  it('refuses a link used from another session, without burning it', async () => {
    const mine = await magicSession();
    const sameUserElsewhere = await magicSession();
    const { token } = await links.requestStepUp({ sessionId: mine });

    await expect(
      links.consumeStepUp({ token, sessionId: sameUserElsewhere }),
    ).rejects.toBeInstanceOf(StepUpRequiredError);
    expect((await context(sameUserElsewhere)).reauthenticatedAt).toBeNull();

    await links.consumeStepUp({ token, sessionId: mine });
    expect((await context(mine)).reauthenticatedAt).toBeInstanceOf(Date);
    expect((await context(sameUserElsewhere)).reauthenticatedAt).toBeNull();
  });

  it("refuses another user's session", async () => {
    const mine = await magicSession();
    const theirs = await magicSession(otherId);
    const { token } = await links.requestStepUp({ sessionId: mine });
    await expect(
      links.consumeStepUp({ token, sessionId: theirs }),
    ).rejects.toBeInstanceOf(StepUpRequiredError);
    expect((await context(theirs)).reauthenticatedAt).toBeNull();
    expect((await context(mine)).reauthenticatedAt).toBeNull();
  });

  it('refuses a link once the account email changed', async () => {
    const sessionId = await magicSession();
    const { token } = await links.requestStepUp({ sessionId });
    const owner = await users.get(ownerId);
    if (!owner) throw new Error('missing user');
    owner.email = 'moved@example.com';
    await owner.save();
    await expect(
      links.consumeStepUp({ token, sessionId }),
    ).rejects.toBeInstanceOf(StepUpRequiredError);
  });

  it('refuses a sign-in link as a step-up, and leaves it usable for sign-in', async () => {
    const sessionId = await magicSession();
    const { token } = await links.generate('owner@example.com');
    await expect(
      links.consumeStepUp({ token, sessionId }),
    ).rejects.toBeInstanceOf(StepUpRequiredError);
    expect((await context(sessionId)).reauthenticatedAt).toBeNull();
    await expect(links.verify(token)).resolves.toMatchObject({
      email: 'owner@example.com',
    });
  });

  it('refuses a step-up link as a sign-in, and leaves it usable for step-up', async () => {
    const sessionId = await magicSession();
    const { token } = await links.requestStepUp({ sessionId });
    await expect(links.verify(token)).rejects.toBeInstanceOf(MagicLinkError);
    await expect(links.inspect(token)).rejects.toBeInstanceOf(MagicLinkError);
    await links.consumeStepUp({ token, sessionId });
    expect((await context(sessionId)).reauthenticatedAt).toBeInstanceOf(Date);
  });

  it('refuses a forged purpose, a foreign signature and junk', async () => {
    const sessionId = await magicSession();
    const other = await MagicLinkService.create({
      ...options,
      secret: 'another-secret',
    });
    const { token } = await other.requestStepUp({ sessionId });
    await expect(
      links.consumeStepUp({ token, sessionId }),
    ).rejects.toBeInstanceOf(StepUpRequiredError);
    await expect(
      links.consumeStepUp({ token: 'junk', sessionId }),
    ).rejects.toBeInstanceOf(StepUpRequiredError);
    await expect(
      links.consumeStepUp({ token: '', sessionId: '' }),
    ).rejects.toBeInstanceOf(StepUpRequiredError);
  });

  it('refuses to issue for an unknown, layered, PIN or ceilinged session', async () => {
    await expect(
      links.requestStepUp({ sessionId: 'no-such-session' }),
    ).rejects.toBeInstanceOf(StepUpRequiredError);
    const parent = await magicSession();
    const child = await sessions.createSession(ownerId, undefined, {
      authMethod: 'pin',
      parentSessionId: parent,
    });
    await expect(
      links.requestStepUp({ sessionId: child }),
    ).rejects.toBeInstanceOf(StepUpRequiredError);
    const ceilinged = await sessions.createSession(ownerId, undefined, {
      authMethod: 'magic-link',
      data: { permissionCeiling: [] },
    });
    await expect(
      links.requestStepUp({ sessionId: ceilinged }),
    ).rejects.toBeInstanceOf(StepUpRequiredError);
  });
});
