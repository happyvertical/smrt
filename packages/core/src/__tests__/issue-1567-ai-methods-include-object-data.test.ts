/**
 * Test for issue #1567: `is()`, `do()`, and `describe()` must reason over the
 * object's own field data — not just the caller's instruction/criteria string.
 * https://github.com/happyvertical/smrt/issues/1567
 *
 * Before this fix the prompt template referenced "the content body" but only
 * the instruction was interpolated, so `product.is('costs more than $10')` and
 * `product.do('write a marketing description')` were evaluated with no
 * knowledge of the product's actual fields.
 *
 * The object is now injected as the "content body" via `toPublicJSON()`, so:
 * - non-sensitive field values appear in the prompt the model receives;
 * - `@field({ sensitive: true })` values are NEVER sent to the model;
 * - oversized payloads are truncated by a coarse token-budget guard (default
 *   and explicit `maxDataLength`);
 * - callers that already curate their own fields can opt out with
 *   `includeData: false`;
 * - the `maxDataLength` / `includeData` control keys are not forwarded to
 *   `ai.message()`.
 */

import { describe, expect, it, vi } from 'vitest';
import { field } from '../decorators';
import { SmrtObject } from '../object';
import { smrt } from '../registry';

// Unique class name to avoid AST-scanner collisions (issue #543).
@smrt()
class Issue1567Product extends SmrtObject {
  @field({ type: 'text' })
  name: string = '';

  @field({ type: 'decimal' })
  price: number = 0.0;

  @field({ type: 'text', sensitive: true })
  supplierApiKey: string = '';
}

/**
 * Build an explicit mock AI client. The `embed` function + absence of a
 * `provider` key is what marks it as a pre-built client in SmrtClass runtime
 * init, so it is used verbatim instead of constructing a real provider.
 */
function makeAiClient(reply: string) {
  const message = vi.fn(async () => reply);
  return {
    client: { embed: vi.fn(), message } as any,
    message,
  };
}

function makeProduct(reply: string) {
  const { client, message } = makeAiClient(reply);
  const product = new Issue1567Product({ ai: client });
  product.name = 'Acme Widget';
  product.price = 19.99;
  product.supplierApiKey = 'sk-secret-supplier-key';
  return { product, message };
}

