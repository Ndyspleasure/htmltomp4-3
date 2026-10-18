import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { expect, type Page } from '@playwright/test';
import { inspectOutput, type OutputInspection } from '../../src/features/converter/export/output-validation';

/**
 * Replaces getDisplayMedia with a deterministic canvas + oscillator stream so the full
 * record → encode → validate → download pipeline can run headless without a capture picker.
 */
export async function installFakeDisplayMedia(page: Page, options: { audio?: boolean; deny?: boolean } = {}) {
  await page.addInitScript(
    ({ audio, deny }) => {
      navigator.mediaDevices.getDisplayMedia = async (constraints?: DisplayMediaStreamOptions) => {
        if (deny) throw new DOMException('Permission denied', 'NotAllowedError');
        const canvas = document.createElement('canvas');
        canvas.width = 1280;
        canvas.height = 720;
        const g = canvas.getContext('2d')!;
        let t = 0;
        setInterval(() => {
          t += 1;
          g.fillStyle = `hsl(${(t * 4) % 360},70%,45%)`;
          g.fillRect(0, 0, 1280, 720);
          g.fillStyle = '#fff';
          g.fillRect((t * 12) % 1180, 300, 100, 100);
        }, 33);
        const stream = canvas.captureStream(30);
        if (audio && constraints?.audio) {
          const ctx = new AudioContext();
          const osc = ctx.createOscillator();
          osc.frequency.value = 440;
          const dest = ctx.createMediaStreamDestination();
          osc.connect(dest);
          osc.start();
          stream.addTrack(dest.stream.getAudioTracks()[0]!);
        }
        return stream;
      };
    },
    { audio: options.audio ?? true, deny: options.deny ?? false },
  );
}

export async function status(page: Page): Promise<string> {
  return page.evaluate(() => (window as unknown as { __h2m: { status: string } }).__h2m.status);
}

export async function waitForStatus(page: Page, statuses: string[], timeout = 90_000) {
  await page.waitForFunction(
    (wanted) => wanted.includes((window as unknown as { __h2m?: { status: string } }).__h2m?.status ?? ''),
    statuses,
    { timeout },
  );
}

export async function loadFixture(page: Page, file: string | { name: string; mimeType: string; buffer: Buffer }) {
  await page.goto('/');
  await page.setInputFiles('[data-el="file-input"]', file);
}

export async function configure(
  page: Page,
  settings: {
    method?: 'direct' | 'capture';
    format?: string;
    duration?: number;
    autoDuration?: boolean;
    mode?: 'this-tab' | 'preview-window';
    includeAudio?: boolean;
  },
) {
  if (settings.method) await page.check(`input[name="method"][value="${settings.method}"]`);
  if (settings.format) await page.check(`input[name="outputFormat"][value="${settings.format}"]`);
  if (settings.autoDuration === false) await page.uncheck('input[name="autoDuration"]');
  if (settings.duration !== undefined) {
    await page.fill('input[name="durationSeconds"]', String(settings.duration));
    await page.locator('input[name="durationSeconds"]').dispatchEvent('change');
  }
  if (settings.mode) await page.check(`input[name="captureMode"][value="${settings.mode}"]`);
  if (settings.includeAudio === false) await page.uncheck('input[name="includeAudio"]');
}

export async function downloadResult(
  page: Page,
  dir: string,
): Promise<{ path: string; name: string; inspection: OutputInspection }> {
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('[data-el="download"]')]);
  const name = download.suggestedFilename();
  const path = `${dir}/${name}`;
  await download.saveAs(path);
  const bytes = readFileSync(path);
  const inspection = await inspectOutput(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  );
  return { path, name, inspection };
}

/** Independent check with ffprobe when it is installed (CI installs ffmpeg); returns null otherwise. */
export function ffprobe(path: string): { format: string; codecs: string[]; duration: number } | null {
  try {
    const out = execFileSync('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'format=format_name,duration:stream=codec_name',
      '-of',
      'json',
      path,
    ]).toString();
    const json = JSON.parse(out) as {
      format: { format_name: string; duration: string };
      streams: { codec_name: string }[];
    };
    return {
      format: json.format.format_name,
      codecs: json.streams.map((s) => s.codec_name),
      duration: Number(json.format.duration),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function expectNoError(page: Page) {
  await expect(page.locator('[data-el="global-error"]')).toBeHidden();
}

/**
 * Returns true if a frame at `seconds` contains pixels close to `rgb` (requires ffmpeg; null when it is
 * not installed). Used to prove that elements outside the cropped stage never reach the video.
 */
export function frameContainsColor(path: string, seconds: number, rgb: [number, number, number]): boolean | null {
  let raw: Buffer;
  try {
    raw = execFileSync(
      'ffmpeg',
      [
        '-v',
        'error',
        '-ss',
        String(seconds),
        '-i',
        path,
        '-frames:v',
        '1',
        '-vf',
        'scale=270:-2',
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgb24',
        '-',
      ],
      {
        maxBuffer: 64 * 1024 * 1024,
      },
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  for (let i = 0; i + 2 < raw.length; i += 3) {
    if (Math.abs(raw[i]! - rgb[0]) < 40 && Math.abs(raw[i + 1]! - rgb[1]) < 40 && Math.abs(raw[i + 2]! - rgb[2]) < 40)
      return true;
  }
  return false;
}
