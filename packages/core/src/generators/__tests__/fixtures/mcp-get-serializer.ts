import type { PublicJsonOptions, SmrtObject } from '../../../object.js';

let calls = 0;

export function resetMcpGetSerializerCalls(): void {
  calls = 0;
}

export function getMcpGetSerializerCalls(): number {
  return calls;
}

export async function serializeMcpGetFixture(
  item: SmrtObject,
  options?: PublicJsonOptions,
): Promise<Record<string, unknown>> {
  calls += 1;
  return {
    ...item.toPublicJSON(options),
    related: [item],
  };
}
