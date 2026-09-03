/**
 * The expected WebMCP inventory for the running reference app.
 *
 * The inventory is not restated here. It comes from the canonical
 * cross-profile surface helpers landed by #2578, which read the same public
 * generator output the parity snapshots compare. This gate's job is to prove
 * that what a real browser actually receives at runtime equals what those
 * snapshots say the surface is — restating the expectation locally would
 * prove only that this file agrees with itself.
 */

import {
  captureRuntimeProfileSurfaces,
  OPERATIONAL_DIAGNOSTIC_TOOL_NAME,
} from '../../__tests__/support/runtimeSurfaceParity.js';

export interface ExpectedTool {
  readonly name: string;
  readonly effect: string;
  readonly readOnly: boolean;
  readonly idempotent: boolean;
  readonly openWorld: boolean;
  readonly requiresApproval: boolean;
}

export interface ExpectedInventory {
  /** Every generated domain tool the app declares, read and non-read alike. */
  readonly domainTools: readonly ExpectedTool[];
  /** Domain tools a read-only exposure policy may register in a browser. */
  readonly exposedDomainToolNames: readonly string[];
  /** Domain tools whose effects keep them behind a consent boundary. */
  readonly consentGatedDomainToolNames: readonly string[];
  /** The single allowlisted authored operational tool. */
  readonly operationalDiagnosticToolName: string;
}

/**
 * @param captureRoot an empty, test-owned directory. The #2578 helper takes
 * its own fresh copy of the reference app there rather than reading the
 * running one, so the expectation cannot be contaminated by runtime state.
 */
export async function resolveExpectedInventory(
  captureRoot: string,
): Promise<ExpectedInventory> {
  const surfaces = await captureRuntimeProfileSurfaces(captureRoot, 'local');
  const tools: ExpectedTool[] = surfaces.domainTools
    .filter((tool) => tool.exposure.webMcp)
    .map((tool) => ({
      name: tool.name,
      effect: tool.effect,
      readOnly: tool.readOnly,
      idempotent: tool.idempotent,
      openWorld: tool.openWorld,
      requiresApproval: tool.requiresApproval,
    }));

  return {
    domainTools: tools,
    exposedDomainToolNames: tools
      .filter((tool) => tool.effect === 'read')
      .map((tool) => tool.name)
      .sort(),
    consentGatedDomainToolNames: tools
      .filter((tool) => tool.effect !== 'read')
      .map((tool) => tool.name)
      .sort(),
    operationalDiagnosticToolName: OPERATIONAL_DIAGNOSTIC_TOOL_NAME,
  };
}
