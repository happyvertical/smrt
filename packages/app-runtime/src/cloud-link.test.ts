/**
 * Cloud link protocol `smrt-cloud-link-v1` (#4806): both halves in-process.
 */

import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  type CloudLinkChallenge,
  type CloudLinkPrincipal,
  type CloudLinkStore,
  cloudLinkIdentityMap,
  cloudLinkProofTranscript,
  createCloudLinkService,
  createMemoryCloudLinkStore,
  deriveCloudLinkKeyPair,
  normalizeCloudOrigin,
  SYSTEM_ROLE_IDS,
  sanitizeCloudDisplay,
  signCloudLinkProof,
  verifyCloudLinkChallenge,
  verifyCloudLinkReceipt,
} from './cloud-link.js';
import { deriveLocalInstallationIdentity } from './local-installation-identity.js';

const ORIGIN = 'https://cloud.example.test';
const APP_ID = 'hearth';

function seed(): string {
  return randomBytes(32).toString('base64url');
}

function installation(secret = seed()) {
  const identity = deriveLocalInstallationIdentity(secret);
  const keys = deriveCloudLinkKeyPair(secret);
  return {
    secret,
    keys,
    installationId: identity.deviceId,
    identities: {
      tenantId: identity.tenantId,
      ownerId: identity.ownerId,
      profileId: identity.profileId,
      membershipId: identity.membershipId,
    },
  };
}

function principal(
  patch: Partial<CloudLinkPrincipal> = {},
): CloudLinkPrincipal {
  return {
    sessionId: randomUUID(),
    accountId: randomUUID(),
    accountEmail: 'owner@cloud.test',
    tenantId: randomUUID(),
    tenantName: 'Family',
    profileId: randomUUID(),
    membershipId: randomUUID(),
    isTenantOwner: true,
    tenantOwnerCount: 1,
    tenantMemberCount: 1,
    ...patch,
  };
}

function setup(options: { now?: () => Date; store?: CloudLinkStore } = {}) {
  const store = options.store ?? createMemoryCloudLinkStore();
  const service = createCloudLinkService({
    origin: ORIGIN,
    store,
    now: options.now,
  });
  return { store, service };
}

async function link(
  target: 'shared' | 'per-user' = 'shared',
  install = installation(),
  who = principal(),
  service = setup().service,
) {
  const issued = await service.issueChallenge(who, {
    appId: APP_ID,
    installationId: install.installationId,
    linkPublicKey: install.keys.publicKey,
    target,
  });
  const challenge = verifyCloudLinkChallenge(
    JSON.parse(JSON.stringify(issued)),
    {
      origin: ORIGIN,
      appId: APP_ID,
      installationId: install.installationId,
      linkPublicKey: install.keys.publicKey,
      accountId: who.accountId,
      tenantId: who.tenantId,
      target,
    },
  );
  const signature = signCloudLinkProof(
    install.keys.privateKey,
    challenge,
    install.identities,
  );
  return { install, who, service, challenge, signature };
}

describe('link key derivation', () => {
  it('is deterministic per seed and never coincides with a public identity', () => {
    const secret = seed();
    expect(deriveCloudLinkKeyPair(secret).publicKey).toBe(
      deriveCloudLinkKeyPair(secret).publicKey,
    );
    expect(deriveCloudLinkKeyPair(seed()).publicKey).not.toBe(
      deriveCloudLinkKeyPair(secret).publicKey,
    );
    // The private seed is HMAC under a purpose outside the UUID namespace, so
    // no published UUID ever carries its bytes.
    const key = Buffer.from(secret, 'base64url');
    const privateSeed = createHmac('sha256', key)
      .update('smrt/local-installation/v1/private-key/ed25519/cloud-link')
      .digest('hex');
    for (const uuid of Object.values(deriveLocalInstallationIdentity(secret))) {
      const hex = uuid.replaceAll('-', '');
      expect(privateSeed.includes(hex.slice(0, 12))).toBe(false);
    }
  });
});

