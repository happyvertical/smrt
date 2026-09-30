/** Prebuilt portable MCP Apps resources. This module never compiles source. */
import { createHash } from 'node:crypto';
import type { McpAppPrincipal } from './server.js';

export const MCP_APP_RESOURCE_MIME = 'text/html;profile=mcp-app';
export const MCP_APP_RESOURCE_MAX_BYTES = 100 * 1024;
export interface McpAppResourceCsp {
  connectDomains?: readonly string[];
  resourceDomains?: readonly string[];
  frameDomains?: readonly string[];
  baseUriDomains?: readonly string[];
}
export interface McpAppResourceDefinition {
  /** Absolute ui:// URI containing the declared version as a path segment. */
  uri: string;
  name: string;
  version: string;
  /** Reproducibly built UTF-8 HTML; never per-user data or credentials. */
  html: string;
  description?: string;
  /** Only explicit static templates may be read without authentication. */
  public?: boolean;
  csp?: McpAppResourceCsp;
  permissions?: Partial<
    Record<
      'camera' | 'microphone' | 'geolocation' | 'clipboardWrite',
      Record<string, never>
    >
  >;
}
export interface McpAppResource {
  uri: string;
  name: string;
  description?: string;
  mimeType: typeof MCP_APP_RESOURCE_MIME;
  _meta: {
    ui: {
      csp: Required<McpAppResourceCsp>;
      permissions: NonNullable<McpAppResourceDefinition['permissions']>;
    };
    'com.happyvertical.smrt/resource': {
      version: string;
      sha256: string;
      bytes: number;
    };
  };
}
export interface McpAppResourceContent extends McpAppResource {
  text: string;
}
export type McpResourcePolicy = (context: {
  principal: McpAppPrincipal | null;
  resource: McpAppResource;
}) => boolean | Promise<boolean>;
export interface PreparedMcpAppResource {
  descriptor: McpAppResource;
  html: string;
  public: boolean;
}

function record(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError(`${label} must be an object.`);
}
function origin(value: string, connect = false): string {
  const url = new URL(value);
  if (
    !(connect ? ['https:', 'wss:'] : ['https:']).includes(url.protocol) ||
    url.origin !== value ||
    url.username ||
    url.password ||
    value.includes('*')
  ) {
    throw new TypeError(
      'Resource CSP entries must be exact HTTPS origins (WSS allowed for connections).',
    );
  }
  return value;
}

/** Validate static URL references; dynamic script networking still requires host CSP enforcement. */
function validateAssets(html: string, csp: Required<McpAppResourceCsp>): void {
  const check = (value: string, frames = false) => {
    if (
      !value ||
      value.startsWith('#') ||
      /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(value)
    )
      return;
    // Encoded/relative references cannot be audited against an exact origin.
    if (/[&\\\s]/.test(value))
      throw new TypeError(
        'Resource asset references must be literal absolute URLs.',
      );
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      !(frames ? csp.frameDomains : csp.resourceDomains).includes(url.origin)
    ) {
      throw new TypeError('Resource contains an undeclared external asset.');
    }
  };
  if (
    /<\s*(?:base|object|embed|meta)\b|\bsrcdoc\s*=|\bsrcset\s*=|@import\b/i.test(
      html,
    )
  ) {
    throw new TypeError(
      'Resource contains an unsupported asset construct; bundle assets inline.',
    );
  }
  for (const tag of html.matchAll(
    /<\s*([a-z][a-z0-9:-]*)\b((?:"[^"]*"|'[^']*'|[^'">])*)>/gi,
  )) {
    for (const attribute of tag[2].matchAll(
      /\b(src|href|poster|data|action|background|ping)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi,
    )) {
      check(
        attribute[2] ?? attribute[3] ?? attribute[4],
        tag[1].toLowerCase() === 'iframe',
      );
    }
  }
  for (const style of html.matchAll(
    /<style\b[^>]*>([\s\S]*?)<\/style>|\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi,
  )) {
    if (/[\\&]/.test(style[1] ?? style[2] ?? style[3] ?? style[4]))
      throw new TypeError(
        'CSS asset escapes are unsupported; bundle assets inline.',
      );
  }
  for (const url of html.matchAll(
    /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi,
  ))
    check((url[1] ?? url[2] ?? url[3]).trim());
}

/** Snapshot and validate a deterministic declaration at application startup/build. */
export function prepareMcpAppResource(
  definition: McpAppResourceDefinition,
): PreparedMcpAppResource {
  record(definition, 'Resource');
  const uri = new URL(definition.uri);
  if (
    uri.protocol !== 'ui:' ||
    !uri.hostname ||
    uri.username ||
    uri.password ||
    uri.search ||
    uri.hash ||
    uri.href !== definition.uri ||
    !/^[A-Za-z0-9._-]+$/.test(definition.version) ||
    !uri.pathname.split('/').includes(definition.version)
  ) {
    throw new TypeError(
      'Resource URI must be a canonical ui:// URI with an explicit version path segment.',
    );
  }
  if (
    typeof definition.name !== 'string' ||
    !definition.name.trim() ||
    typeof definition.html !== 'string' ||
    !definition.html.trim()
  )
    throw new TypeError('Resource name and prebuilt HTML are required.');
  if (
    definition.description !== undefined &&
    typeof definition.description !== 'string'
  )
    throw new TypeError('Resource description must be a string.');
  if (definition.public !== undefined && typeof definition.public !== 'boolean')
    throw new TypeError('Resource public must be boolean.');
  const bytes = Buffer.byteLength(definition.html, 'utf8');
  if (bytes > MCP_APP_RESOURCE_MAX_BYTES)
    throw new RangeError('Resource exceeds the 100 KiB raw HTML budget.');
  const csp: Required<McpAppResourceCsp> = {
    connectDomains: [],
    resourceDomains: [],
    frameDomains: [],
    baseUriDomains: [],
  };
  if (definition.csp !== undefined) {
    record(definition.csp, 'Resource CSP');
    for (const [key, values] of Object.entries(definition.csp)) {
      if (
        !Object.hasOwn(csp, key) ||
        !Array.isArray(values) ||
        values.some((value) => typeof value !== 'string')
      )
        throw new TypeError('Unknown or malformed resource CSP directive.');
      csp[key as keyof McpAppResourceCsp] = [
        ...new Set(
          values.map((value) => origin(value, key === 'connectDomains')),
        ),
      ].sort();
    }
  }
  const permissions: NonNullable<McpAppResourceDefinition['permissions']> = {};
  if (definition.permissions !== undefined) {
    record(definition.permissions, 'Resource permissions');
    for (const [key, value] of Object.entries(definition.permissions)) {
      record(value, 'Resource permission');
      if (
        !['camera', 'microphone', 'geolocation', 'clipboardWrite'].includes(
          key,
        ) ||
        Object.keys(value).length
      )
        throw new TypeError('Unknown or malformed resource permission.');
      permissions[key as keyof typeof permissions] = {};
    }
  }
  validateAssets(definition.html, csp);
  return {
    html: definition.html,
    public: definition.public === true,
    descriptor: {
      uri: definition.uri,
      name: definition.name,
      mimeType: MCP_APP_RESOURCE_MIME,
      ...(definition.description === undefined
        ? {}
        : { description: definition.description }),
      _meta: {
        ui: { csp, permissions },
        'com.happyvertical.smrt/resource': {
          version: definition.version,
          sha256: createHash('sha256')
            .update(definition.html, 'utf8')
            .digest('hex'),
          bytes,
        },
      },
    },
  };
}
