/** Real HTTP synthetic authorization provider; production uses an existing issuer. */
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createMcpResourceAuth } from '../auth.js';

const keys = await generateKeyPair('RS256');
const jwk = {
  ...(await exportJWK(keys.publicKey)),
  kid: 'issuer-key',
  alg: 'RS256',
};
let issuer = '';
const redirect = 'http://127.0.0.1:9876/callback';
const clients = new Set(['pre-registered']);
const codes = new Map<string, URLSearchParams>();
let exchanges = 0;
const provider = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', issuer);
  const json = (status: number, data: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(data));
  };
  if (url.pathname === '/.well-known/oauth-authorization-server') {
    json(200, {
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/jwks`,
      registration_endpoint: `${issuer}/register`,
      authorization_response_iss_parameter_supported: true,
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
    });
    return;
  }
  if (url.pathname === '/jwks') {
    json(200, { keys: [jwk] });
    return;
  }
  if (url.pathname === '/register' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    const registration = JSON.parse(body);
    if (
      registration.redirect_uris?.[0] !== redirect ||
      registration.token_endpoint_auth_method !== 'none' ||
      registration.grant_types?.[0] !== 'authorization_code'
    ) {
      json(400, { error: 'invalid_client_metadata' });
      return;
    }
    const clientId = randomUUID();
    clients.add(clientId);
    json(201, { client_id: clientId });
    return;
  }
  if (url.pathname === '/authorize') {
    const p = url.searchParams;
    if (
      !clients.has(p.get('client_id') ?? '') ||
      p.get('redirect_uri') !== redirect ||
      p.get('response_type') !== 'code' ||
      p.get('code_challenge_method') !== 'S256' ||
      !p.get('code_challenge') ||
      p.get('resource') !== `${issuer}/mcp`
    ) {
      json(400, { error: 'invalid_request' });
      return;
    }
    const code = randomUUID();
    codes.set(code, p);
    const callback = new URL(redirect);
    callback.searchParams.set('code', code);
    callback.searchParams.set('state', p.get('state') ?? '');
    callback.searchParams.set('iss', issuer);
    res.writeHead(302, { location: callback.href }).end();
    return;
  }
  if (url.pathname === '/token' && req.method === 'POST') {
    exchanges++;
    let body = '';
    for await (const chunk of req) body += chunk;
    const p = new URLSearchParams(body);
    const code = p.get('code') ?? '';
    const grant = codes.get(code);
    codes.delete(code);
    if (
      !grant ||
      p.get('grant_type') !== 'authorization_code' ||
      p.get('client_id') !== grant.get('client_id') ||
      p.get('redirect_uri') !== redirect ||
      p.get('resource') !== grant.get('resource') ||
      createHash('sha256')
        .update(p.get('code_verifier') ?? '')
        .digest('base64url') !== grant.get('code_challenge')
    ) {
      json(400, { error: 'invalid_grant' });
      return;
    }
    const accessToken = await new SignJWT({ scope: grant.get('scope') })
      .setProtectedHeader({ alg: 'RS256', typ: 'at+jwt', kid: 'issuer-key' })
      .setIssuer(issuer)
      .setAudience(p.get('resource') ?? '')
      .setSubject('provider-alice')
      .setExpirationTime('2m')
      .sign(keys.privateKey);
    json(200, {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: 120,
    });
    return;
  }
  json(404, {});
});
beforeAll(async () => {
  await new Promise<void>((resolve) =>
    provider.listen(0, '127.0.0.1', resolve),
  );
  const address = provider.address();
  if (!address || typeof address === 'string') throw new Error('Missing port');
  issuer = `http://127.0.0.1:${address.port}`;
});
afterAll(() => new Promise<void>((resolve) => provider.close(() => resolve())));
const verifier = 'A'.repeat(64);
async function authorize(
  client = 'pre-registered',
  overrides: Record<string, string> = {},
) {
  const params = new URLSearchParams({
    client_id: client,
    redirect_uri: redirect,
    response_type: 'code',
    scope: 'read',
    resource: `${issuer}/mcp`,
    state: 'csrf-bound-state',
    code_challenge_method: 'S256',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    ...overrides,
  });
  return fetch(`${issuer}/authorize?${params}`, { redirect: 'manual' });
}
async function exchange(
  callback: URL,
  client = 'pre-registered',
  overrides: Record<string, string> = {},
) {
  // The host/client owns callback validation; the resource server never accepts codes.
  if (
    callback.searchParams.get('iss') !== issuer ||
    callback.searchParams.get('state') !== 'csrf-bound-state'
  )
    throw new Error('Invalid authorization response');
  return fetch(`${issuer}/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: client,
      redirect_uri: redirect,
      code: callback.searchParams.get('code') ?? '',
      code_verifier: verifier,
      resource: `${issuer}/mcp`,
      ...overrides,
    }),
  });
}
function callback(response: Response) {
  return new URL(response.headers.get('location') ?? 'invalid');
}

it('completes advertised PKCE and DCR/pre-registered modes, then reauthorizes on reconnect', async () => {
  const metadata = await (
    await fetch(`${issuer}/.well-known/oauth-authorization-server`)
  ).json();
  expect(metadata.issuer).toBe(issuer);
  expect(metadata.code_challenge_methods_supported).toEqual(['S256']);
  expect(metadata).not.toHaveProperty('client_id_metadata_document_supported');
  const registered = await (
    await fetch(metadata.registration_endpoint, {
      method: 'POST',
      body: JSON.stringify({
        application_type: 'native',
        redirect_uris: [redirect],
        grant_types: ['authorization_code'],
        token_endpoint_auth_method: 'none',
      }),
    })
  ).json();
  let active = true;
  const auth = createMcpResourceAuth({
    profile: 'local',
    issuer,
    resource: `${issuer}/mcp`,
    jwksUri: metadata.jwks_uri,
    algorithms: ['RS256'],
    scopes: ['read'],
    resolvePrincipal: async ({ subject }) =>
      active && subject === 'provider-alice'
        ? { id: 'app-alice', tenantId: 'tenant-a' }
        : null,
  });
  for (const client of ['pre-registered', registered.client_id]) {
    const authorization = await authorize(client);
    expect(authorization.status).toBe(302);
    const grant = await exchange(callback(authorization), client);
    expect(grant.status).toBe(200);
    const body = await grant.json();
    const request = new Request(`${issuer}/mcp`, {
      headers: { authorization: `Bearer ${body.access_token}` },
    });
    active = true;
    expect((await auth.authenticate(request)).ok).toBe(true);
    active = false;
    expect((await auth.authenticate(request)).ok).toBe(false);
    // New authorization does not bypass application revocation.
    const reconnect = await (
      await exchange(callback(await authorize(client)), client)
    ).json();
    expect(
      (
        await auth.authenticate(
          new Request(`${issuer}/mcp`, {
            headers: { authorization: `Bearer ${reconnect.access_token}` },
          }),
        )
      ).ok,
    ).toBe(false);
    expect((await exchange(callback(authorization), client)).status).toBe(400);
  }
});
it('rejects invalid proof, resource, redirect, unregistered client and code replay', async () => {
  for (const patch of [
    { code_verifier: 'wrong' },
    { resource: `${issuer}/other` },
    { redirect_uri: 'http://127.0.0.1:9876/other' },
  ]) {
    const location = callback(await authorize());
    expect((await exchange(location, 'pre-registered', patch)).status).toBe(
      400,
    );
    expect((await exchange(location)).status).toBe(400);
  }
  for (const patch of [
    { code_challenge_method: 'plain' },
    { resource: `${issuer}/other` },
    { redirect_uri: 'https://attacker.example' },
  ])
    expect((await authorize('pre-registered', patch)).status).toBe(400);
  expect((await authorize('unknown')).status).toBe(400);
});
it('client aborts callback mix-up before exchange, including missing issuer and bad state', async () => {
  for (const patch of ['missing', 'wrong', 'state']) {
    const location = callback(await authorize());
    const count = exchanges;
    if (patch === 'missing') location.searchParams.delete('iss');
    else if (patch === 'wrong') location.searchParams.set('iss', `${issuer}/`);
    else location.searchParams.set('state', 'wrong');
    await expect(exchange(location)).rejects.toThrow(
      'Invalid authorization response',
    );
    expect(exchanges).toBe(count);
  }
});