describe('cloud link protocol', () => {
  it('links once, idempotently, with the hosted identity map', async () => {
    const { install, who, service, challenge, signature } = await link();
    const record = await service.completeChallenge(who, {
      challengeId: challenge.challengeId,
      localIdentities: install.identities,
      signature,
    });
    expect(
      verifyCloudLinkReceipt(record, challenge, install.identities),
    ).toEqual(record);
    expect(record.hostedIdentities).toEqual({
      tenantId: who.tenantId,
      ownerId: who.accountId,
      profileId: who.profileId,
      membershipId: who.membershipId,
    });
    const map = cloudLinkIdentityMap(record);
    expect(map.get(install.identities.ownerId)).toBe(who.accountId);
    for (const role of SYSTEM_ROLE_IDS) expect(map.get(role)).toBe(role);

    const again = await link('shared', install, who, service);
    const second = await service.completeChallenge(who, {
      challengeId: again.challenge.challengeId,
      localIdentities: install.identities,
      signature: again.signature,
    });
    expect(second.linkId).toBe(record.linkId);
  });

  it('maps identities to themselves on a per-user target with one member', async () => {
    const owner = installation();
    const { install, who, service, challenge, signature } = await link(
      'per-user',
      owner,
      principal({
        accountId: owner.identities.ownerId,
        tenantId: owner.identities.tenantId,
        profileId: owner.identities.profileId,
        membershipId: owner.identities.membershipId,
      }),
    );
    const record = await service.completeChallenge(who, {
      challengeId: challenge.challengeId,
      localIdentities: install.identities,
      signature,
    });
    expect(record.hostedIdentities).toEqual(install.identities);
    await expect(
      setup().service.issueChallenge(principal({ tenantMemberCount: 2 }), {
        appId: APP_ID,
        installationId: install.installationId,
        linkPublicKey: install.keys.publicKey,
        target: 'per-user',
      }),
    ).rejects.toMatchObject({ code: 'tenant_not_sole_member' });
  });

  it('refuses a per-user link whose hosted account is not the local owner', async () => {
    const { install, who, service, challenge, signature } =
      await link('per-user');
    await expect(
      service.completeChallenge(who, {
        challengeId: challenge.challengeId,
        localIdentities: install.identities,
        signature,
      }),
    ).rejects.toMatchObject({ code: 'challenge_mismatch' });
  });

  it('refuses a replayed challenge or proof', async () => {
    const { install, who, service, challenge, signature } = await link();
    const completion = {
      challengeId: challenge.challengeId,
      localIdentities: install.identities,
      signature,
    };
    await service.completeChallenge(who, completion);
    await expect(
      service.completeChallenge(who, completion),
    ).rejects.toMatchObject({
      code: 'challenge_unavailable',
    });
  });

  it('allows one attempt per challenge, even with a bad signature', async () => {
    const { install, who, service, challenge, signature } = await link();
    const bad = Buffer.from(signature, 'base64url');
    bad[0] ^= 1;
    await expect(
      service.completeChallenge(who, {
        challengeId: challenge.challengeId,
        localIdentities: install.identities,
        signature: bad.toString('base64url'),
      }),
    ).rejects.toMatchObject({ code: 'signature_invalid' });
    await expect(
      service.completeChallenge(who, {
        challengeId: challenge.challengeId,
        localIdentities: install.identities,
        signature,
      }),
    ).rejects.toMatchObject({ code: 'challenge_unavailable' });
  });

  it('binds the proof to the session, account and local identities', async () => {
    const first = await link();
    await expect(
      first.service.completeChallenge(
        { ...first.who, sessionId: randomUUID() },
        {
          challengeId: first.challenge.challengeId,
          localIdentities: first.install.identities,
          signature: first.signature,
        },
      ),
    ).rejects.toMatchObject({ code: 'challenge_unavailable' });
    // Another session cannot burn the challenge: its owner still completes.
    await expect(
      first.service.completeChallenge(first.who, {
        challengeId: first.challenge.challengeId,
        localIdentities: first.install.identities,
        signature: first.signature,
      }),
    ).resolves.toMatchObject({ accountId: first.who.accountId });

    const second = await link();
    await expect(
      second.service.completeChallenge(second.who, {
        challengeId: second.challenge.challengeId,
        localIdentities: {
          ...second.install.identities,
          ownerId: randomUUID(),
        },
        signature: second.signature,
      }),
    ).rejects.toMatchObject({ code: 'signature_invalid' });
  });

  it('refuses a proof signed by another installation key', async () => {
    const { install, who, service, challenge } = await link();
    const other = installation();
    await expect(
      service.completeChallenge(who, {
        challengeId: challenge.challengeId,
        localIdentities: install.identities,
        signature: signCloudLinkProof(
          other.keys.privateKey,
          challenge,
          install.identities,
        ),
      }),
    ).rejects.toMatchObject({ code: 'signature_invalid' });
  });

  it('refuses an expired challenge', async () => {
    let now = new Date('2026-11-08T00:00:00.000Z');
    const { service } = setup({ now: () => now });
    const { install, who, challenge, signature } = await (async () => {
      const install = installation();
      const who = principal();
      const issued = await service.issueChallenge(who, {
        appId: APP_ID,
        installationId: install.installationId,
        linkPublicKey: install.keys.publicKey,
        target: 'shared',
      });
      const challenge = verifyCloudLinkChallenge(issued, {
        origin: ORIGIN,
        appId: APP_ID,
        installationId: install.installationId,
        linkPublicKey: install.keys.publicKey,
        accountId: who.accountId,
        tenantId: who.tenantId,
        target: 'shared',
        now,
      });
      return {
        install,
        who,
        challenge,
        signature: signCloudLinkProof(
          install.keys.privateKey,
          challenge,
          install.identities,
        ),
      };
    })();
    now = new Date(now.getTime() + 6 * 60 * 1000);
    await expect(
      service.completeChallenge(who, {
        challengeId: challenge.challengeId,
        localIdentities: install.identities,
        signature,
      }),
    ).rejects.toMatchObject({ code: 'challenge_expired' });
    expect(() =>
      verifyCloudLinkChallenge(challenge, {
        origin: ORIGIN,
        appId: APP_ID,
        installationId: install.installationId,
        linkPublicKey: install.keys.publicKey,
        accountId: who.accountId,
        tenantId: who.tenantId,
        target: 'shared',
        now: new Date(now.getTime() + 60 * 1000),
      }),
    ).toThrow(expect.objectContaining({ code: 'challenge_expired' }));
  });

  it('refuses linking an installation to a second account (squatting)', async () => {
    const { store, service } = setup();
    const install = installation();
    const first = await link('shared', install, principal(), service);
    await service.completeChallenge(first.who, {
      challengeId: first.challenge.challengeId,
      localIdentities: install.identities,
      signature: first.signature,
    });
    const second = await link('shared', install, principal(), service);
    await expect(
      service.completeChallenge(second.who, {
        challengeId: second.challenge.challengeId,
        localIdentities: install.identities,
        signature: second.signature,
      }),
    ).rejects.toMatchObject({ code: 'installation_linked_elsewhere' });
    expect(
      await store.findLinkByPublicKey(install.keys.publicKey),
    ).toMatchObject({
      accountId: first.who.accountId,
    });
  });

  it('only lets a tenant owner link, and caps outstanding challenges', async () => {
    const install = installation();
    const request = {
      appId: APP_ID,
      installationId: install.installationId,
      linkPublicKey: install.keys.publicKey,
      target: 'shared' as const,
    };
    const { service } = setup();
    await expect(
      service.issueChallenge(principal({ isTenantOwner: false }), request),
    ).rejects.toMatchObject({ code: 'not_tenant_owner' });
    const who = principal();
    for (let index = 0; index < 5; index += 1) {
      await service.issueChallenge(who, request);
    }
    await expect(service.issueChallenge(who, request)).rejects.toMatchObject({
      code: 'too_many_challenges',
    });
  });
});

