import { describe, expect, it } from 'vitest';
import { IMPORT_LIMITS } from '../../src/config/converter-config';
import { ConverterError } from '../../src/features/converter/errors';
import { decodeHtml, detectSourceKind, looksLikeZip } from '../../src/features/converter/validation/validate-file';

const encode = (text: string) => new TextEncoder().encode(text);

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof ConverterError ? error.code : 'unknown';
  }
  return undefined;
}

describe('detectSourceKind', () => {
  it('accepts html, htm and zip case-insensitively', () => {
    expect(detectSourceKind({ name: 'a.HTML', size: 10 })).toBe('html');
    expect(detectSourceKind({ name: 'a.htm', size: 10 })).toBe('html');
    expect(detectSourceKind({ name: 'proj.ZIP', size: 10 })).toBe('zip');
  });

  it('rejects unsupported extensions and empty files', () => {
    expect(codeOf(() => detectSourceKind({ name: 'movie.mp4', size: 10 }))).toBe('unsupported-file-type');
    expect(codeOf(() => detectSourceKind({ name: 'noext', size: 10 }))).toBe('unsupported-file-type');
    expect(codeOf(() => detectSourceKind({ name: 'a.html', size: 0 }))).toBe('file-empty');
  });

  it('enforces the configured size limits', () => {
    expect(codeOf(() => detectSourceKind({ name: 'a.html', size: IMPORT_LIMITS.maxHtmlBytes }))).toBeUndefined();
    expect(codeOf(() => detectSourceKind({ name: 'a.html', size: IMPORT_LIMITS.maxHtmlBytes + 1 }))).toBe(
      'file-too-large',
    );
    expect(codeOf(() => detectSourceKind({ name: 'a.zip', size: IMPORT_LIMITS.maxZipBytes + 1 }))).toBe(
      'file-too-large',
    );
  });
});

describe('decodeHtml', () => {
  it('decodes UTF-8 and strips BOM', () => {
    expect(decodeHtml(encode('\uFEFF<p>Halo ✓</p>'))).toBe('<p>Halo ✓</p>');
  });

  it('rejects binary data, zip data and text without markup', () => {
    expect(codeOf(() => decodeHtml(new Uint8Array([60, 112, 0, 62])))).toBe('html-invalid');
    expect(codeOf(() => decodeHtml(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2])))).toBe('html-invalid');
    expect(codeOf(() => decodeHtml(encode('just some text')))).toBe('html-invalid');
  });

  it('sniffs zip signatures', () => {
    expect(looksLikeZip(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toBe(true);
    expect(looksLikeZip(new Uint8Array([0x50, 0x4b, 0x05, 0x06]))).toBe(true);
    expect(looksLikeZip(encode('<html>'))).toBe(false);
  });
});
