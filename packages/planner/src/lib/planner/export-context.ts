import type { BrowserAssistantTransport } from '../assistant/transport.ts';
import type { ExportData, PlannerController } from './commands/index.ts';
import type { PlannerExportContext } from './types.ts';

/** Synchronous capture: no user edit or model completion can interleave it. */
export function capturePlannerExport(
  controller: PlannerController,
  nativeAssistant?: BrowserAssistantTransport,
): PlannerExportContext {
  if (nativeAssistant?.busy) {
    throw new Error(
      'Wait for the assistant to finish, or stop it, then try again.',
    );
  }
  const result = controller.run({ name: 'export_cookbook', input: {} });
  if (!result.ok) throw new Error(result.error.message);
  return structuredClone({
    export: result.data as ExportData,
    revision: result.snapshot.revision,
    conversation: nativeAssistant?.conversation() ?? [],
  });
}
