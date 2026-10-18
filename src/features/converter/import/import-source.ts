import { ConverterError } from '../errors';
import type { ImportedSource } from '../types';
import { decodeHtml, detectSourceKind } from '../validation/validate-file';
import { findHtmlEntries, readZip } from './read-zip';

export interface ImportOptions {
  /** Optional worker-backed ZIP reader so large archives do not block the main thread. */
  readZipImpl?: (bytes: Uint8Array) => Promise<ReturnType<typeof readZip>>;
}

export interface ImportOutcome {
  source: ImportedSource;
  warnings: string[];
}

/** Validates and reads an uploaded .html or .zip file. Nothing from the file is executed here. */
export async function importSource(file: File, options: ImportOptions = {}): Promise<ImportOutcome> {
  const kind = detectSourceKind(file);
  const bytes = new Uint8Array(await file.arrayBuffer());

  if (kind === 'html') {
    decodeHtml(bytes); // validates content; the decoded text is produced again by the preview builder
    const path = sanitizeSingleFileName(file.name);
    return {
      source: {
        kind,
        name: file.name,
        sizeBytes: file.size,
        files: [{ path, data: bytes }],
        htmlEntries: [path],
        totalExtractedBytes: bytes.byteLength,
      },
      warnings: [],
    };
  }

  const result = options.readZipImpl ? await options.readZipImpl(bytes) : readZip(bytes);
  const htmlEntries = findHtmlEntries(result.files.map((f) => f.path));
  if (htmlEntries.length === 0) {
    throw new ConverterError(
      'zip-no-html',
      'Arsip tidak berisi file HTML. Tambahkan index.html sebagai entry point di dalam ZIP.',
    );
  }
  const warnings = [...result.warnings];
  if (!/(^|\/)index\.html?$/i.test(htmlEntries[0] ?? '')) {
    warnings.push('index.html tidak ditemukan; pilih file HTML yang menjadi entry point.');
  }
  return {
    source: {
      kind,
      name: file.name,
      sizeBytes: file.size,
      files: result.files,
      htmlEntries,
      totalExtractedBytes: result.totalExtractedBytes,
    },
    warnings,
  };
}

function sanitizeSingleFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'index.html';
  const safe = base.replace(/[^\w.-]+/g, '_');
  return /\.html?$/i.test(safe) ? safe : 'index.html';
}
