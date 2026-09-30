/** Prebuilt portable MCP Apps resources. This module never compiles source. */
import { createHash } from 'node:crypto';
import { type DefaultTreeAdapterMap, parse } from 'parse5';
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
  /** Bounded JSON extension metadata; portable ui and digest keys are reserved. */
  metadata?: Record<string, unknown>;
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
  _meta: Record<string, unknown> & {
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
  function checkCss(css: string): void {
    if (/[\\&]|@import\b|(?:image-set|image|src)\s*\(/i.test(css))
      throw new TypeError(
        'CSS asset escapes and imports are unsupported; bundle assets inline.',
      );
    for (const url of css.matchAll(
      /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi,
    ))
      check((url[1] ?? url[2] ?? url[3]).trim());
  }
  function visit(node: DefaultTreeAdapterMap['node']): void {
    if ('tagName' in node) {
      const tag = node.tagName.toLowerCase();
      if (['base', 'object', 'embed', 'meta'].includes(tag))
        throw new TypeError(
          'Resource contains an unsupported asset construct; bundle assets inline.',
        );
      for (const attribute of node.attrs) {
        const name = attribute.name.toLowerCase();
        if (['srcdoc', 'srcset'].includes(name))
          throw new TypeError(
            'Resource contains an unsupported asset construct; bundle assets inline.',
          );
        if (
          [
            'src',
            'href',
            'poster',
            'data',
            'action',
            'formaction',
            'background',
            'ping',
          ].includes(name)
        )
          check(attribute.value, tag === 'iframe');
        if (
          [
            'style',
            'fill',
            'stroke',
            'filter',
            'clip-path',
            'mask',
            'cursor',
          ].includes(name)
        )
          checkCss(attribute.value);
      }
      if (tag === 'style') {
        checkCss(
          node.childNodes
            .map((child) => ('value' in child ? child.value : ''))
            .join(''),
        );
      }
      if ('content' in node)
        visit(node.content as DefaultTreeAdapterMap['documentFragment']);
    }
    if ('childNodes' in node) for (const child of node.childNodes) visit(child);
  }
  // HTML parsing preserves raw-text script boundaries, decoded attributes and
  // comments. Never interpret JavaScript new URL(...) or template strings as CSS.
  visit(parse(html));
}

/** Clone only inert, bounded JSON; extension data never becomes policy input. */
function resourceMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (metadata === undefined) return {};
  record(metadata, 'Resource metadata');
  if (
    Object.hasOwn(metadata, 'ui') ||
    Object.hasOwn(metadata, 'com.happyvertical.smrt/resource')
  )
    throw new TypeError('Resource metadata contains a reserved key.');
  const ancestors = new WeakSet<object>();
  function validate(value: unknown, depth = 0): void {
    if (depth > 16) throw new TypeError('Resource metadata exceeds 16 levels.');
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'boolean'
    )
      return;
    if (typeof value === 'number' && Number.isFinite(value)) return;
    if (typeof value !== 'object' || !value)
      throw new TypeError(
        'Resource metadata must contain only plain JSON values.',
      );
    if (
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    )
      throw new TypeError(
        'Resource metadata must contain only plain JSON objects.',
      );
    if (ancestors.has(value))
      throw new TypeError('Resource metadata must not contain cycles.');
    ancestors.add(value);
    for (const descriptor of Object.values(
      Object.getOwnPropertyDescriptors(value),
    )) {
      if ('get' in descriptor || 'set' in descriptor)
        throw new TypeError('Resource metadata accessors are not permitted.');
      validate(descriptor.value, depth + 1);
    }
    if (Object.getOwnPropertySymbols(value).length)
      throw new TypeError('Resource metadata symbol keys are not permitted.');
    ancestors.delete(value);
  }
  validate(metadata);
  const encoded = JSON.stringify(metadata);
  if (Buffer.byteLength(encoded, 'utf8') > 65536)
    throw new RangeError('Resource metadata exceeds 64 KiB.');
  return JSON.parse(encoded) as Record<string, unknown>;
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
        ...resourceMetadata(definition.metadata),
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
