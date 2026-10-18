import { unzipSync, type UnzipFileInfo } from 'fflate';
import { IMPORT_LIMITS } from '../../../config/converter-config';
import { ConverterError } from '../errors';
import { formatBytes } from '../format';
import type { SourceFile } from '../types';
import { normalizeArchivePath } from '../validation/archive-path';
import { looksLikeZip } from '../validation/validate-file';

export interface ZipReadResult {
  files: SourceFile[];
  totalExtractedBytes: number;
  warnings: string[];
}

/**
 * Extracts a ZIP archive with guards against path traversal, entry-count and size abuse (ZIP bombs).
 *
 * Every entry is checked in fflate's filter callback *before* it is inflated. fflate allocates the
 * output buffer from the declared uncompressed size and never grows it, so a lying header cannot make
 * an entry inflate beyond the size we validated here.
 */
export function readZip(bytes: Uint8Array): ZipReadResult {
  if (!looksLikeZip(bytes)) throw new ConverterError('zip-invalid', 'File bukan arsip ZIP yang valid.');

  const warnings: string[] = [];
  const nameByRaw = new Map<string, string>();
  const seenPaths = new Set<string>();
  let entryCount = 0;
  let declaredTotal = 0;

  const filter = (info: UnzipFileInfo): boolean => {
    entryCount += 1;
    if (entryCount > IMPORT_LIMITS.maxArchiveEntries) {
      throw new ConverterError(
        'zip-too-many-entries',
        `Arsip berisi lebih dari ${IMPORT_LIMITS.maxArchiveEntries} entri. Kurangi jumlah file.`,
      );
    }
    const normalized = normalizeArchivePath(info.name);
    if (normalized.kind === 'unsafe') {
      throw new ConverterError(
        'zip-unsafe-path',
        `Arsip ditolak: entri "${info.name}" tidak aman (${normalized.reason}).`,
      );
    }
    if (normalized.kind !== 'file') return false;

    if (info.compression !== 0 && info.compression !== 8) {
      throw new ConverterError(
        'zip-invalid',
        `Metode kompresi entri "${normalized.path}" tidak didukung (hanya store/deflate).`,
      );
    }
    if (info.originalSize > IMPORT_LIMITS.maxSingleEntryBytes) {
      throw new ConverterError(
        'zip-too-large',
        `File "${normalized.path}" terlalu besar setelah diekstrak (${formatBytes(info.originalSize)}).`,
      );
    }
    if (
      info.originalSize > IMPORT_LIMITS.compressionRatioMinBytes &&
      info.originalSize / Math.max(info.size, 1) > IMPORT_LIMITS.maxCompressionRatio
    ) {
      throw new ConverterError(
        'zip-bomb',
        `Arsip ditolak: rasio kompresi "${normalized.path}" mencurigakan (indikasi ZIP bomb).`,
      );
    }
    declaredTotal += info.originalSize;
    if (declaredTotal > IMPORT_LIMITS.maxExtractedBytes) {
      throw new ConverterError(
        'zip-too-large',
        `Total isi arsip melebihi batas ${formatBytes(IMPORT_LIMITS.maxExtractedBytes)} setelah diekstrak.`,
      );
    }
    if (seenPaths.has(normalized.path)) {
      warnings.push(`Entri duplikat "${normalized.path}" diabaikan.`);
      return false;
    }
    seenPaths.add(normalized.path);
    nameByRaw.set(info.name, normalized.path);
    return true;
  };

  let extracted: Record<string, Uint8Array>;
  try {
    extracted = unzipSync(bytes, { filter });
  } catch (error) {
    if (error instanceof ConverterError) throw error;
    throw new ConverterError('zip-invalid', 'Arsip ZIP rusak atau tidak dapat dibaca.', { cause: error });
  }

  const files: SourceFile[] = [];
  let totalExtractedBytes = 0;
  for (const [rawName, data] of Object.entries(extracted)) {
    const path = nameByRaw.get(rawName);
    if (!path) continue;
    totalExtractedBytes += data.byteLength;
    files.push({ path, data });
  }
  if (totalExtractedBytes > IMPORT_LIMITS.maxExtractedBytes) {
    throw new ConverterError(
      'zip-too-large',
      `Total isi arsip melebihi batas ${formatBytes(IMPORT_LIMITS.maxExtractedBytes)}.`,
    );
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, totalExtractedBytes, warnings };
}

const HTML_EXTENSION = /\.html?$/i;

/** Returns HTML entry candidates: root index.html first, then the shallowest index.html, then other HTML files. */
export function findHtmlEntries(paths: string[]): string[] {
  const html = paths.filter((path) => HTML_EXTENSION.test(path));
  const depth = (path: string) => path.split('/').length;
  const isIndex = (path: string) => /(^|\/)index\.html?$/i.test(path);
  return [...html].sort((a, b) => {
    if (isIndex(a) !== isIndex(b)) return isIndex(a) ? -1 : 1;
    if (depth(a) !== depth(b)) return depth(a) - depth(b);
    return a.localeCompare(b);
  });
}
