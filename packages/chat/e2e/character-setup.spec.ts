import { expect, test } from '@playwright/test';

test('character conversation hydrates and exposes listening input', async ({ page }) => {
  await page.goto('/', { waitUntil: 'networkidle' });
  await page.getByRole('tab', { name: 'Character conversation' }).click();
  await expect(page.getByRole('button', { name: 'Listening mode' })).toBeVisible();
  await page.getByRole('button', { name: 'Listening mode' }).click();
  await expect(page.getByLabel('Voice input')).toBeVisible();
  await expect(page.getByLabel('Type your message')).toBeEnabled();
});

test('listening submit remains pointer-reachable with idle controls hidden', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/', { waitUntil: 'networkidle' });
  await page.getByRole('tab', { name: 'Character conversation' }).click();
  await page.getByRole('button', { name: 'Listening mode' }).click();
  await expect(page.getByRole('button', { name: 'Talk to your assistant' })).toHaveCount(0);
  const input = page.getByLabel('Type your message');
  await input.fill('A typed turn');
  const submit = page.getByRole('button', { name: 'Send message' });
  await submit.scrollIntoViewIfNeeded();
  await expect(submit).toBeVisible();
  const hit = await submit.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      const target = document.elementFromPoint(
        rect.left + rect.width / 2,
        rect.top + rect.height / 2,
      );
      return node.contains(target);
    });
  expect(hit).toBe(true);
});

test('listening mode shows completed replies without speech or hidden-history controls', async ({ page }) => {
  let speechRequests = 0;
  page.on('request', request => {
    if (request.url().includes('/api/dev-character-speech')) speechRequests++;
  });
  let turn = 0;
  await page.route('**/api/dev-character-conversation', route => route.fulfill({
    json: { content: ++turn === 1 ? 'Four is the first answer.' : 'Eight is the next answer.' },
  }));
  await page.goto('/', { waitUntil: 'networkidle' });
  await page.getByRole('tab', { name: 'Character conversation' }).click();
  await page.getByRole('button', { name: 'Listening mode', exact: true }).click();
  const input = page.getByLabel('Type your message', { exact: true });
  await expect(input).toBeEnabled();
  await input.fill('What is two plus two?');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByText('Four is the first answer.', { exact: true })).toBeVisible();
  await expect(input).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Talk to your assistant', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Conversations', exact: true })).toHaveCount(0);
  await input.fill('What is four plus four?');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByText('Eight is the next answer.', { exact: true })).toBeVisible();
  await expect(page.getByText('Four is the first answer.', { exact: true })).not.toBeVisible();
  expect(speechRequests).toBe(0);
});

for (const placement of ['bottom-left', 'bottom-right'] as const) {
  test(`listening controls avoid the expanded ${placement} dock on desktop`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    const offering = { id: 'happy', label: 'Happy', styleId: 'happy', source: 'ready-made' };
    await page.route('**/api/dev-helper', route => route.fulfill({ json: {
      selection: 'personal', source: 'personal', hasOverride: true, recovery: null,
      preferences: { version: 1, offeringId: 'happy', name: 'Happy', voiceId: 'marin', placement, heardSubtitles: true, spokenSubtitles: true },
      offering, offerings: [offering], voices: [{ id: 'marin', label: 'Marin' }],
      permissions: { editableFields: [], canReset: false, customStyleIds: [] },
    } }));
    let release: () => void = () => {};
    const pending = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/api/dev-character-conversation', async route => {
      await pending;
      await route.fulfill({ json: { content: 'Done.' } }).catch(() => {});
    });
    try {
      await page.goto('/', { waitUntil: 'networkidle' });
      await page.getByRole('tab', { name: 'Character conversation' }).click();
      await page.getByRole('button', { name: 'Listening mode', exact: true }).click();
      await page.getByLabel('Type your message', { exact: true }).fill('Wait for a reply');
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
      const leave = page.getByRole('button', { name: 'Leave listening mode', exact: true });
      await leave.scrollIntoViewIfNeeded();
      await leave.click({ trial: true });
      const dock = await page.getByRole('region', { name: 'Character assistant', exact: true }).boundingBox();
      const voice = await page.getByLabel('Voice input', { exact: true }).boundingBox();
      expect(dock).not.toBeNull();
      expect(voice).not.toBeNull();
      if (placement === 'bottom-left') expect(voice!.x).toBeGreaterThanOrEqual(dock!.x + dock!.width);
      else expect(voice!.x + voice!.width).toBeLessThanOrEqual(dock!.x);
    } finally { release(); }
  });
}

async function chooseSyntheticPhoto(page: import('@playwright/test').Page) {
  const buffer = Buffer.from(await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 100; canvas.height = 120;
    canvas.getContext('2d')!.fillRect(0, 0, 100, 120);
    return canvas.toDataURL().split(',')[1];
  }), 'base64');
  await page.getByLabel('Choose character photo').setInputFiles({ name: 'local.png', mimeType: 'image/png', buffer });
  return buffer;
}

