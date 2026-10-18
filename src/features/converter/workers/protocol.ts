import type { ConverterErrorCode } from '../errors';
import type { ConvertRequest, ConvertResult, EncodeStage, EncoderSupport } from '../export/convert-media';
import type { FrameEncodeConfig, MixedAudio } from '../export/frame-encoder';
import type { ZipReadResult } from '../import/read-zip';

export type EncoderRequest =
  | { type: 'probe'; id: number; width: number; height: number }
  | { type: 'convert'; id: number; request: ConvertRequest }
  | { type: 'frames-begin'; id: number; config: FrameEncodeConfig }
  | { type: 'frames-add'; id: number; index: number; bitmap: ImageBitmap }
  | { type: 'frames-audio'; id: number; audio: MixedAudio | null }
  | { type: 'frames-end'; id: number }
  | { type: 'cancel'; id: number };

export type EncoderResponse =
  | { type: 'probe-result'; id: number; support: EncoderSupport }
  | { type: 'progress'; id: number; stage: EncodeStage; fraction: number | null }
  | { type: 'frames-ready'; id: number }
  | { type: 'frames-ack'; id: number; index: number }
  | { type: 'convert-result'; id: number; result: ConvertResult }
  | { type: 'error'; id: number; code: ConverterErrorCode; message: string };

export type ZipRequest = { id: number; bytes: ArrayBuffer };
export type ZipResponse =
  | { id: number; ok: true; result: ZipReadResult }
  | { id: number; ok: false; code: ConverterErrorCode; message: string };
