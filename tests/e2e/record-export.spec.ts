import { expect, test } from '@playwright/test';
import { htmlFile } from './fixtures';
import {
  configure,
  downloadResult,
  expectNoError,
  ffprobe,
  installFakeDisplayMedia,
  loadFixture,
  status,
  waitForStatus,
} from './helpers';

test.describe('record → encode → validate → download', () => {
  test('exports a validated MP4 with video and AAC audio', async ({ page }, testInfo) => {
    await installFakeDisplayMedia(page);
    await loadFixture(page, htmlFile());
    await waitForStatus(page, ['ready-to-record']);
    await configure(page, { format: 'mp4', duration: 2, mode: 'this-tab' });
    await expect(page.locator('[data-el="record"]')).toBeEnabled();
    await page.click('[data-el="record"]');
    await waitForStatus(page, ['completed', 'error']);
    await expectNoError(page);
    await expect(page.locator('[data-el="result-playback"]')).toContainText('dapat diputar');
    const { name, path, inspection } = await downloadResult(page, testInfo.outputDir);
    expect(name).toMatch(/^animation-\d{8}-\d{6}\.mp4$/);
    expect(inspection.container).toBe('mp4');
    expect(inspection.video).toMatchObject({ width: 1280, height: 720 });
    expect(['avc', 'vp9', 'av1']).toContain(inspection.video?.codec);
    expect(inspection.audio?.codec).toBe('aac');
    expect(inspection.durationSeconds).toBeGreaterThan(1.5);
    const probe = ffprobe(path);
    if (probe) {
      expect(probe.format).toContain('mp4');
      expect(probe.codecs).toContain('aac');
    }
  });

  test('exports a validated MP3 from tab audio', async ({ page }, testInfo) => {
    await installFakeDisplayMedia(page);
    await loadFixture(page, htmlFile());
    await waitForStatus(page, ['ready-to-record']);
    await configure(page, { format: 'mp3', duration: 2 });
    await page.click('[data-el="record"]');
    await waitForStatus(page, ['completed', 'error']);
    await expectNoError(page);
    const { name, path, inspection } = await downloadResult(page, testInfo.outputDir);
    expect(name).toMatch(/\.mp3$/);
    expect(inspection).toMatchObject({ container: 'mp3', video: null });
    expect(inspection.audio?.codec).toBe('mp3');
    expect(inspection.durationSeconds).toBeGreaterThan(1.5);
    await expect(page.locator('[data-el="result-notes"]')).toBeHidden(); // a 440 Hz tone is not silent
    const probe = ffprobe(path);
    if (probe) expect(probe.codecs).toEqual(['mp3']);
  });

  test('exports WebM as the honest alternative', async ({ page }, testInfo) => {
    await installFakeDisplayMedia(page);
    await loadFixture(page, htmlFile());
    await waitForStatus(page, ['ready-to-record']);
    await configure(page, { format: 'webm', duration: 2, includeAudio: false });
    await page.click('[data-el="record"]');
    await waitForStatus(page, ['completed', 'error']);
    await expectNoError(page);
    const { name, inspection } = await downloadResult(page, testInfo.outputDir);
    expect(name).toMatch(/\.webm$/);
    expect(inspection.container).toBe('webm');
    expect(inspection.audio).toBeNull();
  });

  test('re-exports the same recording to another format', async ({ page }, testInfo) => {
    await installFakeDisplayMedia(page);
    await loadFixture(page, htmlFile());
    await waitForStatus(page, ['ready-to-record']);
    await configure(page, { format: 'mp4', duration: 2 });
    await page.click('[data-el="record"]');
    await waitForStatus(page, ['completed']);
    await configure(page, { format: 'mp3' });
    await page.click('[data-el="reexport"]');
    await waitForStatus(page, ['processing'], 10_000).catch(() => undefined);
    await waitForStatus(page, ['completed', 'error']);
    await expectNoError(page);
    const { inspection } = await downloadResult(page, testInfo.outputDir);
    expect(inspection.container).toBe('mp3');
  });

  test('handles a denied capture permission without crashing', async ({ page }) => {
    await installFakeDisplayMedia(page, { deny: true });
    await loadFixture(page, htmlFile());
    await waitForStatus(page, ['ready-to-record']);
    await page.click('[data-el="record"]');
    await waitForStatus(page, ['error']);
    await expect(page.locator('[data-el="global-error"]')).toContainText('Izin merekam ditolak');
    await expect(page.locator('[data-el="record"]')).toBeEnabled();
    await expect(page.locator('[data-el="result-section"]')).toBeHidden();
  });

  test('refuses MP3 when the capture has no audio track', async ({ page }) => {
    await installFakeDisplayMedia(page, { audio: false });
    await loadFixture(page, htmlFile());
    await waitForStatus(page, ['ready-to-record']);
    await configure(page, { format: 'mp3', duration: 2 });
    await page.click('[data-el="record"]');
    await waitForStatus(page, ['error']);
    await expect(page.locator('[data-el="global-error"]')).toContainText('MP3 tidak dapat dibuat');
    await expect(page.locator('[data-el="result-section"]')).toBeHidden();
  });

  test('cancelling a recording discards it', async ({ page }) => {
    await installFakeDisplayMedia(page);
    await loadFixture(page, htmlFile());
    await waitForStatus(page, ['ready-to-record']);
    await configure(page, { duration: 30 });
    await page.click('[data-el="record"]');
    await waitForStatus(page, ['recording']);
    await expect(page.locator('[data-el="recording-status"]')).toBeVisible();
    await page.click('[data-el="cancel"]');
    await waitForStatus(page, ['cancelled']);
    await expect(page.locator('[data-el="result-section"]')).toBeHidden();
    expect(await status(page)).toBe('cancelled');
  });

  test('stopping early produces a shorter file', async ({ page }, testInfo) => {
    await installFakeDisplayMedia(page);
    await loadFixture(page, htmlFile());
    await waitForStatus(page, ['ready-to-record']);
    await configure(page, { format: 'webm', duration: 60, includeAudio: false });
    await page.click('[data-el="record"]');
    await waitForStatus(page, ['recording']);
    await page.waitForTimeout(1500);
    await page.click('[data-el="stop"]');
    await waitForStatus(page, ['completed', 'error']);
    await expectNoError(page);
    const { inspection } = await downloadResult(page, testInfo.outputDir);
    expect(inspection.durationSeconds).toBeGreaterThan(0.5);
    expect(inspection.durationSeconds).toBeLessThan(10);
  });
});
