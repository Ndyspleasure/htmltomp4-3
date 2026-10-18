/**
 * Web Audio handling inside the render sandbox.
 *
 * - 'silence' (virtual-time passes): sound sent to the speakers is dropped, so nothing is audible while
 *   frames are rendered; we only note that Web Audio / speechSynthesis are used.
 * - 'record' (real-time audio pass): sound sent to the speakers is redirected into a MediaStream
 *   destination per AudioContext and recorded with MediaRecorder from the moment the context is first
 *   connected. No screen-capture permission is involved; the sound never leaves the sandbox document.
 */
export interface CapturedWebAudio {
  data: ArrayBuffer;
  startSeconds: number;
}

interface ContextRecording {
  destination: MediaStreamAudioDestinationNode;
  recorder: MediaRecorder;
  chunks: Blob[];
  startSeconds: number;
  stopped: Promise<void>;
}

export class WebAudioCapture {
  used = false;
  speechUsed = false;
  private readonly recordings = new Map<BaseAudioContext, ContextRecording>();
  private startedAt = 0;
  private origin = 0;

  constructor(private readonly mode: 'silence' | 'record') {}

  install(win: Window & typeof globalThis): void {
    const capture = this;
    this.startedAt = win.performance.now();
    if (win.AudioNode && win.AudioDestinationNode) {
      const proto = win.AudioNode.prototype;
      const originalConnect = proto.connect as (...args: unknown[]) => unknown;
      proto.connect = function connect(this: AudioNode, ...args: unknown[]) {
        const target = args[0];
        if (target instanceof win.AudioDestinationNode) {
          capture.used = true;
          if (capture.mode === 'silence') return target;
          const recording = capture.recordingFor(win, this.context);
          if (recording) return originalConnect.apply(this, [recording.destination, ...args.slice(1)]);
        }
        return originalConnect.apply(this, args);
      } as typeof proto.connect;
    }
    const synth = win.speechSynthesis;
    if (synth) {
      synth.speak = () => {
        capture.speechUsed = true;
      };
    }
  }

  private recordingFor(win: Window & typeof globalThis, context: BaseAudioContext): ContextRecording | null {
    const existing = this.recordings.get(context);
    if (existing) return existing;
    if (!(context instanceof win.AudioContext) || typeof win.MediaRecorder !== 'function') return null;
    const destination = context.createMediaStreamDestination();
    const mime = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'].find((type) =>
      win.MediaRecorder.isTypeSupported(type),
    );
    const recorder = new win.MediaRecorder(destination.stream, mime ? { mimeType: mime } : undefined);
    const chunks: Blob[] = [];
    recorder.addEventListener('dataavailable', (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    });
    const stopped = new Promise<void>((resolve) => recorder.addEventListener('stop', () => resolve(), { once: true }));
    const recording: ContextRecording = {
      destination,
      recorder,
      chunks,
      startSeconds: (win.performance.now() - this.startedAt) / 1000,
      stopped,
    };
    recorder.start(250);
    this.recordings.set(context, recording);
    return recording;
  }

  /** Sets t=0 of the timeline (performance.now() value) that recording offsets are relative to. */
  setOrigin(origin: number): void {
    this.origin = origin - this.startedAt;
  }

  /** Stops all recorders and returns the captured audio with its offset on the timeline. */
  async finish(): Promise<CapturedWebAudio[]> {
    const results: CapturedWebAudio[] = [];
    for (const recording of this.recordings.values()) {
      if (recording.recorder.state !== 'inactive') recording.recorder.stop();
      await recording.stopped;
      const blob = new Blob(recording.chunks, { type: recording.recorder.mimeType });
      if (blob.size > 0)
        results.push({ data: await blob.arrayBuffer(), startSeconds: recording.startSeconds - this.origin / 1000 });
    }
    this.recordings.clear();
    return results;
  }
}
