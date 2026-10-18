import type { AudioSession } from './sandbox-protocol';
import type { MixedAudio } from '../export/frame-encoder';

export const MIX_SAMPLE_RATE = 48_000;

/**
 * Mixes the media playbacks observed on the virtual timeline into one stereo track with
 * OfflineAudioContext (main thread only), so audio stays sample-accurate with the rendered frames.
 * Returns null when nothing audible was played or nothing could be decoded.
 */
export async function mixAudioSessions(
  sessions: AudioSession[],
  durationSeconds: number,
  warnings: string[],
): Promise<MixedAudio | null> {
  if (sessions.length === 0 || typeof OfflineAudioContext !== 'function') return null;
  const length = Math.max(1, Math.round(durationSeconds * MIX_SAMPLE_RATE));
  const context = new OfflineAudioContext({ numberOfChannels: 2, length, sampleRate: MIX_SAMPLE_RATE });
  const decoded = new Map<ArrayBuffer, AudioBuffer | null>();
  let scheduled = 0;

  for (const session of sessions) {
    let buffer = decoded.get(session.data);
    if (buffer === undefined) {
      buffer = await context.decodeAudioData(session.data.slice(0)).catch(() => null);
      decoded.set(session.data, buffer);
      if (!buffer) warnings.push('Satu file audio tidak dapat didekode dan dilewati.');
    }
    if (!buffer) continue;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.loop = session.loop;
    source.playbackRate.value = session.playbackRate;
    const gain = context.createGain();
    gain.gain.value = Math.min(1, Math.max(0, session.volume));
    source.connect(gain).connect(context.destination);
    const offset = session.loop
      ? session.offsetSeconds % buffer.duration
      : Math.min(session.offsetSeconds, buffer.duration);
    source.start(session.startSeconds, offset);
    if (session.stopSeconds !== null) source.stop(Math.max(session.startSeconds, session.stopSeconds));
    scheduled++;
  }
  if (scheduled === 0) return null;
  const rendered = await context.startRendering();
  return {
    sampleRate: rendered.sampleRate,
    channels: Array.from({ length: rendered.numberOfChannels }, (_, c) => rendered.getChannelData(c)),
  };
}
