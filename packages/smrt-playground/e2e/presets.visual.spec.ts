import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

const entries = [
  ['base-controls', 'Base Controls'],
  ['feedback-overlays', 'Feedback & Overlays'],
  ['collections', 'Collections & Content Lists'],
  ['data-table', 'Data Table'],
  ['calendar', 'Calendar'],
  ['styleless-mode', 'Styleless Mode'],
] as const;
const presets = [
  'material',
  'glass',
  'studio',
  'smrt',
  'happyvertical',
] as const;
const unstyledCSS = readFileSync(
  new URL('../../smrt-ui/src/styles/unstyled.css', import.meta.url),
  'utf8',
);

for (const preset of presets) {
  for (const scheme of ['light', 'dark'] as const) {
    for (const [entry, title] of entries) {
      test(`${preset}/${scheme}/${entry}`, async ({ page }) => {
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.clock.setFixedTime(new Date('2026-10-13T12:00:00Z'));
        await page.emulateMedia({ colorScheme: scheme });
        await page.addInitScript(
          ({ preset, scheme }) => {
            localStorage.setItem(
              'smrt-theme',
              JSON.stringify({ preset, colorScheme: scheme }),
            );
          },
          { preset, scheme },
        );
        await page.goto(
          `/?entry=${encodeURIComponent(`@happyvertical/smrt-ui:${entry}`)}`,
        );
        await expect(page.locator('[data-hydrated="true"]')).toBeVisible();
        await expect(page.getByTestId('playground-preview-title')).toHaveText(
          title,
        );
        await expect(page.locator('html')).toHaveAttribute(
          'data-theme',
          preset,
        );
        await expect(page.locator('html')).toHaveAttribute(
          'data-color-scheme',
          scheme,
        );
        const stage = page.getByTestId('playground-preview-stage');
        await expect(
          stage.locator('[data-smrt-component]').first(),
        ).toBeVisible();
        await expect(
          stage.getByText('Preview unavailable', { exact: true }),
        ).toHaveCount(0);
        // Unlayered declarations win over component layers, including transitions
        // in styleless mode. Pseudo-elements can animate too.
        await page.addStyleTag({
          content:
            '* , *::before, *::after { animation: none; transition: none; }',
        });
        await page.evaluate(async () => {
          await document.fonts.ready;
          await Promise.all(
            Array.from(document.images).map((image) =>
              image.decode().catch(() => {}),
            ),
          );
        });
        await expect(stage).toHaveScreenshot([
          preset,
          scheme,
          `${entry}-styled.png`,
        ]);
        await page.addStyleTag({ content: unstyledCSS });
        await expect(stage).toHaveScreenshot([
          preset,
          scheme,
          `${entry}-unstyled.png`,
        ]);
        expect(errors).toEqual([]);
      });
    }
  }
}