test('local model load failure is retryable and never uploads the photo', async ({ page }) => {
  await page.goto('/', { waitUntil: 'networkidle' });
  await chooseSyntheticPhoto(page);
  let calls = 0, uploads = 0;
  page.on('request', request => { if (request.url().includes('/api/dev-character-setup')) uploads++; });
  await page.route('**/api/dev-image-segmentation/*.tflite', async route => {
    calls++; await route.fulfill({ status: 503, body: 'Model unavailable' });
  });
  await page.getByRole('button', { name: 'Isolate head', exact: true }).click();
  await expect(page.getByText('Head isolation failed.', { exact: false })).toBeVisible();
  await expect(page.getByAltText('Selected character source')).toBeVisible();
  await expect(page.getByAltText('Isolated head on transparent background')).toHaveCount(0);
  await page.getByRole('button', { name: 'Retry head isolation' }).click();
  await expect.poll(() => calls).toBe(2);
  await expect(page.locator('section.setup')).toHaveAttribute('aria-busy', 'false');
  expect(uploads).toBe(0);
});

test('cancelled model load cannot replace a newly selected photo', async ({ page }) => {
  await page.goto('/', { waitUntil: 'networkidle' });
  const buffer = await chooseSyntheticPhoto(page);
  let entered = false;
  let release: () => void = () => {};
  const wait = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/dev-image-segmentation/*.tflite', async route => {
    entered = true; await wait; await route.fulfill({ status: 503, body: 'Delayed model' }).catch(() => {});
  });
  await page.getByRole('button', { name: 'Isolate head', exact: true }).click();
  await expect.poll(() => entered).toBe(true);
  await expect(page.getByLabel('Isolating head', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByLabel('Choose character photo').setInputFiles({ name: 'replacement.png', mimeType: 'image/png', buffer });
  release();
  await expect(page.getByAltText('Selected character source')).toBeVisible();
  await expect(page.getByAltText('Isolated head on transparent background')).toHaveCount(0);
  await expect(page.locator('section.setup')).toHaveAttribute('aria-busy', 'false');
  await expect(page.getByText('Photo is local.', { exact: false })).toBeVisible();
});

test('real local head isolation preserves original photographic pixels', async ({ page }) => {
  test.skip(!process.env.SMRT_HEAD_TEST_PHOTO, 'Set SMRT_HEAD_TEST_PHOTO to a local consented portrait; never commit the photo.');
  await page.goto('/', { waitUntil: 'networkidle' });
  let uploads = 0;
  page.on('request', request => { if (request.url().includes('/api/dev-character-setup')) uploads++; });
  await page.getByLabel('Choose character photo').setInputFiles(process.env.SMRT_HEAD_TEST_PHOTO!);
  await page.getByRole('button', { name: 'Isolate head', exact: true }).click();
  const head = page.getByAltText('Isolated head on transparent background');
  await expect(head).toBeVisible({ timeout: 45_000 });
  const pixels = await head.evaluate(async node => {
    const image = node as HTMLImageElement; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0);
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let clear = 0, opaque = 0;
    for (let i = 3; i < data.length; i += 4) { if (!data[i]) clear++; if (data[i] === 255) opaque++; }
    const file = (document.querySelector('input[type="file"]') as HTMLInputElement).files![0];
    const original = new Image(); const url = URL.createObjectURL(file); original.src = url; await original.decode();
    const source = document.createElement('canvas'); source.width = original.naturalWidth; source.height = original.naturalHeight;
    const sourceContext = source.getContext('2d')!; sourceContext.drawImage(original, 0, 0); URL.revokeObjectURL(url);
    const rgb = sourceContext.getImageData(0, 0, source.width, source.height).data;
    let anchor = 3; while (data[anchor] !== 255 && anchor < data.length) anchor += 4;
    const ax = ((anchor - 3) / 4) % canvas.width, ay = Math.floor((anchor - 3) / 4 / canvas.width);
    let originalPixels = false;
    for (let i = 0; i < rgb.length && !originalPixels; i += 4) {
      if (rgb[i] !== data[anchor - 3] || rgb[i + 1] !== data[anchor - 2] || rgb[i + 2] !== data[anchor - 1]) continue;
      const left = (i / 4) % source.width - ax, top = Math.floor(i / 4 / source.width) - ay;
      if (left < 0 || top < 0 || left + canvas.width > source.width || top + canvas.height > source.height) continue;
      originalPixels = true;
      for (let pixel = 0; pixel < data.length && originalPixels; pixel += 4) {
        if (data[pixel + 3] !== 255) continue;
        const from = ((top + Math.floor(pixel / 4 / canvas.width)) * source.width + left + (pixel / 4) % canvas.width) * 4;
        for (let channel = 0; channel < 3; channel++) if (data[pixel + channel] !== rgb[from + channel]) originalPixels = false;
      }
    }
    return { width: canvas.width, height: canvas.height, clear, opaque, originalPixels };
  });
  expect(pixels.width).toBeGreaterThan(16); expect(pixels.height).toBeGreaterThan(16);
  expect(pixels.clear).toBeGreaterThan(0); expect(pixels.opaque).toBeGreaterThan(pixels.width * pixels.height / 2);
  expect(uploads).toBe(0);
  expect(pixels.originalPixels).toBe(true);
  await expect(page.getByRole('button', { name: 'Continue: segment mouth' })).toBeVisible();
});

test('opened photographic mouth reveals the host background and closes to original pixels', async ({ page }) => {
  test.skip(!process.env.SMRT_HEAD_TEST_PHOTO, 'Set SMRT_HEAD_TEST_PHOTO to a local consented portrait; never commit the photo.');
  await page.goto('/', { waitUntil: 'networkidle' });
  await page.getByLabel('Choose character photo').setInputFiles(process.env.SMRT_HEAD_TEST_PHOTO!);
  await page.getByRole('button', { name: 'Isolate head', exact: true }).click();
  await expect(page.getByAltText('Isolated head on transparent background')).toBeVisible({ timeout: 45_000 });
  await page.route('**/api/dev-character-setup', async route => {
    const body = route.request().postDataJSON();
    expect(body.stage).toBe('mouth-landmarks');
    await route.fulfill({ json: { landmarks: {
      mouthLeft: { x: 350, y: 790 }, mouthRight: { x: 650, y: 790 }, chin: { x: 500, y: 970 },
    } } });
  });
  await page.getByRole('button', { name: 'Continue: segment mouth' }).click();
  const svg = page.locator('[data-hv-photo-cutout="portrait"]');
  await expect(svg.locator('image').first()).toHaveAttribute('href', /^blob:/);
  const preview = page.getByLabel('Animated character preview', { exact: true });
  await preview.evaluate(node => {
    const element = node as HTMLElement;
    element.style.backgroundImage = 'none'; element.style.backgroundColor = 'rgb(38, 162, 112)';
  });

  // Render the real mounted SVG, inlining its loaded original-photo assets so
  // a canvas can inspect actual composited pixels rather than DOM attributes.
  async function inspect() {
    return svg.evaluate(async node => {
      const live = node as SVGSVGElement, copy = live.cloneNode(true) as SVGSVGElement;
      const width = live.viewBox.baseVal.width, height = live.viewBox.baseVal.height;
      copy.setAttribute('width', String(width)); copy.setAttribute('height', String(height));
      for (const asset of copy.querySelectorAll('image')) {
        const blob = await fetch(asset.getAttribute('href')!).then(response => response.blob());
        const dataUrl = await new Promise<string>(resolve => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.readAsDataURL(blob); });
        asset.setAttribute('href', dataUrl);
      }
      const picture = new Image(); picture.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(copy))}`; await picture.decode();
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
      const context = canvas.getContext('2d')!; context.drawImage(picture, 0, 0);
      const rendered = context.getImageData(0, 0, width, height).data;
      const original = document.querySelector('img[alt="Isolated head on transparent background"]') as HTMLImageElement;
      await original.decode();
      const source = document.createElement('canvas'); source.width = original.naturalWidth; source.height = original.naturalHeight;
      const sourceContext = source.getContext('2d')!; sourceContext.drawImage(original, 0, 0);
      const pixels = sourceContext.getImageData(0, 0, source.width, source.height).data;
      const gap = Math.max(2, Math.round(source.height * (970 - 790) / 1000 * .18));
      const x = Math.floor(width / 2), y = Math.floor(source.height * .79 + gap / 2), offset = (y * width + x) * 4;
      const alpha = rendered[offset + 3];
      context.globalCompositeOperation = 'destination-over'; context.fillStyle = 'rgb(38, 162, 112)'; context.fillRect(0, 0, width, height);
      const composite = [...context.getImageData(x, y, 1, 1).data];
      let compared = 0, mismatches = 0;
      for (let row = 1; row < source.height - 1; row++) for (let col = 1; col < source.width - 1; col++) {
        const index = (row * source.width + col) * 4;
        // Exclude the anti-aliased outer edge, but inspect every fully opaque
        // interior source pixel, including the lips and chin.
        if ([index, index - 4, index + 4, index - source.width * 4, index + source.width * 4].some(at => pixels[at + 3] !== 255)) continue;
        compared++;
        for (let channel = 0; channel < 4; channel++) if (rendered[index + channel] !== pixels[index + channel]) { mismatches++; break; }
      }
      return { alpha, composite, compared, mismatches };
    });
  }

  const initiallyClosed = await inspect();
  expect(initiallyClosed.compared).toBeGreaterThan(1000);
  expect(initiallyClosed.mismatches).toBe(0);
  await page.getByRole('button', { name: 'Open mouth', exact: true }).click();
  const opened = await inspect();
  expect(opened.alpha).toBe(0);
  expect(opened.composite).toEqual([38, 162, 112, 255]);
  await preview.screenshot({ path: '/tmp/hv-transparent-mouth-gap.png' });
  await page.getByRole('button', { name: 'Close mouth', exact: true }).click();
  const closedAgain = await inspect();
  expect(closedAgain.mismatches).toBe(0);
  expect(closedAgain).toEqual(initiallyClosed);
  await preview.screenshot({ path: '/tmp/hv-transparent-mouth-closed.png' });
});
