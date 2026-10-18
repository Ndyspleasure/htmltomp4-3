import { expect, test } from '@playwright/test';
import { htmlFile, projectZip, zipBuffer } from './fixtures';
import { loadFixture, waitForStatus } from './helpers';

const previewFrame = (page: import('@playwright/test').Page) => page.frameLocator('[data-el="preview-host"] iframe');

test.describe('import & sandboxed preview', () => {
  test('renders a single HTML file in an isolated sandbox', async ({ page }) => {
    await loadFixture(page, htmlFile());
    await waitForStatus(page, ['ready-to-record']);
    const iframe = page.locator('[data-el="preview-host"] iframe');
    await expect(iframe).toHaveAttribute('sandbox', 'allow-scripts');
    const frame = previewFrame(page);
    await expect(frame.locator('#title')).toHaveText('Script OK');
    const body = frame.locator('body');
    await expect(body).toHaveAttribute('data-parent', 'blocked');
    await expect(body).toHaveAttribute('data-storage', 'blocked');
    await expect(body).toHaveAttribute('data-cookie', 'blocked');
    // The sandbox may not navigate the converter page (no allow-top-navigation).
    await page.waitForTimeout(500);
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator('[data-el="file-name"]')).toHaveText('animation.html');
  });

  test('loads a ZIP project with CSS, @import, module imports, fetch() and dynamic images', async ({ page }) => {
    await loadFixture(page, { name: 'project.zip', mimeType: 'application/zip', buffer: projectZip() });
    await waitForStatus(page, ['ready-to-record']);
    const frame = previewFrame(page);
    await expect(frame.locator('#title')).toHaveText('Module OK');
    await expect(frame.locator('#title')).toHaveCSS('color', 'rgb(255, 0, 0)');
    await expect(frame.locator('#data')).toHaveText('Fetch OK');
    await expect(frame.locator('#dynimg')).toHaveText('loaded 1');
    await expect.poll(() => frame.locator('#img').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1);
    await expect
      .poll(() => frame.locator('#bg').evaluate((el) => getComputedStyle(el).backgroundImage))
      .toContain('blob:');
    await expect(page.locator('[data-el="file-contents"]')).toContainText('7 file');
    await expect(page.locator('[data-el="import-warnings"]')).toBeHidden();
  });

  test('lets the user choose an entry point when index.html is missing', async ({ page }) => {
    const zip = zipBuffer({ 'a.html': '<h1 id="t">A</h1>', 'b.html': '<h1 id="t">B</h1>' });
    await loadFixture(page, { name: 'multi.zip', mimeType: 'application/zip', buffer: zip });
    await waitForStatus(page, ['ready-to-record']);
    await expect(page.locator('[data-el="import-warnings"]')).toContainText('index.html tidak ditemukan');
    await expect(previewFrame(page).locator('#t')).toHaveText('A');
    await page.selectOption('[data-el="entry-select"]', 'b.html');
    await waitForStatus(page, ['ready-to-record']);
    await expect(previewFrame(page).locator('#t')).toHaveText('B');
  });

  test('warns about assets missing from the upload', async ({ page }) => {
    const zip = zipBuffer({ 'index.html': '<img src="missing.png"><p>x</p>' });
    await loadFixture(page, { name: 'm.zip', mimeType: 'application/zip', buffer: zip });
    await waitForStatus(page, ['ready-to-record']);
    await expect(page.locator('[data-el="import-warnings"]')).toContainText('missing.png');
  });

  test('rejects a ZIP with path traversal', async ({ page }) => {
    const zip = zipBuffer({ '../evil.html': '<p>x</p>', 'index.html': '<p>ok</p>' });
    await loadFixture(page, { name: 'evil.zip', mimeType: 'application/zip', buffer: zip });
    await waitForStatus(page, ['error']);
    await expect(page.locator('[data-el="global-error"]')).toContainText('tidak aman');
    await expect(page.locator('[data-el="preview-host"] iframe')).toHaveCount(0);
  });

  test('rejects a ZIP bomb', async ({ page }) => {
    const zip = zipBuffer({ 'index.html': '<p>x</p>', 'bomb.bin': new Uint8Array(8 * 1024 * 1024) });
    await loadFixture(page, { name: 'bomb.zip', mimeType: 'application/zip', buffer: zip });
    await waitForStatus(page, ['error']);
    await expect(page.locator('[data-el="global-error"]')).toContainText('ZIP bomb');
  });

  test('rejects unsupported file types and fake HTML', async ({ page }) => {
    await loadFixture(page, { name: 'movie.mp4', mimeType: 'video/mp4', buffer: Buffer.from('xx') });
    await waitForStatus(page, ['error']);
    await expect(page.locator('[data-el="global-error"]')).toContainText('tidak didukung');
    await page.setInputFiles('[data-el="file-input"]', {
      name: 'x.html',
      mimeType: 'text/html',
      buffer: Buffer.from([0, 1, 2, 3]),
    });
    await waitForStatus(page, ['error']);
    await expect(page.locator('[data-el="global-error"]')).toContainText('biner');
  });

  test('reset clears the preview and file info', async ({ page }) => {
    await loadFixture(page, htmlFile());
    await waitForStatus(page, ['ready-to-record']);
    await page.click('[data-el="reset"]');
    await waitForStatus(page, ['idle']);
    await expect(page.locator('[data-el="preview-host"] iframe')).toHaveCount(0);
    await expect(page.locator('[data-el="file-info"]')).toBeHidden();
  });

  test('opens a separate preview window that renders the same content', async ({ page, context }) => {
    await loadFixture(page, htmlFile());
    await waitForStatus(page, ['ready-to-record']);
    await page.check('input[name="method"][value="capture"]');
    await page.check('input[name="captureMode"][value="preview-window"]');
    await expect(page.locator('[data-el="record"]')).toBeDisabled();
    const [popup] = await Promise.all([context.waitForEvent('page'), page.click('[data-el="open-window"]')]);
    await expect(popup).toHaveTitle(/Preview Rekaman/);
    await expect(popup.frameLocator('iframe').locator('#title')).toHaveText('Script OK');
    await expect(page.locator('[data-el="record"]')).toBeEnabled();
    await popup.close();
    await expect(page.locator('[data-el="record"]')).toBeDisabled();
  });
});
