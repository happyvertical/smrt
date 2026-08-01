import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createMcpClientIdMetadataDocument,
  type McpClientIdMetadataDocument,
  registerMcpClient,
  resolveMcpClientRegistration,
} from '../mcp-oauth.js';

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
});

const client = {
  applicationType: 'native' as const,
  clientId: 'https://client.example/oauth/mcp.json',
  clientName: 'Reference MCP Client',
  redirectUris: ['http://127.0.0.1:3210/callback'],
};

describe('MCP OAuth client registration', () => {
  it('uses a valid Client ID Metadata Document as the primary path', () => {
    const registration = resolveMcpClientRegistration(
      {
        client_id_metadata_document_supported: true,
        registration_endpoint: 'https://issuer.example/register',
      },
      client,
    );

    expect(registration).toEqual({
      clientId: client.clientId,
      kind: 'client_id_metadata_document',
      metadataDocument: {
        application_type: 'native',
        client_id: client.clientId,
        client_name: client.clientName,
        grant_types: ['authorization_code'],
        redirect_uris: client.redirectUris,
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      },
    });
  });

  it('retains application_type in the RFC 7591 DCR fallback', () => {
    const registration = resolveMcpClientRegistration(
      { registration_endpoint: 'https://issuer.example/register' },
      client,
    );

    expect(registration.kind).toBe('dynamic_client_registration');
    if (registration.kind !== 'dynamic_client_registration') return;
    expect(registration.request.application_type).toBe('native');
    expect(registration.request).not.toHaveProperty('client_id');
  });

  it('rejects a metadata client_id that is not an HTTPS document URL', () => {
    expect(() =>
      createMcpClientIdMetadataDocument({
        ...client,
        clientId: 'http://client.example/oauth/mcp.json',
      }),
    ).toThrow('must use HTTPS');
  });

  it('interoperates with a reference server using CIMD first and a real DCR POST as fallback', async () => {
    const requests: Record<string, unknown>[] = [];
    let hostedDocument: McpClientIdMetadataDocument | undefined;
    let referenceOrigin = '';
    const referenceServer = createServer((request, response) => {
      if (request.url === '/client.json' && request.method === 'GET') {
        response
          .writeHead(hostedDocument ? 200 : 404, {
            'content-type': 'application/json',
          })
          .end(hostedDocument ? JSON.stringify(hostedDocument) : undefined);
        return;
      }
      if (request.url?.startsWith('/authorize?') && request.method === 'GET') {
        void (async () => {
          const clientId = new URL(
            request.url ?? '',
            referenceOrigin,
          ).searchParams.get('client_id');
          // The localhost route stands in for DNS routing to the public HTTPS
          // client_id while retaining the exact public identifier in the body.
          const metadataResponse = await fetch(
            `${referenceOrigin}/client.json`,
          );
          const metadata = (await metadataResponse.json()) as Record<
            string,
            unknown
          >;
          if (metadata.client_id !== clientId) {
            response.writeHead(400).end();
            return;
          }
          response.writeHead(204).end();
        })().catch(() => response.writeHead(500).end());
        return;
      }
      if (request.url !== '/register' || request.method !== 'POST') {
        response.writeHead(404).end();
        return;
      }
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => {
        body += chunk;
      });
      request.on('end', () => {
        const registration = JSON.parse(body) as Record<string, unknown>;
        requests.push(registration);
        if (
          registration.application_type !== 'native' ||
          'client_id' in registration
        ) {
          response.writeHead(400).end();
          return;
        }
        response
          .writeHead(201, { 'content-type': 'application/json' })
          .end(JSON.stringify({ client_id: 'reference-dcr-client' }));
      });
    });
    servers.push(referenceServer);
    await new Promise<void>((resolve) =>
      referenceServer.listen(0, '127.0.0.1', resolve),
    );
    const address = referenceServer.address();
    if (!address || typeof address === 'string') throw new Error('no address');
    referenceOrigin = `http://127.0.0.1:${address.port}`;
    const registrationEndpoint = `${referenceOrigin}/register`;

    const cimd = await registerMcpClient(
      {
        client_id_metadata_document_supported: true,
        registration_endpoint: registrationEndpoint,
      },
      client,
    );
    expect(cimd.kind).toBe('client_id_metadata_document');
    expect(cimd.clientId).toBe(client.clientId);
    expect(cimd.metadataDocument?.client_id).toBe(client.clientId);
    expect(requests).toHaveLength(0);
    hostedDocument = cimd.metadataDocument;
    const authorization = await fetch(
      `${referenceOrigin}/authorize?client_id=${encodeURIComponent(cimd.clientId)}`,
    );
    expect(authorization.status).toBe(204);

    const dcr = await registerMcpClient(
      { registration_endpoint: registrationEndpoint },
      client,
    );
    expect(dcr).toMatchObject({
      clientId: 'reference-dcr-client',
      kind: 'dynamic_client_registration',
    });
    expect(requests).toEqual([
      expect.objectContaining({
        application_type: 'native',
        client_name: client.clientName,
      }),
    ]);
  });
});
