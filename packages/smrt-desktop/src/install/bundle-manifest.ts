import { DesktopContractError } from '../errors.js';
import { deepFreeze } from '../internal/freeze.js';
import {
  isBundleId,
  isChannel,
  isDisplayText,
  isEnvPrefix,
  isLoopbackRoute,
  isPortablePath,
  isPortableSegment,
  isSemver,
  isSlug,
  isTargetTriple,
} from '../internal/grammar.js';
import {
  hasClosedKeys,
  isRecord,
  parseStrictJson,
} from '../internal/strict-json.js';
import type { SidecarManifestV1 } from '../sidecar-manifest.js';

/** File name of the bundle manifest inside the Tauri resource directory. */
export const BUNDLE_MANIFEST_FILENAME = 'smrt-bundle.json';

/**
 * Static identity and resource-relative layout of an installed SMRT desktop
 * product, written by the runtime bundler next to `sidecar-manifest.json`.
 * It holds no absolute path: those only exist once the app is installed, and
 * are recorded in `installation.json`.
 */
export interface BundleManifestV1 {
  readonly version: 1;
  /** Lowercase kebab-case product slug, at most 64 characters. */
  readonly productId: string;
  /** Tauri `identifier`, reverse-DNS. */
  readonly bundleId: string;
  /** Plain single-line product name. */
  readonly displayName: string;
  /** Semantic version of the product. */
  readonly productVersion: string;
  /** Release channel such as `stable` or `beta`. */
  readonly channel: string;
  /** Rust target triple the bundle was built for. */
  readonly target: string;
  /** Resource-relative portable path of the v1 sidecar manifest. */
  readonly sidecarManifest: string;
  readonly node: {
    /**
     * Logical Tauri `externalBin` basename of the Node sidecar. Use a
     * product-scoped name such as `smrt-start-node`, never a bare `node`: Tauri
     * installs sidecars next to the main binary, which is `/usr/bin` for
     * `.deb` and `.rpm`, and `node` would collide with the distribution's own.
     * Must equal the sidecar manifest's `executable`.
     */
    readonly executable: string;
  };
  readonly bridge: {
    /** Resource-relative portable path of the single-file MCP bridge. */
    readonly entry: string;
    /** Prefix of the bridge's environment variables, such as `SMRT_NOTES`. */
    readonly envPrefix: string;
    /** Path of the MCP endpoint on the sidecar origin. */
    readonly mcpPath: string;
    readonly serverName?: string;
    readonly serverVersion?: string;
  };
}

const requiredKeys = [
  'version',
  'productId',
  'bundleId',
  'displayName',
  'productVersion',
  'channel',
  'target',
  'sidecarManifest',
  'node',
  'bridge',
] as const satisfies readonly (keyof BundleManifestV1)[];
const nodeKeys = ['executable'] as const;
const bridgeRequired = ['entry', 'envPrefix', 'mcpPath'] as const;
const bridgeOptional = ['serverName', 'serverVersion'] as const;
const bridgeEntryExtension = /\.(?:mjs|js)$/;

function invalid(field: string): DesktopContractError {
  return new DesktopContractError('invalid_field', { field });
}

function isBridgeEntry(value: unknown): value is string {
  return (
    isPortablePath(value) &&
    bridgeEntryExtension.test(value.slice(value.lastIndexOf('/') + 1))
  );
}

