/** A WebLLM prebuilt model the assistant offers. */
export interface AssistantModel {
  /** A model id in WebLLM's prebuilt list. */
  id: string;
  label: string;
  /** Approximate one-time download, in megabytes (cached afterwards). */
  downloadMB: number;
  /** GPU memory the model needs while running, in megabytes. */
  vramMB: number;
}

export const DEFAULT_MODEL_ID = 'Qwen3-1.7B-q4f16_1-MLC';

/** Small instruction-tuned models; the first is the default. */
export const ASSISTANT_MODELS: readonly AssistantModel[] = [
  {
    id: DEFAULT_MODEL_ID,
    label: 'Qwen3 1.7B (recommended)',
    downloadMB: 1100,
    vramMB: 2037,
  },
  {
    id: 'Llama-3.2-1B-Instruct-q4f16_1-MLC',
    label: 'Llama 3.2 1B (smallest)',
    downloadMB: 700,
    vramMB: 879,
  },
  {
    id: 'Qwen3-4B-q4f16_1-MLC',
    label: 'Qwen3 4B (smarter, larger)',
    downloadMB: 2300,
    vramMB: 3432,
  },
];

export function getModel(id: string): AssistantModel | undefined {
  return ASSISTANT_MODELS.find((model) => model.id === id);
}

/** "about 1.1 GB" / "about 700 MB". */
export function formatSize(megabytes: number): string {
  return megabytes >= 1000
    ? `about ${(megabytes / 1000).toFixed(1)} GB`
    : `about ${megabytes} MB`;
}

/** The label without its advice: "Qwen3 1.7B (recommended)" -> "Qwen3 1.7B". */
export function shortLabel(model: AssistantModel): string {
  return model.label.replace(/\s*\(.*\)\s*$/, '');
}

/** The model to suggest when the graphics card has room for it. */
export const ROOMY_MODEL_ID = 'Qwen3-4B-q4f16_1-MLC';

/**
 * Whether a graphics card whose largest single buffer is `maxBufferBytes` has
 * room for the model (with some headroom). The default stays the default for
 * small cards.
 */
export function hasRoomFor(
  model: AssistantModel,
  maxBufferBytes: number,
): boolean {
  return maxBufferBytes >= model.vramMB * 1_000_000 * 1.2;
}

interface GpuNavigator {
  gpu?: {
    requestAdapter(): Promise<{ limits?: { maxBufferSize?: number } } | null>;
  };
}

/** The largest buffer the graphics card allows, or 0 when unknown. */
export async function graphicsBufferLimit(
  nav: GpuNavigator | undefined = typeof navigator === 'undefined'
    ? undefined
    : (navigator as unknown as GpuNavigator),
): Promise<number> {
  try {
    const adapter = await nav?.gpu?.requestAdapter();
    return adapter?.limits?.maxBufferSize ?? 0;
  } catch {
    return 0;
  }
}
