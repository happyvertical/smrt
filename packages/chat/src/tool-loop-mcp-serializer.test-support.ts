import type { PublicJsonOptions, SmrtObject } from '@happyvertical/smrt-core';

/** Local test-only serializer for the generic MCP get dispatcher. */
export function serializeToolLoopMcpGet(
  item: SmrtObject,
  options: PublicJsonOptions,
): { serializer: 'test'; title: unknown } {
  const publicItem = (
    item as SmrtObject & {
      toPublicJSON(options: PublicJsonOptions): Record<string, unknown>;
    }
  ).toPublicJSON(options);
  return { serializer: 'test', title: publicItem.title };
}