/** Validate untrusted data and return a frozen v1 snapshot. */
function validateBundleManifest(input: unknown): BundleManifestV1 {
  if (!isRecord(input)) throw new DesktopContractError('invalid_document');
  if (!Object.hasOwn(input, 'version')) {
    throw new DesktopContractError('invalid_document');
  }
  if (input.version !== 1) {
    throw new DesktopContractError('unsupported_contract');
  }
  if (!hasClosedKeys(input, requiredKeys)) {
    throw new DesktopContractError('invalid_document');
  }

  const {
    productId,
    bundleId,
    displayName,
    productVersion,
    channel,
    target,
    sidecarManifest,
    node,
    bridge,
  } = input;
  if (!isSlug(productId)) throw invalid('productId');
  if (!isBundleId(bundleId)) throw invalid('bundleId');
  if (!isDisplayText(displayName)) throw invalid('displayName');
  if (!isSemver(productVersion)) throw invalid('productVersion');
  if (!isChannel(channel)) throw invalid('channel');
  if (!isTargetTriple(target)) throw invalid('target');
  if (!isPortablePath(sidecarManifest)) throw invalid('sidecarManifest');

  if (!isRecord(node) || !hasClosedKeys(node, nodeKeys)) {
    throw invalid('node');
  }
  if (!isPortableSegment(node.executable)) throw invalid('node.executable');

  if (
    !isRecord(bridge) ||
    !hasClosedKeys(bridge, bridgeRequired, bridgeOptional)
  ) {
    throw invalid('bridge');
  }
  if (!isBridgeEntry(bridge.entry)) throw invalid('bridge.entry');
  if (!isEnvPrefix(bridge.envPrefix)) throw invalid('bridge.envPrefix');
  if (!isLoopbackRoute(bridge.mcpPath)) throw invalid('bridge.mcpPath');
  const hasName = Object.hasOwn(bridge, 'serverName');
  if (hasName && !isDisplayText(bridge.serverName, 64)) {
    throw invalid('bridge.serverName');
  }
  const hasVersion = Object.hasOwn(bridge, 'serverVersion');
  if (hasVersion && !isSemver(bridge.serverVersion)) {
    throw invalid('bridge.serverVersion');
  }

  return deepFreeze({
    version: 1,
    productId,
    bundleId,
    displayName,
    productVersion,
    channel,
    target,
    sidecarManifest,
    node: { executable: node.executable },
    bridge: {
      entry: bridge.entry,
      envPrefix: bridge.envPrefix,
      mcpPath: bridge.mcpPath,
      ...(hasName ? { serverName: bridge.serverName as string } : {}),
      ...(hasVersion ? { serverVersion: bridge.serverVersion as string } : {}),
    },
  });
}

/**
 * Parse `smrt-bundle.json`. Throws a `DesktopContractError` with a fixed,
 * value-free message: `invalid_json`, `duplicate_keys`, `unsupported_contract`
 * (a `version` other than 1), `invalid_document` or `invalid_field`.
 */
export function parseBundleManifest(json: string): BundleManifestV1 {
  if (typeof json !== 'string') {
    throw new DesktopContractError('invalid_json');
  }
  const parsed = parseStrictJson(json);
  if (!parsed.ok) {
    throw new DesktopContractError(
      parsed.reason === 'syntax' ? 'invalid_json' : 'duplicate_keys',
    );
  }
  return validateBundleManifest(parsed.value);
}

/**
 * Serialize a manifest as canonical JSON (fixed key order, two-space indent,
 * trailing newline). The input is validated first, so a bundler cannot write
 * a document the parser would reject.
 */
export function serializeBundleManifest(manifest: BundleManifestV1): string {
  const m = validateBundleManifest(manifest);
  return `${JSON.stringify(
    {
      version: m.version,
      productId: m.productId,
      bundleId: m.bundleId,
      displayName: m.displayName,
      productVersion: m.productVersion,
      channel: m.channel,
      target: m.target,
      sidecarManifest: m.sidecarManifest,
      node: { executable: m.node.executable },
      bridge: {
        entry: m.bridge.entry,
        envPrefix: m.bridge.envPrefix,
        mcpPath: m.bridge.mcpPath,
        ...(m.bridge.serverName === undefined
          ? {}
          : { serverName: m.bridge.serverName }),
        ...(m.bridge.serverVersion === undefined
          ? {}
          : { serverVersion: m.bridge.serverVersion }),
      },
    },
    null,
    2,
  )}\n`;
}

/**
 * Cross-check a bundle manifest against the v1 sidecar manifest it names:
 * `node.executable` must equal the sidecar's `executable`. Throws
 * `sidecar_mismatch` otherwise.
 */
export function assertBundleMatchesSidecar(
  bundle: Pick<BundleManifestV1, 'node'>,
  sidecar: Pick<SidecarManifestV1, 'executable'>,
): void {
  if (bundle.node.executable !== sidecar.executable) {
    throw new DesktopContractError('sidecar_mismatch', {
      field: 'node.executable',
    });
  }
}