describe('local challenge checks', () => {
  async function issued(patch: Partial<CloudLinkPrincipal> = {}) {
    const install = installation();
    const who = principal(patch);
    const challenge = await setup().service.issueChallenge(who, {
      appId: APP_ID,
      installationId: install.installationId,
      linkPublicKey: install.keys.publicKey,
      target: 'shared',
    });
    const expected = {
      origin: ORIGIN,
      appId: APP_ID,
      installationId: install.installationId,
      linkPublicKey: install.keys.publicKey,
      accountId: who.accountId,
      tenantId: who.tenantId,
      target: 'shared' as const,
    };
    return { challenge, expected };
  }

  it.each([
    ['origin', { origin: 'https://cloud.example.test.evil.test' }],
    ['account', { accountId: randomUUID() }],
    ['tenant', { tenantId: randomUUID() }],
    ['application', { appId: 'other' }],
    ['target', { target: 'per-user' as const }],
    ['installation', { installationId: randomUUID() }],
  ])('refuses a challenge naming a different %s', async (_label, patch) => {
    const { challenge, expected } = await issued();
    expect(() =>
      verifyCloudLinkChallenge(challenge, { ...expected, ...patch }),
    ).toThrow(expect.objectContaining({ code: 'challenge_mismatch' }));
  });

  it('refuses a shared tenant with other owners unless confirmed', async () => {
    const { challenge, expected } = await issued({
      tenantOwnerCount: 2,
      tenantMemberCount: 3,
    });
    expect(() => verifyCloudLinkChallenge(challenge, expected)).toThrow(
      expect.objectContaining({ code: 'tenant_shared' }),
    );
    expect(
      verifyCloudLinkChallenge(challenge, {
        ...expected,
        allowSharedTenant: true,
      }).display.tenantOwnerCount,
    ).toBe(2);
  });

  it('strips control characters from display strings', async () => {
    const { challenge, expected } = await issued({
      accountEmail: 'evil\u001b[2J@x.test‮',
      tenantName: 'Fam\nily',
    });
    const checked = verifyCloudLinkChallenge(challenge, expected);
    expect(checked.display.accountEmail).toBe('evil[2J@x.test');
    expect(checked.display.tenantName).toBe('Family');
    expect(sanitizeCloudDisplay(42)).toBe('');
  });

  it('rejects a receipt that differs from what was signed', async () => {
    const { install, who, service, challenge, signature } = await link();
    const record = await service.completeChallenge(who, {
      challengeId: challenge.challengeId,
      localIdentities: install.identities,
      signature,
    });
    expect(() =>
      verifyCloudLinkReceipt(
        {
          ...record,
          hostedIdentities: {
            ...record.hostedIdentities,
            tenantId: randomUUID(),
          },
        },
        challenge,
        install.identities,
      ),
    ).toThrow(expect.objectContaining({ code: 'invalid_receipt' }));
  });
});

