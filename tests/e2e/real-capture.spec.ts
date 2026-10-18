import { expect, test } from '@playwright/test';
import { htmlFile } from './fixtures';
import { configure, downloadResult, expectNoError, loadFixture, waitForStatus } from './helpers';

test.describe('real tab capture (Chromium)', () => {
  test('records only the preview area of this tab via Region Capture and exports MP4', async ({ page }, testInfo) => {
    await loadFixture(page, htmlFile());
    await waitForStatus(page, ['ready-to-record']);
    const regionCapture = await page.evaluate(() => 'CropTarget' in window);
    test.skip(!regionCapture, 'Region Capture not available in this browser build');
    await configure(page, { method: 'capture', format: 'mp4', autoDuration: false, duration: 2, mode: 'this-tab' });
    await page.click('[data-el="record"]');
    await waitForStatus(page, ['recording', 'error']);
    await expectNoError(page);
    // The crop succeeded, so no "whole tab recorded" warning is shown.
    await expect(page.locator('[data-el="recording-size"]')).not.toContainText('seluruh tab');
    await waitForStatus(page, ['completed', 'error']);
    await expectNoError(page);
    const { inspection } = await downloadResult(page, testInfo.outputDir);
    expect(inspection.container).toBe('mp4');
    expect(inspection.video).toMatchObject({ width: 1280, height: 720 });
    expect(inspection.audio?.codec).toBe('aac');
    // The preview area is smaller than the target, so the user is told honestly that it was upscaled.
    await expect(page.locator('[data-el="result-notes"]')).toContainText('Resolusi tangkapan');
  });
});
