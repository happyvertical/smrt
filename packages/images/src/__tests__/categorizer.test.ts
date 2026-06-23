/**
 * Tests for `ImageCategorizer` — AI-powered image categorization.
 *
 * The only external boundary is `@happyvertical/ai` (loaded via a dynamic
 * `import('@happyvertical/ai')` inside `categorize()`), so we `vi.mock` it and
 * return a canned `ai.chat()` result. The DB-backed `autoTag()` path uses a
 * real in-memory SQLite database so `image.save()` and
 * `AssetCollection.addTag()` exercise actual persistence.
 */

import { AssetCollection } from '@happyvertical/smrt-assets';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImageCategorizer } from '../categorizer';
import { Image } from '../image';
import { ImageCollection } from '../images';

// The categorizer calls `ai.chat([...])` and reads `response.content`.
// `chatMock` is reassignable per-test so each case controls the AI output.
let chatMock: ReturnType<typeof vi.fn>;

vi.mock('@happyvertical/ai', () => ({
  getAI: vi.fn(async () => ({
    chat: (...args: unknown[]) => chatMock(...args),
  })),
}));

const aiOptions = { ai: { type: 'openai' as const, apiKey: 'test-key' } };

describe('ImageCategorizer', () => {
  beforeEach(() => {
    chatMock = vi.fn();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  function makeImage(opts: ConstructorParameters<typeof Image>[0] = {}) {
    return new Image({
      name: 'beach.jpg',
      description: 'A sunny beach',
      mimeType: 'image/jpeg',
      width: 1920,
      height: 1080,
      ...opts,
    });
  }

  describe('categorize()', () => {
    it('parses a well-formed JSON AI response into a CategoryResult', async () => {
      chatMock.mockResolvedValue({
        content: JSON.stringify({
          tags: ['beach', 'ocean', 'summer'],
          description: 'A sandy beach with blue ocean water',
          confidence: 0.92,
          subjects: ['sand', 'water', 'sky'],
        }),
      });

      const categorizer = new ImageCategorizer(aiOptions);
      const result = await categorizer.categorize(makeImage());

      expect(result.tags).toEqual(['beach', 'ocean', 'summer']);
      expect(result.description).toBe('A sandy beach with blue ocean water');
      expect(result.confidence).toBe(0.92);
      expect(result.subjects).toEqual(['sand', 'water', 'sky']);
    });

    it('extracts the JSON object even when the model wraps it in prose', async () => {
      chatMock.mockResolvedValue({
        content:
          'Sure! Here is the categorization:\n```json\n{"tags":["cat"],"description":"A cat","confidence":0.5,"subjects":["animal"]}\n```\nHope that helps.',
      });

      const categorizer = new ImageCategorizer(aiOptions);
      const result = await categorizer.categorize(makeImage());

      expect(result.tags).toEqual(['cat']);
      expect(result.description).toBe('A cat');
      expect(result.subjects).toEqual(['animal']);
    });

    it('sends image metadata (name, description, mime, dimensions) in the prompt', async () => {
      chatMock.mockResolvedValue({ content: '{}' });

      const categorizer = new ImageCategorizer(aiOptions);
      await categorizer.categorize(
        makeImage({
          name: 'mountain.png',
          description: 'A snowy peak',
          mimeType: 'image/png',
          width: 800,
          height: 600,
        }),
      );

      expect(chatMock).toHaveBeenCalledTimes(1);
      const messages = chatMock.mock.calls[0][0] as Array<{
        role: string;
        content: string;
      }>;
      expect(messages[0].role).toBe('user');
      const prompt = messages[0].content;
      expect(prompt).toContain('mountain.png');
      expect(prompt).toContain('A snowy peak');
      expect(prompt).toContain('image/png');
      expect(prompt).toContain('800x600');
    });

    it('falls back to a default result when the response contains no JSON', async () => {
      chatMock.mockResolvedValue({
        content: 'I cannot analyze this image right now.',
      });

      const categorizer = new ImageCategorizer(aiOptions);
      const result = await categorizer.categorize(
        makeImage({ description: 'A sunny beach' }),
      );

      expect(result.tags).toEqual([]);
      expect(result.subjects).toEqual([]);
      expect(result.confidence).toBe(0);
      // Falls back to the image description.
      expect(result.description).toBe('A sunny beach');
    });

    it('falls back to the image name when description is empty and no JSON returned', async () => {
      chatMock.mockResolvedValue({ content: 'no structured output here' });

      const categorizer = new ImageCategorizer(aiOptions);
      const result = await categorizer.categorize(
        makeImage({ name: 'untitled.jpg', description: '' }),
      );

      expect(result.description).toBe('untitled.jpg');
    });

    it('falls back to a default result when JSON parsing throws on malformed JSON', async () => {
      // Looks like a JSON object (matches the regex) but is not valid JSON,
      // so JSON.parse throws and the catch path is taken.
      chatMock.mockResolvedValue({
        content: '{ tags: [unquoted, broken], ',
      });

      const categorizer = new ImageCategorizer(aiOptions);
      const result = await categorizer.categorize(
        makeImage({ description: 'Fallback desc' }),
      );

      expect(result.tags).toEqual([]);
      expect(result.description).toBe('Fallback desc');
      expect(result.confidence).toBe(0);
    });

    it('passes the buffer argument without throwing (currently unused by impl)', async () => {
      chatMock.mockResolvedValue({
        content: '{"tags":[],"description":"d","confidence":0,"subjects":[]}',
      });

      const categorizer = new ImageCategorizer(aiOptions);
      const result = await categorizer.categorize(
        makeImage(),
        Buffer.from('fake-image-bytes'),
      );

      expect(result.description).toBe('d');
    });

    // ── #1407 remediation: validate the parsed object shape ──────────────────

    it('defaults tags/subjects to [] when a valid JSON response omits them', async () => {
      // Valid JSON, but `tags` and `subjects` are missing entirely. The old
      // code returned this object as-is, so a later `for…of result.tags` threw
      // "tags is not iterable".
      chatMock.mockResolvedValue({
        content: '{"description":"A red car","confidence":0.7}',
      });

      const categorizer = new ImageCategorizer(aiOptions);
      const result = await categorizer.categorize(makeImage());

      expect(result.tags).toEqual([]);
      expect(result.subjects).toEqual([]);
      expect(Array.isArray(result.tags)).toBe(true);
      expect(result.description).toBe('A red car');
      expect(result.confidence).toBe(0.7);
    });

    it('coerces a non-array tags field to [] rather than trusting the model', async () => {
      // The model returned a string where an array was expected.
      chatMock.mockResolvedValue({
        content: '{"tags":"beach, ocean","description":"d","subjects":null}',
      });

      const categorizer = new ImageCategorizer(aiOptions);
      const result = await categorizer.categorize(makeImage());

      expect(result.tags).toEqual([]);
      expect(result.subjects).toEqual([]);
    });

    it('extracts the first balanced JSON object when prose AND a second brace follow', async () => {
      // The greedy /\{[\s\S]*\}/ would span to the LAST brace, producing
      // invalid JSON. Balanced extraction stops at the first object's match.
      chatMock.mockResolvedValue({
        content:
          '{"tags":["cat"],"description":"A cat","confidence":0.5,"subjects":["animal"]} ' +
          'Note: confidence is approximate {not json}.',
      });

      const categorizer = new ImageCategorizer(aiOptions);
      const result = await categorizer.categorize(makeImage());

      expect(result.tags).toEqual(['cat']);
      expect(result.description).toBe('A cat');
      expect(result.subjects).toEqual(['animal']);
    });

    it('does not mistake a brace inside a string value for the object end', async () => {
      chatMock.mockResolvedValue({
        content:
          '{"tags":["a"],"description":"price is {discounted}","confidence":1,"subjects":[]}',
      });

      const categorizer = new ImageCategorizer(aiOptions);
      const result = await categorizer.categorize(makeImage());

      expect(result.description).toBe('price is {discounted}');
      expect(result.tags).toEqual(['a']);
    });
  });

  describe('autoTag()', () => {
    let db: DatabaseInterface;
    let images: ImageCollection;
    let assets: AssetCollection;

    beforeEach(async () => {
      db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
      images = await ImageCollection.create({ db });
      assets = await AssetCollection.create({ db });
      // `asset_tags` is a raw join table (not an SMRT model), so it isn't in
      // the generated schema — create it, mirroring its production DDL.
      await db.query(
        'CREATE TABLE IF NOT EXISTS asset_tags (' +
          'asset_id TEXT NOT NULL, tag_slug TEXT NOT NULL, created_at TEXT, ' +
          'PRIMARY KEY (asset_id, tag_slug))',
      );
    });

    afterEach(async () => {
      if (db && typeof db.close === 'function') {
        await db.close();
      }
    });

    it('applies AI description, alt text, and tags to a persisted image', async () => {
      chatMock.mockResolvedValue({
        content: JSON.stringify({
          tags: ['nature', 'landscape'],
          description: 'A scenic mountain landscape at golden hour',
          confidence: 0.88,
          subjects: ['mountain'],
        }),
      });

      const image = await images.create({
        name: 'scene.jpg',
        mimeType: 'image/jpeg',
        width: 1920,
        height: 1080,
        // No description or alt — autoTag should populate both.
        description: '',
        alt: '',
      });
      await image.save();

      const categorizer = new ImageCategorizer(aiOptions);
      await categorizer.autoTag(image, assets);

      expect(image.description).toBe(
        'A scenic mountain landscape at golden hour',
      );
      // alt is the description truncated to 125 chars.
      expect(image.alt).toBe('A scenic mountain landscape at golden hour');

      // Tags were persisted via addTag (asset_tags join table).
      const rows = (await db.list('asset_tags', {
        asset_id: image.id,
      })) as Array<{ tag_slug: string }>;
      expect(rows.map((r) => r.tag_slug).sort()).toEqual([
        'landscape',
        'nature',
      ]);
    });

    it('does not overwrite an existing description or alt', async () => {
      chatMock.mockResolvedValue({
        content: JSON.stringify({
          tags: [],
          description: 'AI generated description',
          confidence: 0.5,
          subjects: [],
        }),
      });

      const image = await images.create({
        name: 'has-meta.jpg',
        mimeType: 'image/jpeg',
        width: 100,
        height: 100,
        description: 'Existing human description',
        alt: 'Existing alt',
      });
      await image.save();

      const categorizer = new ImageCategorizer(aiOptions);
      await categorizer.autoTag(image, assets);

      expect(image.description).toBe('Existing human description');
      expect(image.alt).toBe('Existing alt');
    });

    it('truncates long AI descriptions to 125 chars for alt text', async () => {
      const longDesc = 'x'.repeat(200);
      chatMock.mockResolvedValue({
        content: JSON.stringify({
          tags: [],
          description: longDesc,
          confidence: 0.5,
          subjects: [],
        }),
      });

      const image = await images.create({
        name: 'long.jpg',
        mimeType: 'image/jpeg',
        width: 100,
        height: 100,
        description: '',
        alt: '',
      });
      await image.save();

      const categorizer = new ImageCategorizer(aiOptions);
      await categorizer.autoTag(image, assets);

      expect(image.alt).toHaveLength(125);
      expect(image.description).toBe(longDesc);
    });

    it('does not throw "tags is not iterable" when the AI omits tags (#1407)', async () => {
      // Valid JSON with description but no `tags` array. Pre-fix, autoTag's
      // `for (const tag of result.tags)` threw because tags was undefined.
      chatMock.mockResolvedValue({
        content: '{"description":"A persisted scene","confidence":0.6}',
      });

      const image = await images.create({
        name: 'no-tags.jpg',
        mimeType: 'image/jpeg',
        width: 640,
        height: 480,
        description: '',
        alt: '',
      });
      await image.save();

      const categorizer = new ImageCategorizer(aiOptions);
      await expect(categorizer.autoTag(image, assets)).resolves.toBeUndefined();

      // Description still applied; no tags persisted (none were returned).
      expect(image.description).toBe('A persisted scene');
      const rows = (await db.list('asset_tags', {
        asset_id: image.id,
      })) as Array<{ tag_slug: string }>;
      expect(rows).toEqual([]);
    });
  });
});