describe('transcript and origin', () => {
  it('normalizes origins and refuses insecure or non-bare ones', () => {
    expect(normalizeCloudOrigin('HTTPS://Cloud.Example.TEST:443')).toBe(ORIGIN);
    expect(normalizeCloudOrigin('http://127.0.0.1:5173')).toBe(
      'http://127.0.0.1:5173',
    );
    for (const bad of [
      'http://cloud.example.test',
      'https://cloud.example.test/path',
      'https://user:pw@cloud.example.test',
      'not a url',
    ]) {
      expect(() => normalizeCloudOrigin(bad)).toThrow();
    }
  });

  it('length-prefixes every field so boundaries cannot shift', () => {
    const install = installation();
    const base: CloudLinkChallenge = {
      protocol: 'smrt-cloud-link-v1',
      challengeId: randomUUID(),
      nonce: randomBytes(32).toString('base64url'),
      origin: ORIGIN,
      appId: 'ab',
      target: 'shared',
      accountId: randomUUID(),
      tenantId: randomUUID(),
      installationId: install.installationId,
      linkPublicKey: install.keys.publicKey,
      issuedAt: '2026-11-08T00:00:00.000Z',
      expiresAt: '2026-11-08T00:05:00.000Z',
      display: {
        accountEmail: '',
        tenantName: '',
        tenantOwnerCount: 1,
        tenantMemberCount: 1,
      },
    };
    const shifted = { ...base, origin: `${ORIGIN}a`, appId: 'b' };
    expect(
      cloudLinkProofTranscript(base, install.identities).equals(
        cloudLinkProofTranscript(shifted, install.identities),
      ),
    ).toBe(false);
  });
});
