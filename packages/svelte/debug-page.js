import { chromium } from '@playwright/test';

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  // Capture console messages
  page.on('console', msg => {
    console.log(`[BROWSER CONSOLE ${msg.type()}]:`, msg.text());
  });

  // Capture page errors
  page.on('pageerror', err => {
    console.error('[BROWSER ERROR]:', err.message);
  });

  await page.goto('http://localhost:5177/');

  // Wait a bit for page to load
  await page.waitForTimeout(2000);

  // Take screenshot
  await page.screenshot({ path: '/tmp/test-app-screenshot.png', fullPage: true });
  console.log('Screenshot saved to /tmp/test-app-screenshot.png');

  // Get page content
  const content = await page.content();
  console.log('\n[PAGE HTML]:\n', content.substring(0, 500));

  // Check if app element exists
  const appElement = await page.$('#app');
  console.log('\n[APP ELEMENT]:', appElement ? 'Found' : 'Not found');

  if (appElement) {
    const html = await appElement.innerHTML();
    console.log('[APP INNER HTML]:', html.substring(0, 500));
  }

  await browser.close();
})();
