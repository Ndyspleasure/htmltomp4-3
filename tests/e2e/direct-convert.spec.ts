import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { htmlFile, zipBuffer } from './fixtures';
import { configure, downloadResult, expectNoError, ffprobe, loadFixture, waitForStatus } from './helpers';

const promo = () => htmlFile(readFileSync('tests/fixtures/promo-player.html', 'utf8'), 'promo-player.html');
const tone = readFileSync('tests/fixtures/media/tone.mp3');

/** A finite 2 s CSS animation that also plays an MP3 through an <audio> element. */
const audioZip = () =>
  zipBuffer({
    'index.html': `<!doctype html><html><head><style>
      body{margin:0;background:#0f172a}
      .box{width:120px;height:120px;background:#22c55e;animation:slide 2s linear forwards}
      @keyframes slide{to{transform:translateX(600px)}}
    </style></head><body><div class="box"></div><audio src="sound/tone.mp3" autoplay></audio></body></html>`,
    'sound/tone.mp3': new Uint8Array(tone),
  });

test.describe('konversi langsung (tanpa izin rekam layar)', () => {
  test('clicks Putar, follows the animation duration and keeps Web Audio (portrait MP4)', async ({
    page,
  }, testInfo) => {
    await loadFixture(page, promo());
    await waitForStatus(page, ['ready-to-record']);
    await expect(page.locator('[data-el="record"]')).toHaveText(/Konversi ke MP4/);
    // The vertical stage is detected and the resolution follows it without any click.
    await expect(page.locator('[data-el="layout-hint"]')).toContainText('otomatis diubah');
    await expect(page.locator('select[name="resolutionId"]')).toHaveValue('1080x1920');
    await page.click('[data-el="record"]');
    await waitForStatus(page, ['completed', 'error'], 120_000);
    await expectNoError(page);
    await expect(page.locator('[data-el="result-notes"]')).toContainText('Putar');
    await expect(page.locator('[data-el="result-notes"]')).toContainText('Durasi mengikuti animasi');
    const { path, inspection } = await downloadResult(page, testInfo.outputDir);
    expect(inspection.container).toBe('mp4');
    expect(inspection.video).toMatchObject({ width: 1080, height: 1920 });
    expect(inspection.audio?.codec).toBe('aac');
    // The fixture animates for 6 s; the render stops shortly after it stops changing.
    expect(inspection.durationSeconds).toBeGreaterThan(5.5);
    expect(inspection.durationSeconds).toBeLessThan(8);
    const probe = ffprobe(path);
    if (probe) expect(probe.codecs).toContain('aac');
  });

  test('exports MP3 from Web Audio without any capture permission', async ({ page }, testInfo) => {
    await loadFixture(page, promo());
    await waitForStatus(page, ['ready-to-record']);
    await configure(page, { format: 'mp3' });
    await page.click('[data-el="record"]');
    await waitForStatus(page, ['completed', 'error'], 120_000);
    await expectNoError(page);
    const { inspection } = await downloadResult(page, testInfo.outputDir);
    expect(inspection).toMatchObject({ container: 'mp3', video: null });
    expect(inspection.durationSeconds).toBeGreaterThan(5.5);
    await expect(page.locator('[data-el="result-notes"]')).not.toContainText('hening');
  });

  test('mixes <audio> elements from a ZIP and stops when a finite CSS animation ends', async ({ page }, testInfo) => {
    await loadFixture(page, { name: 'audio.zip', mimeType: 'application/zip', buffer: audioZip() });
    await waitForStatus(page, ['ready-to-record']);
    await configure(page, { format: 'mp4' });
    await page.click('[data-el="record"]');
    await waitForStatus(page, ['completed', 'error'], 120_000);
    await expectNoError(page);
    const { inspection } = await downloadResult(page, testInfo.outputDir);
    expect(inspection.audio?.codec).toBe('aac');
    expect(inspection.durationSeconds).toBeGreaterThan(1.8);
    expect(inspection.durationSeconds).toBeLessThan(4);
    await expect(page.locator('[data-el="result-notes"]')).not.toContainText('hening');
  });

  test('uses the entered duration for endless loops and says so', async ({ page }, testInfo) => {
    await loadFixture(page, htmlFile());
    await waitForStatus(page, ['ready-to-record']);
    await configure(page, { format: 'webm', includeAudio: false });
    await page.check('input[name="autoDuration"]');
    // The duration field is the fallback for endless animations.
    await page.uncheck('input[name="autoDuration"]');
    await page.fill('input[name="durationSeconds"]', '3');
    await page.locator('input[name="durationSeconds"]').dispatchEvent('change');
    await page.check('input[name="autoDuration"]');
    await page.click('[data-el="record"]');
    await waitForStatus(page, ['completed', 'error'], 120_000);
    await expectNoError(page);
    await expect(page.locator('[data-el="result-notes"]')).toContainText('berulang');
    const { inspection } = await downloadResult(page, testInfo.outputDir);
    expect(inspection.durationSeconds).toBeGreaterThan(2.8);
    expect(inspection.durationSeconds).toBeLessThan(3.5);
  });

  test('honours a manual duration', async ({ page }, testInfo) => {
    await loadFixture(page, promo());
    await waitForStatus(page, ['ready-to-record']);
    await configure(page, { format: 'webm', autoDuration: false, duration: 2, includeAudio: false });
    await page.click('[data-el="record"]');
    await waitForStatus(page, ['completed', 'error'], 120_000);
    await expectNoError(page);
    const { inspection } = await downloadResult(page, testInfo.outputDir);
    expect(inspection.durationSeconds).toBeGreaterThan(1.8);
    expect(inspection.durationSeconds).toBeLessThan(2.5);
  });

  test('explains when MP3 is impossible because nothing plays audio', async ({ page }) => {
    await loadFixture(page, htmlFile());
    await waitForStatus(page, ['ready-to-record']);
    await configure(page, { format: 'mp3', autoDuration: false, duration: 1 });
    await page.click('[data-el="record"]');
    await waitForStatus(page, ['error'], 120_000);
    await expect(page.locator('[data-el="global-error"]')).toContainText('MP3 tidak dapat dibuat');
  });

  test('can be cancelled while rendering', async ({ page }) => {
    await loadFixture(page, promo());
    await waitForStatus(page, ['ready-to-record']);
    await configure(page, { format: 'mp4', autoDuration: false, duration: 30, includeAudio: false });
    await page.click('[data-el="record"]');
    await expect(page.locator('[data-el="progress-stage"]')).toContainText('Merender frame', { timeout: 60_000 });
    await page.click('[data-el="cancel-processing"]');
    await waitForStatus(page, ['cancelled', 'error'], 30_000);
    await expect(page.locator('[data-el="result-section"]')).toBeHidden();
    // No hidden render frames are left behind.
    await expect(page.locator('iframe[title="Render animasi (tersembunyi)"]')).toHaveCount(0);
  });
});
