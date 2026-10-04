import { expect, type Page, test } from '@playwright/test';

/**
 * FileUpload native form posting (#3260), in a real browser: the accepted
 * list is mirrored onto the named input with `DataTransfer`, so
 * `new FormData(form)` carries exactly the listed files.
 */

const file = (name: string, size = 4, mimeType = 'text/plain') => ({
  name,
  mimeType,
  buffer: Buffer.alloc(size, 'a'),
});

/** Names of the non-empty file entries a native submit of `form` would post. */
function posted(page: Page, form: string, field: string) {
  return page.evaluate(
    ([formId, name]) => {
      const el = document.getElementById(formId) as HTMLFormElement;
      return new FormData(el)
        .getAll(name)
        .filter((v): v is File => v instanceof File && v.name !== '')
        .map((f) => f.name);
    },
    [form, field] as const,
  );
}

function drop(page: Page, form: string, names: string[]) {
  return page.evaluate(
    ([formId, fileNames]) => {
      const transfer = new DataTransfer();
      for (const n of fileNames) {
        transfer.items.add(new File(['abcd'], n, { type: 'text/plain' }));
      }
      const zone = document.querySelector(`#${formId} .drop-zone`);
      if (!zone) throw new Error(`drop zone not found in #${formId}`);
      zone.dispatchEvent(
        new DragEvent('drop', {
          dataTransfer: transfer,
          bubbles: true,
          cancelable: true,
        }),
      );
    },
    [form, names] as const,
  );
}

test('picked, dropped and removed files post exactly as listed', async ({
  page,
}) => {
  await page.goto('/file-upload.html');
  const input = page.locator('#multi input[type="file"]');

  await input.setInputFiles(file('a.txt'));
  await expect.poll(() => posted(page, 'multi', 'docs')).toEqual(['a.txt']);

  // A second pick accumulates instead of replacing what will post.
  await input.setInputFiles(file('b.txt'));
  await expect
    .poll(() => posted(page, 'multi', 'docs'))
    .toEqual(['a.txt', 'b.txt']);

  // Drag-and-drop files post too.
  await drop(page, 'multi', ['c.txt']);
  await expect
    .poll(() => posted(page, 'multi', 'docs'))
    .toEqual(['a.txt', 'b.txt', 'c.txt']);

  // Removing a file removes it from what posts.
  await page.getByRole('button', { name: 'Remove b.txt' }).click();
  await expect
    .poll(() => posted(page, 'multi', 'docs'))
    .toEqual(['a.txt', 'c.txt']);

  // A rejected (oversized) pick never posts.
  await input.setInputFiles(file('huge.txt', 5000));
  await expect(page.locator('#multi [role="alert"]')).toContainText(
    'maximum size',
  );
  await expect
    .poll(() => posted(page, 'multi', 'docs'))
    .toEqual(['a.txt', 'c.txt']);

  // Resetting the bound `files` clears what posts.
  await page.locator('#reset').click();
  await expect.poll(() => posted(page, 'multi', 'docs')).toEqual([]);
});

test('a native form reset empties the list and what posts', async ({
  page,
}) => {
  await page.goto('/file-upload.html');
  const input = page.locator('#multi input[type="file"]');

  await input.setInputFiles(file('a.txt'));
  await expect.poll(() => posted(page, 'multi', 'docs')).toEqual(['a.txt']);

  // `form.reset()` (a reset button, or SvelteKit enhance's `update()` after a
  // success) empties the native input; the list must empty with it.
  await page.locator('#native-reset').click();
  await expect.poll(() => posted(page, 'multi', 'docs')).toEqual([]);
  await expect(page.locator('#multi .file-list')).toHaveCount(0);

  // The next pick posts alone: the old list is never mirrored back.
  await input.setInputFiles(file('b.txt'));
  await expect.poll(() => posted(page, 'multi', 'docs')).toEqual(['b.txt']);
});

test('required blocks a native submit until a file is listed', async ({
  page,
}) => {
  await page.goto('/file-upload.html');
  const input = page.locator('#multi input[type="file"]');
  await expect(input).toHaveAttribute('required', '');

  const submit = () =>
    page.evaluate(() =>
      (document.getElementById('multi') as HTMLFormElement).requestSubmit(),
    );

  // Empty: the submit is blocked, and because the input is visually hidden
  // (not `hidden`) the browser can focus it to show its validation bubble.
  await submit();
  await expect(page.locator('#submits')).toHaveText('0');
  expect(
    await input.evaluate((el: HTMLInputElement) => el.validity.valueMissing),
  ).toBe(true);
  await expect(input).toBeFocused();
  await expect(page.locator('#multi [role="alert"]')).not.toBeEmpty();

  await input.setInputFiles(file('cert.txt'));
  await submit();
  await expect(page.locator('#submits')).toHaveText('1');

  // Removing the only file makes the field invalid again.
  await page.getByRole('button', { name: 'Remove cert.txt' }).click();
  await submit();
  await expect(page.locator('#submits')).toHaveText('1');
  expect(
    await input.evaluate((el: HTMLInputElement) => el.validity.valueMissing),
  ).toBe(true);
});

test('single mode replaces the posted file and forwards capture', async ({
  page,
}) => {
  await page.goto('/file-upload.html');
  const input = page.locator('#single input[type="file"]');
  await expect(input).toHaveAttribute('capture', 'environment');
  await expect(input).toHaveAttribute('accept', 'image/*');

  await input.setInputFiles(file('first.png', 4, 'image/png'));
  await expect
    .poll(() => posted(page, 'single', 'photo'))
    .toEqual(['first.png']);
  await input.setInputFiles(file('second.png', 4, 'image/png'));
  await expect
    .poll(() => posted(page, 'single', 'photo'))
    .toEqual(['second.png']);
});
