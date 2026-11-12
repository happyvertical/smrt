import { fetchDocument } from '@happyvertical/documents';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { snapshotObjectRegistryState } from '../../../core/src/test-utils.js';
import { Content } from '../content.js';
import { Contents } from '../contents.js';

vi.mock('@happyvertical/documents', () => ({ fetchDocument: vi.fn() }));

for (const replaced of [false, true]) {
  describe(`mirror, app replacement=${replaced}`, () => {
    let restore: () => void;
    let expected: typeof Content;
    beforeAll(async () => {
      restore = snapshotObjectRegistryState();
      expected = replaced
        ? (await import('./issue-4931-app.fixture.js')).Content
        : Content;
    });
    afterAll(() => restore());
    afterEach(() => vi.restoreAllMocks());

    it('creates the effective class and keeps initialize/slug/save ordering', async () => {
      const lifecycle: string[] = [];
      vi.spyOn(Content.prototype, 'initialize').mockImplementation(
        async function () {
          lifecycle.push('initialize');
          return this;
        },
      );
      vi.spyOn(Content.prototype, 'getSlug').mockImplementation(async () => {
        lifecycle.push('slug');
        return 'bridge-update';
      });
      vi.spyOn(Content.prototype, 'save').mockImplementation(async function () {
        lifecycle.push('save');
        return this;
      });
      vi.mocked(fetchDocument).mockResolvedValue({
        parts: [{ content: 'one' }, { content: 'two' }],
      } as Awaited<ReturnType<typeof fetchDocument>>);
      const contents = new Contents({});
      vi.spyOn(contents, 'get').mockResolvedValue(null);
      const mirrored = await contents.mirror({
        url: 'https://example.com/bridge-update.html',
        context: 'news',
        resolveHostname: async () => [{ address: '93.184.216.34', family: 4 }],
        fetchImpl: async () => new Response(null, { status: 200 }),
      });
      expect(mirrored?.constructor).toBe(expected);
      expect(mirrored).toMatchObject({
        title: 'bridge update',
        type: 'mirror',
        context: 'news',
        body: 'one\n\ntwo',
      });
      expect(lifecycle).toEqual(['initialize', 'slug', 'save']);
    });
  });
}
