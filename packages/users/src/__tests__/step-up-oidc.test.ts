/**
 * OIDC step-up (#4841 follow-up): a signed-in session re-authenticates with
 * the identity provider (`prompt=login`, `max_age=0`) and, on a verified
 * callback with a fresh `auth_time` for the SAME user, gets
 * `reauthenticatedAt` stamped on the existing session. A plain OIDC session is
 * never fresh by itself.
 */

import { OidcIdentityCollection } from '@happyvertical/smrt-profiles';
import {
  createIsolatedTestDb,
  type IsolatedTestDbResult,
} from '@happyvertical/smrt-vitest';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionCollection } from '../collections/SessionCollection.js';
import { SESSION_DATA_KEYS } from '../models/Session.js';
import { OidcLoginService } from '../services/OidcLoginService.js';
import { SessionService } from '../services/SessionService.js';
import {
  requireRecentAuthentication,
  StepUpRequiredError,
} from '../step-up.js';
import {
  closeAllOidcServers,
  OIDC_USERS_TEST_SCHEMA,
  type OidcTestServer,
  prepareOidcEmailKeyBackfills,
  startOidcServer,
} from './helpers/oidc-test-server.js';

const nowSeconds = () => Math.floor(Date.now() / 1000);

describe('OIDC step-up', () => {
  const cleanup: Array<() => Promise<void>> = [];
  let server: OidcTestServer;
  let isolated: IsolatedTestDbResult;
  let clockOffsetMs = 0;
  let service: OidcLoginService;
  let sessions: SessionService;
  let rows: SessionCollection;
  let userId: string;
  let profileId: string;

  beforeEach(async () => {
    clockOffsetMs = 0;
    server = await startOidcServer();
    cleanup.push(server.close);
    isolated = await createIsolatedTestDb({ schema: OIDC_USERS_TEST_SCHEMA });
    await prepareOidcEmailKeyBackfills(isolated.db);
    cleanup.push(isolated.cleanup);
    const { db } = isolated;
    service = new OidcLoginService({
      db,
      now: () => new Date(Date.now() + clockOffsetMs),
      provider: {
        clientId: 'smrt-client',
        clientSecret: 'secret',
        issuer: server.issuer,
        kind: 'dex',
        redirectUri: `${server.issuer}/auth/dex/step-up`,
      },
      providerName: 'dex',
    });
    sessions = await SessionService.create({ db });
    rows = await SessionCollection.create({ db });

    // The person's one existing OIDC identity: a real first sign-in.
    const tx = service.createTransaction();
    server.setNonce(tx.nonce);
    const callback = new URL(`${server.issuer}/auth/dex/step-up`);
    callback.searchParams.set('code', 'sign-in-code');
    callback.searchParams.set('state', tx.state);
    const login = await service.completeLogin(callback, tx);
    userId = login.user.id as string;
    profileId = login.user.profileId;
  });

  afterEach(async () => {
    while (cleanup.length > 0) await cleanup.pop()?.();
  });

  afterAll(async () => {
    await closeAllOidcServers();
  });

  /** A plain OIDC sign-in session, as the sign-in callback would mint. */
  const oidcSession = () =>
    sessions.createSession(userId, undefined, { authMethod: 'oidc' });

  const context = async (sessionId: string) => {
    const ctx = await sessions.loadSessionContext(sessionId);
    if (!ctx) throw new Error('session did not load');
    return ctx;
  };

  /**
   * Start a step-up and return the callback the provider would redirect to
   * with `auth_time` (default: now) in its next ID token.
   */
  const startStepUp = async (
    sessionId: string,
    authTime: number | null = nowSeconds(),
  ) => {
    const { url, state } = await service.beginStepUp({ sessionId });
    server.setNonce(url.searchParams.get('nonce') as string);
    server.setAuthTime(authTime ?? undefined);
    const callback = new URL(`${server.issuer}/auth/dex/step-up`);
    callback.searchParams.set('code', 'step-up-code');
    callback.searchParams.set('state', state);
    return { url, state, callback };
  };

  it('does not count a plain OIDC session as a fresh authentication', async () => {
    const sessionId = await oidcSession();
    const ctx = await context(sessionId);
    expect(ctx.reauthenticatedAt).toBeNull();
    expect(() => requireRecentAuthentication(ctx)).toThrow(StepUpRequiredError);
  });

  it('forces re-authentication on the authorization request', async () => {
    const sessionId = await oidcSession();
    const { url } = await startStepUp(sessionId);
    expect(url.searchParams.get('prompt')).toBe('login');
    expect(url.searchParams.get('max_age')).toBe('0');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBeTruthy();
    expect(url.searchParams.get('nonce')).toBeTruthy();
  });

  it('stamps the existing session when the provider re-authenticated the same person', async () => {
    const sessionId = await oidcSession();
    const before = await rows.list({});
    const { callback } = await startStepUp(sessionId);

    const result = await service.completeStepUp({
      sessionId,
      callbackUrl: callback,
    });

    expect(result.sessionId).toBe(sessionId);
    const ctx = await context(sessionId);
    expect(ctx.reauthenticatedAt?.toISOString()).toBe(result.reauthenticatedAt);
    expect(() => requireRecentAuthentication(ctx)).not.toThrow();
    // No session minted, no user switched, intent gone.
    const after = await rows.list({});
    expect(after).toHaveLength(before.length);
    expect(ctx.user.id).toBe(userId);
    const row = await rows.get(sessionId);
    expect(row?.data?.[SESSION_DATA_KEYS.oidcStepUpIntent]).toBeUndefined();
  });

  it('passes requireRecentAuthentication only after the deliberate step-up', async () => {
    const sessionId = await oidcSession();
    const stale = await context(sessionId);
    expect(() => requireRecentAuthentication(stale)).toThrow(
      StepUpRequiredError,
    );
    // Starting a step-up proves nothing by itself.
    const { callback } = await startStepUp(sessionId);
    expect(() =>
      requireRecentAuthentication(stale, { expectedSessionId: sessionId }),
    ).toThrow(StepUpRequiredError);
    expect((await context(sessionId)).reauthenticatedAt).toBeNull();
    await service.completeStepUp({ sessionId, callbackUrl: callback });
    const fresh = await context(sessionId);
    expect(() =>
      requireRecentAuthentication(fresh, {
        expectedSessionId: sessionId,
        expectedUserId: userId,
      }),
    ).not.toThrow();
  });

  it.each([
    ['stale', () => nowSeconds() - 3600],
    ['missing', () => null],
    ['in the future', () => nowSeconds() + 3600],
    // Recent enough for the window, but older than the step-up request: a
    // provider that ignored prompt/max_age and reused its browser login.
    ['older than the request', () => nowSeconds() - 120],
  ])('refuses an ID token whose auth_time is %s', async (_name, authTime) => {
    const sessionId = await oidcSession();
    const { callback } = await startStepUp(sessionId, authTime());
    await expect(
      service.completeStepUp({ sessionId, callbackUrl: callback }),
    ).rejects.toBeInstanceOf(StepUpRequiredError);
    expect((await context(sessionId)).reauthenticatedAt).toBeNull();
  });

  it('refuses a subject that is not the session user, and one that maps to another person', async () => {
    const sessionId = await oidcSession();

    server.setSubject('stranger-sub');
    const unknown = await startStepUp(sessionId);
    await expect(
      service.completeStepUp({ sessionId, callbackUrl: unknown.callback }),
    ).rejects.toBeInstanceOf(StepUpRequiredError);

    // An identity that exists, but belongs to a different person.
    const identities = await OidcIdentityCollection.create({
      db: isolated.db,
    });
    const other = await identities.create({
      profileId: `${profileId}-someone-else`,
      provider: 'dex',
      issuer: server.issuer,
      subject: 'other-person-sub',
    });
    await other.save();
    server.setSubject('other-person-sub');
    const mapped = await startStepUp(sessionId);
    await expect(
      service.completeStepUp({ sessionId, callbackUrl: mapped.callback }),
    ).rejects.toBeInstanceOf(StepUpRequiredError);

    expect((await context(sessionId)).reauthenticatedAt).toBeNull();
    expect((await context(sessionId)).user.id).toBe(userId);
  });

  it('refuses a replayed callback: the intent is single use', async () => {
    const sessionId = await oidcSession();
    const { callback } = await startStepUp(sessionId);
    await service.completeStepUp({ sessionId, callbackUrl: callback });
    const first = (await context(sessionId)).reauthenticatedAt;

    await new Promise((resolve) => setTimeout(resolve, 15));
    await expect(
      service.completeStepUp({ sessionId, callbackUrl: callback }),
    ).rejects.toBeInstanceOf(StepUpRequiredError);
    expect((await context(sessionId)).reauthenticatedAt).toEqual(first);
  });

  it('burns the intent on a refused attempt', async () => {
    const sessionId = await oidcSession();
    const { callback, state } = await startStepUp(
      sessionId,
      nowSeconds() - 3600,
    );
    await expect(
      service.completeStepUp({ sessionId, callbackUrl: callback }),
    ).rejects.toBeInstanceOf(StepUpRequiredError);
    // The same callback with a now-fresh token cannot be retried.
    server.setAuthTime(nowSeconds());
    const retry = new URL(callback);
    retry.searchParams.set('state', state);
    await expect(
      service.completeStepUp({ sessionId, callbackUrl: retry }),
    ).rejects.toBeInstanceOf(StepUpRequiredError);
  });

  it("refuses another session's intent and callback", async () => {
    const a = await oidcSession();
    const b = await oidcSession();
    const forA = await startStepUp(a);

    // B never started a step-up.
    await expect(
      service.completeStepUp({ sessionId: b, callbackUrl: forA.callback }),
    ).rejects.toBeInstanceOf(StepUpRequiredError);

    // B started its own, but presents A's state.
    const forB = await startStepUp(b);
    server.setNonce(new URL(forB.url).searchParams.get('nonce') as string);
    await expect(
      service.completeStepUp({ sessionId: b, callbackUrl: forA.callback }),
    ).rejects.toBeInstanceOf(StepUpRequiredError);
    expect((await context(b)).reauthenticatedAt).toBeNull();

    // A's own intent was not touched by B's attempts: it still completes.
    server.setNonce(new URL(forA.url).searchParams.get('nonce') as string);
    await service.completeStepUp({ sessionId: a, callbackUrl: forA.callback });
    expect((await context(a)).reauthenticatedAt).toBeInstanceOf(Date);
    expect((await context(b)).reauthenticatedAt).toBeNull();
  });

  it('refuses an expired intent', async () => {
    const sessionId = await oidcSession();
    const { callback } = await startStepUp(sessionId);
    clockOffsetMs = 400_000;
    await expect(
      service.completeStepUp({ sessionId, callbackUrl: callback }),
    ).rejects.toBeInstanceOf(StepUpRequiredError);
    expect((await context(sessionId)).reauthenticatedAt).toBeNull();
  });

  it('refuses to start for an unknown, layered, PIN or ceilinged session', async () => {
    await expect(
      service.beginStepUp({ sessionId: 'no-such-session' }),
    ).rejects.toBeInstanceOf(StepUpRequiredError);
    const parent = await oidcSession();
    const child = await sessions.createSession(userId, undefined, {
      authMethod: 'pin',
      parentSessionId: parent,
    });
    await expect(
      service.beginStepUp({ sessionId: child }),
    ).rejects.toBeInstanceOf(StepUpRequiredError);
    const ceilinged = await sessions.createSession(userId, undefined, {
      authMethod: 'oidc',
      data: { [SESSION_DATA_KEYS.permissionCeiling]: [] },
    });
    await expect(
      service.beginStepUp({ sessionId: ceilinged }),
    ).rejects.toBeInstanceOf(StepUpRequiredError);
  });

  it('keeps the intent out of client reach', async () => {
    const sessionId = await oidcSession();
    expect(
      await sessions.setSessionData(
        sessionId,
        SESSION_DATA_KEYS.oidcStepUpIntent,
        { forged: true },
      ),
    ).toBe(false);
  });
});