describe('Issue #1567: AI methods include the object field data', () => {
  it('do() injects the object public data as the content body', async () => {
    const { product, message } = makeProduct('A short marketing blurb');

    const result = await product.do('write a marketing description');

    expect(result).toBe('A short marketing blurb');
    expect(message).toHaveBeenCalledTimes(1);

    const prompt = message.mock.calls[0]?.[0] as string;
    expect(prompt).toContain('--- Beginning of content ---');
    expect(prompt).toContain('Acme Widget');
    expect(prompt).toContain('19.99');
    expect(prompt).toContain('write a marketing description');
    // The instruction-only prompt is gone; the data is genuinely present.
    expect(prompt).not.toContain('[truncated');
  });

  it('do() never sends @field({ sensitive: true }) values to the model', async () => {
    const { product, message } = makeProduct('ok');

    await product.do('summarize this product');

    const prompt = message.mock.calls[0]?.[0] as string;
    expect(prompt).toContain('Acme Widget');
    expect(prompt).not.toContain('sk-secret-supplier-key');
    expect(prompt).not.toContain('supplierApiKey');
  });

  it('is() injects the object data alongside the criteria and returns a boolean', async () => {
    const { product, message } = makeProduct('{"result": true}');

    const result = await product.is('costs more than ten dollars');

    expect(result).toBe(true);

    const prompt = message.mock.calls[0]?.[0] as string;
    expect(prompt).toContain('--- Beginning of content ---');
    expect(prompt).toContain('Acme Widget');
    expect(prompt).toContain('19.99');
    expect(prompt).toContain('costs more than ten dollars');
    // Still excludes secrets.
    expect(prompt).not.toContain('sk-secret-supplier-key');

    // json_object response format is preserved (it follows the spread).
    const opts = message.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(opts.responseFormat).toEqual({ type: 'json_object' });
  });

  it('describe() injects the object data as the content body', async () => {
    const { product, message } = makeProduct('A premium widget.');

    const result = await product.describe();

    expect(result).toBe('A premium widget.');

    const prompt = message.mock.calls[0]?.[0] as string;
    expect(prompt).toContain('--- Beginning of content ---');
    expect(prompt).toContain('Acme Widget');
    expect(prompt).not.toContain('sk-secret-supplier-key');
  });

  it('truncates oversized object data and does not forward maxDataLength to ai.message()', async () => {
    const { client, message } = makeAiClient('ok');
    const product = new Issue1567Product({ ai: client });
    product.name = 'X'.repeat(2000);

    await product.do('summarize', { maxDataLength: 100, model: 'gpt-4o-mini' });

    const prompt = message.mock.calls[0]?.[0] as string;
    expect(prompt).toContain(
      '[truncated: object data exceeded 100 characters]',
    );
    // The huge value is cut off, not sent whole.
    expect(prompt).not.toContain('X'.repeat(2000));

    // The budget is a hard ceiling: the injected content body (marker included)
    // never exceeds maxDataLength.
    const contentBody = prompt
      .split('--- Beginning of content ---\n')[1]
      ?.split('\n--- End of content ---')[0] as string;
    expect(contentBody.length).toBeLessThanOrEqual(100);

    // The control option is stripped; real AI options still pass through.
    const opts = message.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(opts).not.toHaveProperty('maxDataLength');
    expect(opts.model).toBe('gpt-4o-mini');
  });

  it('truncates at the default budget when no maxDataLength is given', async () => {
    const { client, message } = makeAiClient('ok');
    const product = new Issue1567Product({ ai: client });
    // Comfortably larger than the 100_000-char default guard.
    product.name = 'Y'.repeat(120_000);

    await product.do('summarize');

    const prompt = message.mock.calls[0]?.[0] as string;
    expect(prompt).toContain(
      '[truncated: object data exceeded 100000 characters]',
    );
    expect(prompt).not.toContain('Y'.repeat(120_000));
  });

  it('omits the content body entirely when includeData is false', async () => {
    const { product, message } = makeProduct('ok');

    await product.do('summarize this product', {
      includeData: false,
      model: 'gpt-4o-mini',
    });

    const prompt = message.mock.calls[0]?.[0] as string;
    // No content section, and none of the object's field values are injected.
    expect(prompt).not.toContain('--- Beginning of content ---');
    expect(prompt).not.toContain('Acme Widget');
    expect(prompt).not.toContain('19.99');
    // The caller's own instruction is still present.
    expect(prompt).toContain('summarize this product');

    // The control option is stripped; real AI options still pass through.
    const opts = message.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(opts).not.toHaveProperty('includeData');
    expect(opts.model).toBe('gpt-4o-mini');
  });

  it('honors includeData:false for is() (criteria-only prompt, boolean result)', async () => {
    const { product, message } = makeProduct('{"result": false}');

    const result = await product.is('costs more than ten dollars', {
      includeData: false,
    });

    expect(result).toBe(false);
    const prompt = message.mock.calls[0]?.[0] as string;
    expect(prompt).not.toContain('--- Beginning of content ---');
    expect(prompt).not.toContain('Acme Widget');
    expect(prompt).toContain('costs more than ten dollars');
    // responseFormat is still forced even with the data omitted.
    const opts = message.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(opts.responseFormat).toEqual({ type: 'json_object' });
  });

  it('honors includeData:false for describe()', async () => {
    const { product, message } = makeProduct('A premium widget.');

    await product.describe({ includeData: false });

    const prompt = message.mock.calls[0]?.[0] as string;
    expect(prompt).not.toContain('--- Beginning of content ---');
    expect(prompt).not.toContain('Acme Widget');
    expect(prompt).toContain('Generate a concise, professional description');
  });
});
