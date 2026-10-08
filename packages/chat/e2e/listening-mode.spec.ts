/** One real dock + Dictation, exercised without microphone/provider access. */
import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/previews/listening-mode');
  await expect(page.getByRole('button', { name: 'Start listening', exact: true })).toBeEnabled();
});

test('explicit start, interim/final routing, independent toggles and pending approval', async ({ page }) => {
  const interim = page.getByRole('button', { name: 'Synthetic interim', exact: true });
  const final = page.getByRole('button', { name: 'Synthetic final', exact: true });
  await final.click();
  await expect(page.getByTestId('sent-turns')).toHaveText('0');
  await expect(page.getByLabel('You said', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Start listening', exact: true }).press('Enter');
  await interim.click();
  await expect(page.getByLabel('You said', { exact: true })).toContainText('Mark the project');
  await expect(page.getByTestId('sent-turns')).toHaveText('0');
  await final.click();
  await expect(page.getByTestId('sent-turns')).toHaveText('1');
  await expect(page.getByRole('button', { name: 'Confirm', exact: true })).toBeVisible();
  await expect(page.getByLabel('Project status', { exact: true })).toHaveValue('pending');
  await expect(page.locator('.assistant-dock')).toHaveCount(1);
  await expect(page.locator('.assistant-dock-messages')).toHaveCount(0);
  await expect(page.locator('.assistant-composer')).toHaveCount(0);
  await page.getByRole('button', { name: 'Playback boundary', exact: true }).click();
  await expect(page.getByLabel('Assistant is speaking', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Playback started', exact: true }).click();
  await page.getByRole('button', { name: 'Playback boundary', exact: true }).click();
  await expect(page.getByLabel('Assistant is speaking', { exact: true })).toContainText('I can mark the project ready');
  await page.getByRole('checkbox', { name: 'Show what I said', exact: true }).press('Space');
  await expect(page.getByLabel('You said', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Assistant is speaking', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Stop listening', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('checkbox', { name: 'Show what I said', exact: true }).press('Space');
  await page.getByRole('checkbox', { name: 'Show assistant speech', exact: true }).press('Space');
  await expect(page.getByLabel('You said', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Assistant is speaking', { exact: true })).toHaveCount(0);
  await final.click();
  await expect(page.getByTestId('sent-turns')).toHaveText('1');
  await expect(page.getByLabel('Project status', { exact: true })).toHaveValue('pending');
  await page.getByRole('button', { name: 'Reject', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Confirm', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Project status', { exact: true })).toHaveValue('pending');
  await final.click();
  await expect(page.getByTestId('sent-turns')).toHaveText('2');
  await page.getByRole('button', { name: 'Confirm', exact: true }).press('Enter');
  await expect(page.getByLabel('Project status', { exact: true })).toHaveValue('ready');
  await expect(page.getByTestId('revision')).toHaveText('2');
  await page.getByRole('checkbox', { name: 'Hide conversation history', exact: true }).press('Space');
  await expect(page.locator('.assistant-dock-message-content').filter({ hasText: /^Mark the project ready\.$/ })).toHaveCount(2);
  await expect(page.locator('.assistant-dock')).toHaveCount(1);
  await page.screenshot({ path: test.info().outputPath('confirmed-context.png'), fullPage: true });
});

test('stop ignores late media callbacks and preserves an existing draft', async ({ page }) => {
  await page.getByRole('button', { name: 'Start listening', exact: true }).click();
  await page.getByRole('button', { name: 'Synthetic final', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Reject', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Playback started', exact: true }).click();
  await page.getByRole('button', { name: 'Playback boundary', exact: true }).click();
  await page.getByRole('button', { name: 'Stop playback', exact: true }).click();
  await page.getByRole('button', { name: 'Playback ended', exact: true }).click();
  await expect(page.getByLabel('Assistant is speaking', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Reject', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Hide conversation history', exact: true }).press('Space');
  const draft = page.locator('.assistant-composer textarea');
  await draft.fill('My existing draft');
  await page.getByRole('button', { name: 'Synthetic final', exact: true }).click();
  await expect(draft).toHaveValue('My existing draft');
  await expect(page.getByTestId('sent-turns')).toHaveText('1');
  await page.getByRole('button', { name: 'Synthetic interim', exact: true }).click();
  await expect(page.locator('.heard-captions .interim')).toBeVisible();
  await page.getByRole('button', { name: 'Stop listening', exact: true }).click();
  await expect(page.locator('.heard-captions .interim')).toHaveCount(0);
  await page.getByRole('button', { name: 'Synthetic final', exact: true }).click();
  await expect(page.getByTestId('sent-turns')).toHaveText('1');
});

test('320px and reduced motion retain visible, keyboard reachable approval', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByRole('button', { name: 'Start listening', exact: true }).press('Enter');
  await page.getByRole('button', { name: 'Synthetic final', exact: true }).click();
  const confirm = page.getByRole('button', { name: 'Confirm', exact: true });
  await expect(confirm).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await page.locator('.smrt-dictation-dot').evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
  await page.getByRole('button', { name: 'Playback started', exact: true }).press('Enter');
  await page.getByRole('button', { name: 'Playback boundary', exact: true }).press('Enter');
  await expect(page.locator('.caption-overlay')).toHaveCount(1);
  await expect(page.locator('.caption-overlay-content > section')).toHaveCount(2);
  await confirm.click({ trial: true });
  await confirm.focus();
  await expect(confirm).toBeFocused();
  await page.screenshot({ path: test.info().outputPath('mobile-approval.png'), fullPage: true });
  await confirm.press('Enter');
  await expect(page.getByLabel('Project status', { exact: true })).toHaveValue('ready');
});

test('real-source opt-in loads the public adapters only after a gesture (browser APIs mocked)', async ({ page }) => {
  await page.addInitScript(() => {
    let instances = 0;
    let starts = 0;
    let emit = (_text: string, _final: boolean) => {};
    class Recognition {
      onstart?: () => void;
      onend?: () => void;
      onresult?: (event: unknown) => void;
      constructor() {
        instances++;
        emit = (text, final) => this.onresult?.({ resultIndex: 0, results: [{ 0: { transcript: text, confidence: 1 }, length: 1, isFinal: final }] });
      }
      start() { starts++; this.onstart?.(); }
      stop() { this.onend?.(); }
      abort() { this.onend?.(); }
    }
    Object.defineProperty(window, 'SpeechRecognition', { value: Recognition });
    Object.defineProperty(window, 'SpeechSynthesisUtterance', { value: class { constructor(public text: string) {} } });
    Object.defineProperty(window, 'speechSynthesis', { value: {
      getVoices: () => [{ voiceURI: 'mock', name: 'mock', lang: 'en-US', localService: true, default: true }],
      cancel() {},
      speak(utterance: SpeechSynthesisUtterance) {
        utterance.onstart?.({} as SpeechSynthesisEvent);
        utterance.onboundary?.({ charIndex: 0, charLength: 10 } as SpeechSynthesisEvent);
        utterance.onend?.({} as SpeechSynthesisEvent);
      },
    }});
    Object.defineProperty(window, 'voiceProbe', { value: { counts: () => ({ instances, starts }), emit: (text: string, final: boolean) => emit(text, final) } });
  });
  await page.reload();
  const counts = () => page.evaluate(() => (window as unknown as { voiceProbe: { counts(): { instances: number; starts: number } } }).voiceProbe.counts());
  await expect(page.getByRole('button', { name: 'Start listening', exact: true })).toBeEnabled();
  expect(await counts()).toEqual({ instances: 0, starts: 0 });
  await page.getByRole('checkbox', { name: 'Real microphone and browser speech (opt in)', exact: true }).press('Space');
  expect(await counts()).toEqual({ instances: 0, starts: 0 });
  await page.getByRole('button', { name: 'Start listening', exact: true }).press('Enter');
  await expect(page.getByRole('button', { name: 'Stop listening', exact: true })).toHaveAttribute('data-dictation-state', 'listening');
  expect(await counts()).toEqual({ instances: 1, starts: 1 });
  await page.evaluate(() => (window as unknown as { voiceProbe: { emit(text: string, final: boolean): void } }).voiceProbe.emit('Mark the project ready.', true));
  await expect(page.getByRole('button', { name: 'Confirm', exact: true })).toBeVisible();
  await expect(page.getByLabel('Assistant is speaking', { exact: true })).toContainText('I can mark the project ready');
  await expect(page.getByLabel('Project status', { exact: true })).toHaveValue('pending');
  expect(await counts()).toEqual({ instances: 1, starts: 1 });
});

for (const speaker of ['heard', 'spoken']) {
  for (const placement of ['inline', 'bottom']) {
    test(`standalone ${speaker} ${placement} contains long final and interim text at 320px`, async ({ page }) => {
      await page.setViewportSize({ width: 320, height: 800 });
      await page.goto(`/previews/captions-standalone?speaker=${speaker}&placement=${placement}`);
      const caption = page.locator(`.${speaker}-captions`);
      await expect(caption).toBeVisible();
      await expect(page.locator('.caption-overlay')).toHaveCount(placement === 'bottom' ? 1 : 0);
      const bounds = await caption.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320);
      expect(await caption.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      for (const text of await caption.locator('.caption-lines p, .interim').all()) {
        const textBounds = await text.evaluate((el) => {
          const range = document.createRange();
          range.selectNodeContents(el);
          return [...range.getClientRects()].map((rect) => ({ left: rect.left, right: rect.right }));
        });
        expect(textBounds.length).toBeGreaterThan(1);
        for (const rect of textBounds) {
          expect(rect.left).toBeGreaterThanOrEqual(bounds!.x);
          expect(rect.right).toBeLessThanOrEqual(bounds!.x + bounds!.width);
        }
      }
      await page.screenshot({ path: test.info().outputPath(`${speaker}-${placement}.png`), fullPage: true });
    });
  }
}

test('one overlay stacks bottom captions through growth, toggles and remounts at 320px', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => {
    const NativeResizeObserver = window.ResizeObserver;
    const owned = new Set<ResizeObserver>();
    window.ResizeObserver = class extends NativeResizeObserver {
      observe(target: Element, options?: ResizeObserverOptions) {
        if (target.classList.contains('caption-overlay')) owned.add(this);
        super.observe(target, options);
      }
      disconnect() { owned.delete(this); super.disconnect(); }
    };
    Object.defineProperty(window, 'captionObservers', { value: () => owned.size });
  });
  await page.goto('/previews/caption-overlay');
  const observers = () => page.evaluate(() => (window as unknown as { captionObservers(): number }).captionObservers());
  await expect.poll(observers).toBe(1);
  const group = page.getByRole('region', { name: 'Captions', exact: true });
  const heard = page.getByRole('region', { name: 'You said', exact: true });
  const spoken = page.getByRole('region', { name: 'Assistant is speaking', exact: true });
  const checkLayout = async (count: number) => {
    const surfaces = group.locator('.caption-overlay-content > section');
    await expect(surfaces).toHaveCount(count);
    const boxes = await surfaces.evaluateAll((elements) => elements.map((el) => {
      const b = el.getBoundingClientRect();
      return { top: b.top, bottom: b.bottom, left: b.left, right: b.right };
    }));
    for (let i = 0; i < boxes.length; i++) {
      expect(boxes[i].left).toBeGreaterThanOrEqual(0);
      expect(boxes[i].right).toBeLessThanOrEqual(320);
      if (i) expect(boxes[i - 1].bottom).toBeLessThanOrEqual(boxes[i].top);
    }
    expect(await group.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  };
  await expect(heard).toBeVisible();
  await expect(spoken).toBeVisible();
  await checkLayout(2);
  await expect(group.getByRole('button')).toHaveCount(0);
  const originalHeight = (await heard.boundingBox())!.height;
  await page.getByRole('button', { name: 'Grow captions', exact: true }).click();
  expect((await heard.boundingBox())!.height).toBeGreaterThan(originalHeight);
  await checkLayout(2);
  await page.getByRole('checkbox', { name: 'Heard enabled', exact: true }).press('Space');
  await checkLayout(1);
  await expect(heard).toHaveCount(0);
  await page.getByRole('checkbox', { name: 'Heard enabled', exact: true }).press('Space');
  await page.getByRole('checkbox', { name: 'Third caption', exact: true }).press('Space');
  await checkLayout(3);
  await expect(page.getByRole('region', { name: 'Guest said', exact: true })).toBeVisible();
  await page.getByRole('checkbox', { name: 'Spoken enabled', exact: true }).press('Space');
  await checkLayout(2);
  await page.getByRole('checkbox', { name: 'Overlay mounted', exact: true }).press('Space');
  await expect(group).toHaveCount(0);
  await expect.poll(observers).toBe(0);
  await page.getByRole('checkbox', { name: 'Overlay mounted', exact: true }).press('Space');
  await checkLayout(2);
  await expect.poll(observers).toBe(1);
  await page.getByRole('checkbox', { name: 'Spoken enabled', exact: true }).press('Space');
  await checkLayout(3);
  await page.screenshot({ path: test.info().outputPath('three-bottom-captions.png'), fullPage: true });
  await page.getByRole('checkbox', { name: 'Heard enabled', exact: true }).press('Space');
  await page.getByRole('checkbox', { name: 'Spoken enabled', exact: true }).press('Space');
  await page.getByRole('checkbox', { name: 'Third caption', exact: true }).press('Space');
  await expect(group).toBeHidden();
  await page.getByRole('checkbox', { name: 'Spoken enabled', exact: true }).press('Space');
  await expect(group).toBeVisible();
  await checkLayout(1);
});

test('tall caption group is viewport bounded and keyboard scrollable', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto('/previews/caption-overlay');
  await page.getByRole('button', { name: 'Tall captions', exact: true }).click();
  const group = page.getByRole('region', { name: 'Captions', exact: true });
  const box = (await group.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(568);
  expect(box.height).toBeLessThanOrEqual(284);
  const viewport = group.locator('.caption-overlay-viewport');
  const up = group.getByRole('button', { name: 'Scroll captions up', exact: true });
  const down = group.getByRole('button', { name: 'Scroll captions down', exact: true });
  await expect(up).toBeDisabled();
  await expect(down).toBeEnabled();
  expect(await viewport.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  await down.focus();
  await expect(down).toBeFocused();
  await down.press('Enter');
  await expect.poll(() => viewport.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await expect(up).toBeEnabled();
  await up.press('Enter');
  await expect.poll(() => viewport.evaluate((el) => el.scrollTop)).toBe(0);
  await expect(up).toBeDisabled();
  for (let i = 0; i < 30 && !(await down.isDisabled()); i++) await down.press('Enter');
  await expect(down).toBeDisabled();
  await expect(page.getByRole('region', { name: 'Assistant is speaking', exact: true })).toBeInViewport();
  await page.screenshot({ path: test.info().outputPath('keyboard-scrolled-captions.png'), fullPage: true });
  await page.getByRole('button', { name: 'Short captions', exact: true }).press('Enter');
  await expect(up).toHaveCount(0);
  await expect(down).toHaveCount(0);
});

for (const speaker of ['heard', 'spoken']) {
  test(`standalone ${speaker} bottom bounds tall content and reuses accessible scrolling`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.addInitScript(() => {
      const NativeResizeObserver = window.ResizeObserver;
      const owned = new Set<ResizeObserver>();
      window.ResizeObserver = class extends NativeResizeObserver {
        observe(target: Element, options?: ResizeObserverOptions) {
          if (target.classList.contains('caption-overlay')) owned.add(this);
          super.observe(target, options);
        }
        disconnect() { owned.delete(this); super.disconnect(); }
      };
      Object.defineProperty(window, 'captionObservers', { value: () => owned.size });
    });
    await page.goto(`/previews/captions-standalone?speaker=${speaker}&placement=bottom&tall`);
    const caption = page.locator(`.${speaker}-captions`);
    await expect(caption).toBeVisible();
    expect((await caption.boundingBox())!.y).toBeGreaterThanOrEqual(0);
    const group = page.getByRole('region', { name: 'Captions', exact: true });
    await expect(group).toHaveCount(1);
    const bounds = (await group.boundingBox())!;
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(568);
    expect(bounds.height).toBeLessThanOrEqual(284);
    const viewport = group.locator('.caption-overlay-viewport');
    const up = group.getByRole('button', { name: 'Scroll captions up', exact: true });
    const down = group.getByRole('button', { name: 'Scroll captions down', exact: true });
    await expect(up).toBeDisabled();
    await down.press('Enter');
    await expect.poll(() => viewport.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    await up.press('Enter');
    await expect.poll(() => viewport.evaluate((el) => el.scrollTop)).toBe(0);
    for (let i = 0; i < 150 && !(await down.isDisabled()); i++) await down.press('Enter');
    await expect(down).toBeDisabled();
    const textEnd = await caption.evaluate((el) => {
      const p = el.querySelector('.interim') ?? el.querySelector('.caption-lines p:last-child');
      const range = document.createRange();
      range.selectNodeContents(p!);
      const last = [...range.getClientRects()].at(-1)!;
      return { top: last.top, bottom: last.bottom };
    });
    const viewBounds = (await viewport.boundingBox())!;
    expect(textEnd.top).toBeGreaterThanOrEqual(viewBounds.y);
    expect(textEnd.bottom).toBeLessThanOrEqual(viewBounds.y + viewBounds.height);
    await page.screenshot({ path: test.info().outputPath(`standalone-${speaker}-scrolled.png`), fullPage: true });
    const observers = () => page.evaluate(() => (window as unknown as { captionObservers(): number }).captionObservers());
    await expect.poll(observers).toBe(1);
    await page.getByRole('checkbox', { name: 'Caption mounted', exact: true }).press('Space');
    await expect(group).toHaveCount(0);
    await expect.poll(observers).toBe(0);
    await page.getByRole('checkbox', { name: 'Caption mounted', exact: true }).press('Space');
    await expect(group).toHaveCount(1);
    await expect.poll(observers).toBe(1);
    await page.getByRole('button', { name: 'Short caption', exact: true }).press('Enter');
    await expect(up).toHaveCount(0);
    await expect(down).toHaveCount(0);
    expect((await caption.boundingBox())!.y).toBeGreaterThanOrEqual(0);
  });
}
