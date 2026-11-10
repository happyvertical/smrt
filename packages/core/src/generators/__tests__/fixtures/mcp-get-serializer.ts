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
  if (item.toPublicJSON(options).title === 'Reject me') {
    const error = new Error(
      'Tenant money migration is in progress',
    ) as Error & {
      code: string;
      publicMessage: string;
    };
    error.code = 'FROZEN_DOCUMENT';
    error.publicMessage = error.message;
    throw error;
  }
  return {
    ...item.toPublicJSON(options),
    related: [item],
  };
}
