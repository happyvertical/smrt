import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as root from './index.js';
import * as reference from './reference/index.js';

const srcDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(srcDir, '..');
const read = (path: string) => readFileSync(resolve(packageDir, path), 'utf8');

const RELATIVE_IMPORT =
  /(?:from|import|export\s+\*\s+from)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g;
function reachable(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [resolve(srcDir, entry)];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const match of readFileSync(file, 'utf8').matchAll(RELATIVE_IMPORT)) {
      queue.push(
        resolve(dirname(file), (match[1] as string).replace(/\.js$/, '.ts')),
      );
    }
  }
  return new Set([...seen].map((file) => file.slice(srcDir.length + 1)));
}

/**
 * The runtime exports of the package root: the whole public surface of
 * contracts (a), (b) and (c). Adding a name here is a deliberate API decision.
 */
const ROOT_EXPORTS = [
  'BUNDLE_MANIFEST_FILENAME',
  'CLIENT_FAILURE_CODES',
  'CONTROL_PROTOCOL_VERSION',
  'CORE_CONTROL_ERROR_CODES',
  'CREDENTIAL_CONTROL_ERROR_CODES',
  'CREDENTIAL_ITEM_PREFIX',
  'DEFAULT_ENSURE_READY_TIMEOUT_MS',
  'DESKTOP_SHELL_DIRNAME',
  'DesktopContractError',
  'HANDOFF_FRAME_MAX_BYTES',
  'HandoffFrameDecoder',
  'INSTALLATION_RECORD_FILENAME',
  'INSTANCE_RECORD_FILENAME',
  'MAX_CONTROL_MESSAGE_BYTES',
  'MAX_ENSURE_READY_TIMEOUT_MS',
  'MAX_MINT_RESPONSE_BYTES',
  'MAX_UNIX_SOCKET_PATH_BYTES',
  'MIN_CREDENTIAL_LIFETIME_MS',
  'RESERVED_ENV_KEYS',
  'SHELL_BACKGROUND_FLAG',
  'SHELL_FAILURE_CODES',
  'SLOT_RECORD_FILENAME',
  'SecretString',
  'assertBundleMatchesSidecar',
  'buildSidecarEnv',
  'containsSecret',
  'coreControlCodec',
  'createControlChannelCredentialProvider',
  'createControlChannelSend',
  'createCredentialCustody',
  'createFileRendezvous',
  'credentialControlCodec',
  'credentialControlOp',
  'credentialItemName',
  'encodeHandoffFrame',
  'isControlPipeName',
  'isControlSocketPath',
  'isCredentialFailureCode',
  'isInstanceNonce',
  'isRendezvousFailureCode',
  'isShellFailureCode',
  'locateInstallation',
  'newSlotId',
  'newSlotRecord',
  'parseAcquireCredentialResponse',
  'parseBundleManifest',
  'parseControlEndpoint',
  'parseHandoffFrame',
  'parseInstallationRecord',
  'parseInstanceRecord',
  'parseMintResponse',
  'parseSidecarManifest',
  'parseSlotRecord',
  'readSlotRecord',
  'resolveAppLocalDataDir',
  'resolveDesktopShellDir',
  'serializeBundleManifest',
  'serializeInstallationRecord',
  'serializeInstanceRecord',
  'serializeSidecarManifest',
  'serializeSlotRecord',
  'spawnBridgeWithCredential',
  'writeSlotRecord',
];

/** What `/testing` carries: servers, doubles and low-level plumbing. */
const TESTING_ONLY = [
  'CORE_CONTROL_OPS',
  'ENSURE_READY_OP',
  'STATUS_OP',
  'controlErrorCodeFor',
  'controlSocketDirectory',
  'createControlCodec',
  'createControlHandlerRegistry',
  'createCredentialControlHandler',
  'createCredentialReferenceRegistry',
  'createMemorySecretItemStore',
  'createReferenceRegistry',
  'createReferenceSupervisor',
  'deriveControlEndpoint',
  'encodeAcquireCredentialResponse',
  'encodeControlRequest',
  'encodeControlResponse',
  'failureCodeFromSupervisorMessage',
  'parseControlRequest',
  'parseControlResponse',
  'parseInstanceStateResponse',
  'referenceControlContext',
  'registerAcquireCredential',
  'sendControlRequest',
  'serveControlChannelForTests',
  'shellLaunchEnvironment',
  'startReferenceShell',
];

describe('the package root exports an explicit list', () => {
  it('never uses export * (a new internal export cannot become public by accident)', () => {
    expect(read('src/index.ts')).not.toMatch(/export\s+\*/);
  });

  it('exports exactly the documented names', () => {
    expect(Object.keys(root).sort()).toEqual([...ROOT_EXPORTS].sort());
  });

  it('keeps the reference server, test doubles and low-level plumbing out of the root', () => {
    for (const name of TESTING_ONLY) {
      expect(Object.keys(root), name).not.toContain(name);
    }
    // The one name that used to be a production-sounding server.
    expect(Object.keys(root)).not.toContain('serveControlChannel');
  });

  it('does not reach the reference shell or the testing entry from the root', () => {
    const files = reachable('index.ts');
    expect(files).not.toContain('rendezvous/reference-shell.ts');
    expect(files).not.toContain('credentials/reference.ts');
    expect(files).not.toContain('reference/index.ts');
  });

  it('keeps the reference server out of the browser-safe webview entry', () => {
    const files = reachable('webview/index.ts');
    expect(
      [...files].filter((f) => /^(reference|rendezvous)\//.test(f)),
    ).toEqual([]);
  });
});

describe('the /testing subpath', () => {
  it('carries the reference server and the test doubles', () => {
    expect(Object.keys(reference).sort()).toEqual([...TESTING_ONLY].sort());
  });

  it('is declared in package.json and built as its own entry', () => {
    const exports = JSON.parse(read('package.json')).exports;
    expect(exports['./testing']).toEqual({
      types: './dist/testing.d.ts',
      import: './dist/testing.js',
    });
    expect(read('vite.config.ts')).toContain(
      "{ name: 'testing', source: 'src/testing.ts' }",
    );
  });

  it('is not excluded from the published declarations', () => {
    // dtsExclude drops `src/testing/**` (private fixtures); the public subpath
    // lives in `src/reference` precisely so its types ship.
    const exclude = /dtsExclude:\s*\[([^\]]*)\]/.exec(read('vite.config.ts'));
    expect(exclude?.[1]).toBeDefined();
    expect(exclude?.[1]).not.toContain('reference');
  });
});
