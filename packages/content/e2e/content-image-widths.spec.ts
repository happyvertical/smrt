import { expect, test } from './fixtures.js';

const placements = ['block', 'center', 'left', 'right', 'full'] as const;
const pixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8KsAAAAASUVORK5CYII=';

for (const tag of ['img', 'figure']) {
  test(`legacy and private ${tag} widths render and round-trip identically`, async ({ page }) => {
    const slug = `image-width-${tag}-${Date.now()}`;
    const body = ['legacy', 'private'].flatMap((form) => placements.map((placement) => {
      const property = form === 'legacy' ? 'width' : '--smrt-content-body-image-width';
      const attributes = `data-smrt-inline-image="true" data-smrt-placement="${placement}" style="${property}: 180px; max-width: 100%; height: auto"`;
      const image = `<img src="${pixel}" alt="${form}-${placement}" ${tag === 'img' ? attributes : ''}>`;
      return `${tag === 'figure' ? `<figure ${attributes}>${image}</figure>` : image}<p>After ${form}-${placement}</p>`;
    })).join('');
    const created = await page.request.post('/api/v1/contents', {
      data: { type: 'article', title: slug, slug, status: 'published', bodyFormat: 'html', body },
    });
    expect(created.ok()).toBe(true);
    const createdPayload = await created.json();
    const articleId = (createdPayload.data ?? createdPayload).id;
    expect(articleId).toBeTruthy();

    const checkWidths = async (selector: string, phone: boolean) => {
      const surface = page.locator(selector);
      await expect(surface).toBeVisible();
      for (const form of ['legacy', 'private']) {
        for (const placement of placements) {
          const image = surface.getByAltText(`${form}-${placement}`, { exact: true });
          const dimensions = await image.evaluate((img, tag) => {
            const frame = tag === 'figure' ? img.parentElement! : img;
            return {
              width: frame.getBoundingClientRect().width,
              available: frame.parentElement!.clientWidth - parseFloat(getComputedStyle(frame.parentElement!).paddingLeft) - parseFloat(getComputedStyle(frame.parentElement!).paddingRight),
              inlineWidth: (frame as HTMLElement).style.width,
              chosen: (frame as HTMLElement).style.getPropertyValue('--smrt-content-body-image-width'),
              float: getComputedStyle(frame).float,
            };
          }, tag);
          const full = placement === 'full' || (phone && (placement === 'left' || placement === 'right'));
          expect(dimensions.width).toBeCloseTo(full ? dimensions.available : 180, 0);
          expect(dimensions.inlineWidth).toBe('');
          expect(dimensions.chosen).toBe('180px');
          if (full) expect(dimensions.float).toBe('none');
        }
      }
    };

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`/articles/${slug}`);
    await checkWidths('[data-smrt-component="ContentBodyRenderer"]', false);
    await page.setViewportSize({ width: 390, height: 844 });
    await checkWidths('[data-smrt-component="ContentBodyRenderer"]', true);

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/workspace');
    await page.getByPlaceholder('Search contents...').fill(slug);
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    const selector = '[data-smrt-component="ContentBodyEditor"] [contenteditable="true"]';
    await checkWidths(selector, false);
    await page.setViewportSize({ width: 390, height: 844 });
    await checkWidths(selector, true);
    await page.setViewportSize({ width: 1280, height: 900 });
    // A normal input emits the normalized body through the real editor save path.
    await page.locator(selector).focus();
    await page.locator(selector).evaluate((surface) => {
      const paragraph = document.createElement('p');
      paragraph.textContent = 'Round-trip edit';
      surface.append(paragraph);
      surface.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    });
    await page.locator(selector).blur();
    await page.getByRole('button', { name: 'Update Content', exact: true }).click();
    await expect(page.locator(selector)).toHaveCount(0);
    const savedResponse = await page.request.get(`/api/v1/contents/${articleId}`);
    const savedPayload = await savedResponse.json();
    const savedBody = (savedPayload.data ?? savedPayload).body;
    expect(savedBody).toContain('Round-trip edit');
    expect(savedBody).toContain('--smrt-content-body-image-width: 180px');
    expect(savedBody).not.toMatch(/(?:style="|; )width:/);
    await page.goto(`/articles/${slug}`);
    await checkWidths('[data-smrt-component="ContentBodyRenderer"]', false);
    await page.setViewportSize({ width: 390, height: 844 });
    await checkWidths('[data-smrt-component="ContentBodyRenderer"]', true);
  });
}
