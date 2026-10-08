import { error, json, type RequestHandler } from '@sveltejs/kit';
import { dev } from '$app/environment';
import {
  openDevHelperService,
  serializeDevHelperWrite,
} from '../../../dev-helper-server.js';
import {
  HelperPreferencesAuthorizationError,
  HelperPreferencesValidationError,
} from '../../../helper-preferences-service.js';
import {
  isLocalDevCharacterRequest,
  resolveDevCharacterPersistenceConfig,
} from '../dev-character-persistence/config.js';

const MAX_REQUEST_BYTES = 2048;

function config(request: Request, getClientAddress: () => string) {
  if (!isLocalDevCharacterRequest({ dev, request, getClientAddress }))
    error(404, 'Not found.');
  const result = resolveDevCharacterPersistenceConfig();
  if (!result) error(404, 'Not found.');
  return result;
}

async function body(request: Request): Promise<unknown> {
  const length = Number(request.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_REQUEST_BYTES)
    error(413, 'Helper preferences request is too large.');
  const reader = request.body?.getReader();
  if (!reader) error(400, 'Helper preferences are required.');
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_REQUEST_BYTES) {
        await reader.cancel();
        error(413, 'Helper preferences request is too large.');
      }
      parts.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    error(400, 'Helper preferences must be valid JSON.');
  }
}

async function serve(
  request: Request,
  getClientAddress: () => string,
  operation: 'load' | 'save' | 'reset',
) {
  const local = config(request, getClientAddress);
  const execute = async () => {
    const host = await openDevHelperService(local);
    try {
      if (operation === 'load')
        return json(await host.service.load(host.context));
      if (operation === 'reset')
        return json(await host.service.reset(host.context));
      return json(await host.service.save(host.context, await body(request)));
    } catch (cause) {
      if (cause instanceof HelperPreferencesAuthorizationError)
        error(403, 'Helper preferences are not authorized.');
      if (cause instanceof HelperPreferencesValidationError)
        error(400, cause.message);
      throw cause;
    } finally {
      await host.close();
    }
  };
  return operation === 'load'
    ? execute()
    : serializeDevHelperWrite(local, execute);
}

export const GET: RequestHandler = ({ request, getClientAddress }) =>
  serve(request, getClientAddress, 'load');
export const POST: RequestHandler = ({ request, getClientAddress }) =>
  serve(request, getClientAddress, 'save');
export const DELETE: RequestHandler = ({ request, getClientAddress }) =>
  serve(request, getClientAddress, 'reset');
