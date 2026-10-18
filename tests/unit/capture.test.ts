// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mapCaptureError, requestDisplayCapture } from '../../src/features/converter/capture/display-capture';
import { startRecording } from '../../src/features/converter/capture/media-recorder';

class FakeTrack extends EventTarget {
  stopped = false;
  constructor(
    readonly kind: 'video' | 'audio',
    private readonly settings: Record<string, unknown> = {},
    private readonly handle: string | null = null,
  ) {
    super();
  }
  stop() {
    this.stopped = true;
  }
  getSettings() {
    return this.settings;
  }
  getCaptureHandle() {
    return this.handle ? { handle: this.handle } : null;
  }
}

class FakeStream {
  constructor(readonly tracks: FakeTrack[]) {}
  getTracks() {
    return this.tracks;
  }
  getVideoTracks() {
    return this.tracks.filter((t) => t.kind === 'video');
  }
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === 'audio');
  }
}

function installCapture(result: FakeStream | Error) {
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getDisplayMedia: vi.fn(() => (result instanceof Error ? Promise.reject(result) : Promise.resolve(result))),
    },
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('requestDisplayCapture', () => {
  it('requires a secure context and API support', async () => {
    Object.defineProperty(window, 'isSecureContext', { value: false, configurable: true });
    await expect(requestDisplayCapture({ mode: 'this-tab', frameRate: 30, wantAudio: false })).rejects.toMatchObject({
      code: 'insecure-context',
    });
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {} });
    await expect(requestDisplayCapture({ mode: 'this-tab', frameRate: 30, wantAudio: false })).rejects.toMatchObject({
      code: 'capture-unsupported',
    });
  });

  it('maps a denied permission to a clear error', async () => {
    installCapture(new DOMException('denied', 'NotAllowedError'));
    await expect(
      requestDisplayCapture({ mode: 'preview-window', frameRate: 30, wantAudio: true }),
    ).rejects.toMatchObject({
      code: 'permission-denied',
    });
  });

  it('accepts the expected tab and reports a missing audio track as a warning', async () => {
    const stream = new FakeStream([new FakeTrack('video', { displaySurface: 'browser' }, 'h2m-preview:1')]);
    installCapture(stream);
    const outcome = await requestDisplayCapture({
      mode: 'preview-window',
      frameRate: 30,
      wantAudio: true,
      expectedHandle: 'h2m-preview:1',
    });
    expect(outcome.verifiedSurface).toBe(true);
    expect(outcome.audioTrack).toBeNull();
    expect(outcome.warnings.join(' ')).toMatch(/audio/);
  });

  it('rejects and stops the stream when the converter tab was picked instead of the preview window', async () => {
    const track = new FakeTrack('video', { displaySurface: 'browser' }, 'h2m-main:1');
    installCapture(new FakeStream([track]));
    await expect(
      requestDisplayCapture({
        mode: 'preview-window',
        frameRate: 30,
        wantAudio: false,
        expectedHandle: 'h2m-preview:1',
      }),
    ).rejects.toMatchObject({ code: 'wrong-surface' });
    expect(track.stopped).toBe(true);
  });

  it('rejects a window/screen surface in this-tab mode', async () => {
    installCapture(new FakeStream([new FakeTrack('video', { displaySurface: 'monitor' })]));
    await expect(requestDisplayCapture({ mode: 'this-tab', frameRate: 30, wantAudio: false })).rejects.toMatchObject({
      code: 'wrong-surface',
    });
  });

  it('treats an unverifiable surface as a warning, not an error', async () => {
    installCapture(new FakeStream([new FakeTrack('video', { displaySurface: 'window' }), new FakeTrack('audio')]));
    const outcome = await requestDisplayCapture({
      mode: 'preview-window',
      frameRate: 30,
      wantAudio: true,
      expectedHandle: 'x',
    });
    expect(outcome.verifiedSurface).toBe(false);
    expect(outcome.warnings.join(' ')).toMatch(/tidak dapat diverifikasi/);
  });

  it('fails when no video track is delivered', async () => {
    installCapture(new FakeStream([new FakeTrack('audio')]));
    await expect(
      requestDisplayCapture({ mode: 'preview-window', frameRate: 30, wantAudio: true }),
    ).rejects.toMatchObject({
      code: 'no-video-track',
    });
  });

  it('maps unknown errors', () => {
    expect(mapCaptureError(new DOMException('x', 'AbortError')).code).toBe('capture-aborted');
    expect(mapCaptureError(new DOMException('x', 'NotReadableError')).code).toBe('capture-aborted');
    expect(mapCaptureError(new TypeError('x')).code).toBe('capture-unsupported');
  });
});

class FakeRecorder extends EventTarget {
  static instances: FakeRecorder[] = [];
  state: 'inactive' | 'recording' = 'inactive';
  constructor(
    readonly stream: FakeStream,
    readonly options: MediaRecorderOptions,
  ) {
    super();
    FakeRecorder.instances.push(this);
  }
  get mimeType() {
    return this.options.mimeType ?? '';
  }
  start() {
    this.state = 'recording';
  }
  stop() {
    if (this.state === 'inactive') return;
    this.state = 'inactive';
    this.emitData(new Blob(['chunk'], { type: this.mimeType }));
    this.dispatchEvent(new Event('stop'));
  }
  emitData(data: Blob) {
    const event = new Event('dataavailable') as Event & { data: Blob };
    event.data = data;
    this.dispatchEvent(event);
  }
}

