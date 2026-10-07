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
  await expect(page.getByLabel('What you said', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Start listening', exact: true }).press('Enter');
  await interim.click();
  await expect(page.getByLabel('What you said', { exact: true })).toContainText('Mark the project');
  await expect(page.getByTestId('sent-turns')).toHaveText('0');
  await final.click();
  await expect(page.getByTestId('sent-turns')).toHaveText('1');
  await expect(page.getByRole('button', { name: 'Confirm', exact: true })).toBeVisible();
  await expect(page.getByLabel('Project status', { exact: true })).toHaveValue('pending');
  await expect(page.locator('.assistant-dock')).toHaveCount(1);
  await expect(page.locator('.assistant-dock-messages')).toHaveCount(0);
  await expect(page.locator('.assistant-composer')).toHaveCount(0);
  await page.getByRole('button', { name: 'Playback boundary', exact: true }).click();
  await expect(page.getByLabel('Assistant speech', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Playback started', exact: true }).click();
  await page.getByRole('button', { name: 'Playback boundary', exact: true }).click();
  await expect(page.getByLabel('Assistant speech', { exact: true })).toContainText('I can mark the project ready');
  await page.getByRole('checkbox', { name: 'Show what I said', exact: true }).press('Space');
  await expect(page.getByLabel('What you said', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Assistant speech', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Stop listening', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('checkbox', { name: 'Show what I said', exact: true }).press('Space');
  await page.getByRole('checkbox', { name: 'Show assistant speech', exact: true }).press('Space');
  await expect(page.getByLabel('What you said', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Assistant speech', { exact: true })).toHaveCount(0);
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
  await expect(page.getByLabel('Assistant speech', { exact: true })).toHaveCount(0);
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
  await expect(page.getByLabel('Assistant speech', { exact: true })).toContainText('I can mark the project ready');
  await expect(page.getByLabel('Project status', { exact: true })).toHaveValue('pending');
  expect(await counts()).toEqual({ instances: 1, starts: 1 });
});
