import { get, type IncomingMessage } from 'node:http';
import { INFERENCE_PRESETS } from './inference-presets.js';

export {
  type InferencePresetId,
  isInferencePresetId,
  resolveInferencePreset,
} from './inference-presets.js';

const LOCAL_SERVICES = [
  {
    service: 'ollama',
    baseUrl: 'http://127.0.0.1:11434',
    modelPath: '/api/tags',
    listField: 'models',
    idField: 'name',
  },
  {
    service: 'lemonade',
    baseUrl: INFERENCE_PRESETS.lemonade.baseUrl,
    modelPath: '/models',
    listField: 'data',
    idField: 'id',
  },
] as const;

type LocalService = (typeof LOCAL_SERVICES)[number];

export type LocalInferenceDiscovery = {
  service: LocalService['service'];
  baseUrl: string;
} & ({ available: true; models: string[] } | { available: false });

const PROBE_TIMEOUT_MS = 1_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;

function readField(value: unknown, field: string): unknown {
  if (
    value !== null &&
    typeof value === 'object' &&
    Object.hasOwn(value, field)
  ) {
    return (value as Record<string, unknown>)[field];
  }
}

async function readModels(
  response: IncomingMessage,
  service: LocalService,
): Promise<string[] | null> {
  if (response.statusCode !== 200) {
    response.destroy();
    return null;
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_RESPONSE_BYTES) return null;
    chunks.push(chunk);
  }

  const payload: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const entries = readField(payload, service.listField);
  if (!Array.isArray(entries)) return null;

  const models = new Set<string>();
  for (const entry of entries) {
    const id = readField(entry, service.idField);
    if (typeof id !== 'string' || !id.trim()) continue;
    // Ollama's local inventory can include aliases for upstream models.
    if (
      service.service === 'ollama' &&
      (readField(entry, 'remote_model') || readField(entry, 'remote_host'))
    ) {
      continue;
    }
    // Lemonade can also list hosted models and older versions can list models
    // that still need a download. Keep only local models from those responses.
    if (
      service.service === 'lemonade' &&
      (readField(entry, 'recipe') === 'cloud' ||
        readField(entry, 'downloaded') === false)
    ) {
      continue;
    }
    models.add(id);
  }
  return [...models];
}

async function probe(service: LocalService): Promise<LocalInferenceDiscovery> {
  const identity = { service: service.service, baseUrl: service.baseUrl };
  try {
    const models = await new Promise<string[] | null>((resolve, reject) => {
      // A one-use agent bypasses any global HTTP proxy. Node HTTP also does
      // not follow redirects. The signal bounds the full request and body read.
      const request = get(
        service.baseUrl + service.modelPath,
        { agent: false, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) },
        (response) => {
          readModels(response, service).then(resolve, reject);
        },
      );
      request.once('error', reject);
    });
    if (models) return { ...identity, available: true, models };
  } catch {
    // Errors and response bodies may include sensitive local metadata.
  }
  return { ...identity, available: false };
}

/** Probe the default loopback Ollama and Lemonade servers without credentials. */
export function discoverLocalInferenceModels(): Promise<
  LocalInferenceDiscovery[]
> {
  return Promise.all(LOCAL_SERVICES.map(probe));
}