function setupRecorderGlobals() {
  FakeRecorder.instances = [];
  vi.stubGlobal('MediaStream', FakeStream);
}

const recorderCtor = FakeRecorder as unknown as new (s: MediaStream, o?: MediaRecorderOptions) => MediaRecorder;

describe('startRecording', () => {
  it('records video+audio and produces a blob with the recorder MIME', async () => {
    setupRecorderGlobals();
    const stream = new FakeStream([new FakeTrack('video', { width: 640, height: 360 }), new FakeTrack('audio')]);
    const session = startRecording(
      stream as unknown as MediaStream,
      { mimeType: 'video/webm', audioOnly: false, includeAudio: true, maxDurationMs: 10_000 },
      recorderCtor,
    );
    expect(FakeRecorder.instances[0]?.stream.getTracks()).toHaveLength(2);
    session.stop();
    const result = await session.done;
    expect(result.mimeType).toBe('video/webm');
    expect(result.blob.size).toBeGreaterThan(0);
    expect(result).toMatchObject({ hasAudio: true, hasVideo: true, captureWidth: 640, captureHeight: 360 });
  });

  it('records only audio tracks for MP3 and requires one', () => {
    setupRecorderGlobals();
    const videoOnly = new FakeStream([new FakeTrack('video')]);
    expect(() =>
      startRecording(
        videoOnly as unknown as MediaStream,
        { mimeType: 'audio/webm', audioOnly: true, includeAudio: true, maxDurationMs: 1000 },
        recorderCtor,
      ),
    ).toThrow(/audio/);
    const both = new FakeStream([new FakeTrack('video'), new FakeTrack('audio')]);
    startRecording(
      both as unknown as MediaStream,
      { mimeType: 'audio/webm', audioOnly: true, includeAudio: true, maxDurationMs: 1000 },
      recorderCtor,
    );
    expect(FakeRecorder.instances[0]?.stream.getTracks().map((t) => t.kind)).toEqual(['audio']);
  });

  it('excludes audio when not requested', () => {
    setupRecorderGlobals();
    const both = new FakeStream([new FakeTrack('video'), new FakeTrack('audio')]);
    startRecording(
      both as unknown as MediaStream,
      { mimeType: 'video/webm', audioOnly: false, includeAudio: false, maxDurationMs: 1000 },
      recorderCtor,
    );
    expect(FakeRecorder.instances[0]?.stream.getTracks().map((t) => t.kind)).toEqual(['video']);
  });

  it('stops automatically at the duration limit', async () => {
    vi.useFakeTimers();
    setupRecorderGlobals();
    const onAutoStop = vi.fn();
    const stream = new FakeStream([new FakeTrack('video')]);
    const session = startRecording(
      stream as unknown as MediaStream,
      { mimeType: 'video/webm', audioOnly: false, includeAudio: false, maxDurationMs: 3000, onAutoStop },
      recorderCtor,
    );
    vi.advanceTimersByTime(3000);
    await expect(session.done).resolves.toMatchObject({ hasVideo: true });
    expect(onAutoStop).toHaveBeenCalledWith('limit');
  });

  it('stops when the user ends sharing (track ended)', async () => {
    setupRecorderGlobals();
    const onAutoStop = vi.fn();
    const video = new FakeTrack('video');
    const session = startRecording(
      new FakeStream([video]) as unknown as MediaStream,
      { mimeType: 'video/webm', audioOnly: false, includeAudio: false, maxDurationMs: 60_000, onAutoStop },
      recorderCtor,
    );
    video.dispatchEvent(new Event('ended'));
    await expect(session.done).resolves.toBeTruthy();
    expect(onAutoStop).toHaveBeenCalledWith('ended');
  });

  it('rejects with cancelled and discards data on cancel', async () => {
    setupRecorderGlobals();
    const session = startRecording(
      new FakeStream([new FakeTrack('video')]) as unknown as MediaStream,
      { mimeType: 'video/webm', audioOnly: false, includeAudio: false, maxDurationMs: 60_000 },
      recorderCtor,
    );
    session.cancel();
    await expect(session.done).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('rejects an empty recording', async () => {
    setupRecorderGlobals();
    const session = startRecording(
      new FakeStream([new FakeTrack('video')]) as unknown as MediaStream,
      { mimeType: 'video/webm', audioOnly: false, includeAudio: false, maxDurationMs: 60_000 },
      recorderCtor,
    );
    const recorder = FakeRecorder.instances[0]!;
    recorder.stop = function stop() {
      this.state = 'inactive';
      this.dispatchEvent(new Event('stop'));
    };
    session.stop();
    await expect(session.done).rejects.toMatchObject({ code: 'recording-empty' });
  });

  it('surfaces recorder errors', async () => {
    setupRecorderGlobals();
    const session = startRecording(
      new FakeStream([new FakeTrack('video')]) as unknown as MediaStream,
      { mimeType: 'video/webm', audioOnly: false, includeAudio: false, maxDurationMs: 60_000 },
      recorderCtor,
    );
    FakeRecorder.instances[0]!.dispatchEvent(new Event('error'));
    await expect(session.done).rejects.toMatchObject({ code: 'recording-failed' });
  });
});
