/**
 * CORS on a shared-cacheable REST read (#5195): with an origin-dependent policy
 * configured, every variant of the response (no Origin, disallowed, allowed;
 * 200, 304, error) carries `Vary: Origin`, so a shared cache keyed on the URL
 * cannot serve one origin's answer to another. Only the allowed origin gets
 * Access-Control-Allow-Origin and credentials.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerChangeFeedWriter } from '../change-feed';
import { SmrtCollection } from '../collection';
import { field } from '../decorators';
import { SmrtObject } from '../object';
import { ObjectRegistry, smrt } from '../registry';
import { getTestDatabase } from '../testing/database';
import { APIGenerator } from './rest';

@smrt({ api: { public: true, cache: { sMaxage: 300 } } })
class CorsCachedWidget extends SmrtObject {
  @field({ type: 'text' })
  name: string = '';

  constructor(options: any = {}) {
    super(options);
    if (options.name !== undefined) this.name = options.name;
  }
}

class CorsCachedWidgetCollection extends SmrtCollection<CorsCachedWidget> {
  static readonly _itemClass = CorsCachedWidget;
}

const APP = 'https://app.example.com';
const EVIL = 'https://evil.example.com';

describe('REST CORS Vary on a shared-cacheable read', () => {
  ObjectRegistry.registerCollection(
    'CorsCachedWidget',
    CorsCachedWidgetCollection,
  );
  let db: any;
  let handler: (req: Request) => Promise<Response>;
  let id: string;

  beforeAll(async () => {
    registerChangeFeedWriter();
    db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: ['CorsCachedWidget'],
    });
    const api = new APIGenerator({
      basePath: '/api/v1',
      enableCors: true,
      allowedOrigins: [APP],
      allowCredentials: true,
      authMiddleware: () => async (req) => req,
    });
    api.registerCollection(
      'corscachedwidgets',
      await CorsCachedWidgetCollection.create({ db }),
    );
    handler = api.generateHandler();
    const created = await handler(
      new Request('http://local/api/v1/corscachedwidgets', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'one' }),
      }),
    );
    id = ((await created.json()) as { id: string }).id;
  });

  afterAll(async () => {
    await db?.close?.();
  });

  const get = (path: string, origin?: string, extra: HeadersInit = {}) =>
    handler(
      new Request(`http://local/api/v1/${path}`, {
        headers: { ...(origin ? { origin } : {}), ...extra },
      }),
    );

  it('carries Vary: Origin with no Origin, a disallowed Origin and an allowed one', async () => {
    for (const origin of [undefined, EVIL, APP]) {
      const res = await get('corscachedwidgets', origin);
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toContain('s-maxage=300');
      expect(res.headers.get('vary')).toBe('Origin');
      const allowed = origin === APP;
      expect(res.headers.get('access-control-allow-origin')).toBe(
        allowed ? APP : null,
      );
      expect(res.headers.get('access-control-allow-credentials')).toBe(
        allowed ? 'true' : null,
      );
    }
  });

  it('carries it on 304 and error responses', async () => {
    const first = await get(`corscachedwidgets/${id}`, EVIL);
    const etag = first.headers.get('etag') as string;
    expect(etag).toBeTruthy();
    for (const origin of [undefined, EVIL, APP]) {
      const notModified = await get(`corscachedwidgets/${id}`, origin, {
        'if-none-match': etag,
      });
      expect(notModified.status).toBe(304);
      expect(notModified.headers.get('vary')).toContain('Origin');
      const missing = await get('corscachedwidgets/does-not-exist', origin);
      expect(missing.status).toBe(404);
      expect(missing.headers.get('vary')).toContain('Origin');
    }
  });
});
