import { IMPORT_LIMITS } from '../../../config/converter-config';

export type ArchivePathResult =
  | { kind: 'file'; path: string }
  | { kind: 'directory' }
  | { kind: 'ignored'; reason: string }
  | { kind: 'unsafe'; reason: string };

/** OS metadata that zip tools add; never part of a web project. */
const IGNORED_SEGMENTS = new Set(['__MACOSX', '.DS_Store', 'Thumbs.db', 'desktop.ini']);

/**
 * Normalizes a path stored inside a ZIP archive and rejects anything that could escape the
 * archive root (path traversal), absolute paths, drive letters and control characters.
 */
export function normalizeArchivePath(rawName: string): ArchivePathResult {
  if (rawName.length === 0) return { kind: 'unsafe', reason: 'nama kosong' };
  if (rawName.length > IMPORT_LIMITS.maxPathLength) return { kind: 'unsafe', reason: 'path terlalu panjang' };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(rawName)) return { kind: 'unsafe', reason: 'karakter kontrol pada path' };

  const unified = rawName.replace(/\\/g, '/');
  if (unified.startsWith('/')) return { kind: 'unsafe', reason: 'path absolut' };
  if (/^[a-zA-Z]:/.test(unified)) return { kind: 'unsafe', reason: 'path dengan drive letter' };

  const isDirectory = unified.endsWith('/');
  const segments: string[] = [];
  for (const segment of unified.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') return { kind: 'unsafe', reason: 'path traversal (..)' };
    segments.push(segment);
  }

  if (segments.length === 0)
    return isDirectory ? { kind: 'directory' } : { kind: 'unsafe', reason: 'path tidak valid' };
  if (segments.length > IMPORT_LIMITS.maxPathDepth) return { kind: 'unsafe', reason: 'struktur folder terlalu dalam' };
  if (isDirectory) return { kind: 'directory' };

  for (const segment of segments) {
    if (IGNORED_SEGMENTS.has(segment) || segment.startsWith('._')) {
      return { kind: 'ignored', reason: 'metadata sistem operasi' };
    }
  }
  return { kind: 'file', path: segments.join('/') };
}

/**
 * Resolves a reference (as written in HTML/CSS/JS) against the directory of the referring file.
 * Root-relative references ("/assets/a.js") resolve against `rootDir`, the folder of the entry HTML,
 * so projects zipped together with a wrapper folder (e.g. "dist/") keep working.
 */
export function resolveRelativePath(fromDir: string, reference: string, rootDir = ''): string | null {
  const clean = reference.split('#')[0]?.split('?')[0] ?? '';
  if (clean === '') return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(clean);
  } catch {
    decoded = clean;
  }
  const isRootRelative = decoded.startsWith('/');
  const base = (isRootRelative ? rootDir : fromDir).split('/').filter(Boolean);
  for (const segment of decoded.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (base.length === 0) return null;
      base.pop();
      continue;
    }
    base.push(segment);
  }
  return base.length > 0 ? base.join('/') : null;
}

export function dirname(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? '' : path.slice(0, index);
}

/** True for references that point outside the uploaded project (handled by the browser as-is). */
export function isExternalReference(reference: string): boolean {
  const trimmed = reference.trim();
  return (
    trimmed === '' ||
    trimmed.startsWith('#') ||
    /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) || // http:, https:, data:, blob:, mailto:, javascript: ...
    trimmed.startsWith('//')
  );
}
