import { ACCEPTED_EXTENSIONS, IMPORT_LIMITS } from '../../../config/converter-config';
import { ConverterError } from '../errors';
import { formatBytes } from '../format';

export type SourceKind = 'html' | 'zip';

export interface FileLike {
  name: string;
  size: number;
}

export function getExtension(name: string): string {
  const index = name.lastIndexOf('.');
  return index === -1 ? '' : name.slice(index).toLowerCase();
}

/** Validates name and size before any byte is read. Extension alone is never trusted; content is sniffed later. */
export function detectSourceKind(file: FileLike): SourceKind {
  const extension = getExtension(file.name);
  if (!(ACCEPTED_EXTENSIONS as readonly string[]).includes(extension)) {
    throw new ConverterError(
      'unsupported-file-type',
      `Tipe file "${extension || 'tanpa ekstensi'}" tidak didukung. Gunakan file .html, .htm, atau .zip.`,
    );
  }
  if (file.size === 0) throw new ConverterError('file-empty', 'File kosong (0 byte).');

  const kind: SourceKind = extension === '.zip' ? 'zip' : 'html';
  const limit = kind === 'zip' ? IMPORT_LIMITS.maxZipBytes : IMPORT_LIMITS.maxHtmlBytes;
  if (file.size > limit) {
    throw new ConverterError(
      'file-too-large',
      `File terlalu besar (${formatBytes(file.size)}). Batas untuk ${kind === 'zip' ? 'ZIP' : 'HTML'} adalah ${formatBytes(limit)}.`,
    );
  }
  return kind;
}

export function looksLikeZip(bytes: Uint8Array): boolean {
  // Local file header (PK\x03\x04) or empty archive end-of-central-directory (PK\x05\x06).
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    ((bytes[2] === 0x03 && bytes[3] === 0x04) || (bytes[2] === 0x05 && bytes[3] === 0x06))
  );
}

/** Decodes HTML bytes and rejects content that is clearly binary or contains no markup. */
export function decodeHtml(bytes: Uint8Array): string {
  const sample = bytes.subarray(0, Math.min(bytes.length, 8192));
  if (sample.includes(0)) throw new ConverterError('html-invalid', 'File HTML berisi data biner, bukan teks HTML.');
  if (looksLikeZip(bytes)) {
    throw new ConverterError(
      'html-invalid',
      'Isi file adalah arsip ZIP. Ubah ekstensi menjadi .zip atau unggah ulang.',
    );
  }
  const text = new TextDecoder('utf-8').decode(bytes).replace(/^\uFEFF/, '');
  if (!/<\s*[a-zA-Z!][^>]*>/.test(text)) {
    throw new ConverterError('html-invalid', 'File tidak terlihat seperti dokumen HTML (tidak ditemukan tag HTML).');
  }
  return text;
}
