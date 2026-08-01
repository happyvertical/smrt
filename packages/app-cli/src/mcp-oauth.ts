/** MCP OAuth client-registration helpers for remote HTTP deployments. */

export type OAuthApplicationType = 'native' | 'web';

export interface McpClientIdMetadataDocument {
  application_type: OAuthApplicationType;
  client_id: string;
  client_name: string;
  grant_types: ['authorization_code'];
  redirect_uris: string[];
  response_types: ['code'];
  token_endpoint_auth_method: 'none';
}

export interface OAuthAuthorizationServerMetadata {
  client_id_metadata_document_supported?: boolean;
  registration_endpoint?: string;
}

export interface McpClientRegistrationOptions {
  applicationType: OAuthApplicationType;
  /** HTTPS metadata-document URL. Required only when CIMD is advertised. */
  clientId?: string;
  clientName: string;
  redirectUris: string[];
}

export type McpClientRegistration =
  | {
      clientId: string;
      kind: 'client_id_metadata_document';
      metadataDocument: McpClientIdMetadataDocument;
    }
  | {
      endpoint: string;
      kind: 'dynamic_client_registration';
      request: Omit<McpClientIdMetadataDocument, 'client_id'>;
    };

export interface McpRegisteredClient {
  clientId: string;
  kind: McpClientRegistration['kind'];
  metadataDocument?: McpClientIdMetadataDocument;
  registrationResponse?: Record<string, unknown>;
}

type McpRegistrationRequest = Omit<McpClientIdMetadataDocument, 'client_id'>;

function createMcpRegistrationRequest(
  options: McpClientRegistrationOptions,
): McpRegistrationRequest {
  if (!options.clientName.trim()) {
    throw new Error('MCP client_name must not be empty.');
  }
  if (options.redirectUris.length === 0) {
    throw new Error('MCP client metadata requires at least one redirect URI.');
  }
  for (const redirectUri of options.redirectUris) new URL(redirectUri);

  return {
    application_type: options.applicationType,
    client_name: options.clientName,
    grant_types: ['authorization_code'],
    redirect_uris: [...options.redirectUris],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  };
}

/** Build and validate the document hosted at an HTTPS URL used as client_id. */
export function createMcpClientIdMetadataDocument(
  options: McpClientRegistrationOptions,
): McpClientIdMetadataDocument {
  if (!options.clientId) {
    throw new Error('MCP client_id metadata URL is required for CIMD.');
  }
  const clientId = new URL(options.clientId);
  if (clientId.protocol !== 'https:' || clientId.pathname === '/') {
    throw new Error(
      'MCP client_id metadata URL must use HTTPS and include a path.',
    );
  }
  if (clientId.search || clientId.hash) {
    throw new Error(
      'MCP client_id metadata URL must not include query or fragment.',
    );
  }
  return {
    ...createMcpRegistrationRequest(options),
    client_id: options.clientId,
  };
}

/**
 * Select registration in MCP priority order: Client ID Metadata Documents
 * first, then RFC 7591 DCR as a compatibility fallback.
 */
export function resolveMcpClientRegistration(
  authorizationServer: OAuthAuthorizationServerMetadata,
  options: McpClientRegistrationOptions,
): McpClientRegistration {
  if (authorizationServer.client_id_metadata_document_supported === true) {
    const metadataDocument = createMcpClientIdMetadataDocument(options);
    return {
      clientId: metadataDocument.client_id,
      kind: 'client_id_metadata_document',
      metadataDocument,
    };
  }

  if (authorizationServer.registration_endpoint) {
    return {
      endpoint: authorizationServer.registration_endpoint,
      kind: 'dynamic_client_registration',
      request: createMcpRegistrationRequest(options),
    };
  }

  throw new Error(
    'Authorization server supports neither Client ID Metadata Documents nor dynamic client registration.',
  );
}

/**
 * Complete client registration against discovered authorization-server
 * metadata. A Client ID Metadata Document needs no registration request: the
 * authorization server retrieves it from the HTTPS client_id. The legacy DCR
 * fallback is executed as an RFC 7591 JSON POST.
 */
export async function registerMcpClient(
  authorizationServer: OAuthAuthorizationServerMetadata,
  options: McpClientRegistrationOptions,
  fetchImpl: typeof fetch = fetch,
): Promise<McpRegisteredClient> {
  const registration = resolveMcpClientRegistration(
    authorizationServer,
    options,
  );
  if (registration.kind === 'client_id_metadata_document') {
    return {
      clientId: registration.clientId,
      kind: registration.kind,
      metadataDocument: registration.metadataDocument,
    };
  }

  const response = await fetchImpl(registration.endpoint, {
    body: JSON.stringify(registration.request),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  });
  if (!response.ok) {
    throw new Error(
      `Dynamic client registration failed: HTTP ${response.status}`,
    );
  }
  const body: unknown = await response.json();
  if (
    typeof body !== 'object' ||
    body === null ||
    typeof (body as Record<string, unknown>).client_id !== 'string' ||
    !(body as Record<string, unknown>).client_id
  ) {
    throw new Error('Dynamic client registration response omitted client_id.');
  }
  return {
    clientId: (body as Record<string, unknown>).client_id as string,
    kind: registration.kind,
    registrationResponse: body as Record<string, unknown>,
  };
}
