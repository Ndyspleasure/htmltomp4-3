import { zipSync, strToU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import { IMPORT_LIMITS } from '../../src/config/converter-config';
import { ConverterError } from '../../src/features/converter/errors';
import { findHtmlEntries, readZip } from '../../src/features/converter/import/read-zip';

function expectCode(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ConverterError);
    expect((error as ConverterError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

/** Replaces the uncompressed-size field of every central directory record (lying ZIP headers). */
function patchDeclaredSize(zip: Uint8Array, size: number): Uint8Array {
  const out = zip.slice();
  const view = new DataView(out.buffer);
  for (let i = 0; i < out.length - 4; i++) {
    if (view.getUint32(i, true) === 0x02014b50) view.setUint32(i + 24, size, true);
  }
  return out;
}

describe('readZip', () => {
  it('extracts files, normalizes paths and skips OS metadata', () => {
    const zip = zipSync({
      'index.html': strToU8('<h1>hi</h1>'),
      'css/style.css': strToU8('body{}'),
      '__MACOSX/._index.html': strToU8('junk'),
      'img/': new Uint8Array(),
    });
    const result = readZip(zip);
    expect(result.files.map((f) => f.path)).toEqual(['css/style.css', 'index.html']);
    expect(result.totalExtractedBytes).toBe('<h1>hi</h1>'.length + 'body{}'.length);
  });

  it('rejects path traversal entries', () => {
    expectCode(() => readZip(zipSync({ '../evil.html': strToU8('<p>x</p>') })), 'zip-unsafe-path');
    expectCode(() => readZip(zipSync({ 'a/../../evil.html': strToU8('<p>x</p>') })), 'zip-unsafe-path');
  });

  it('rejects absolute paths', () => {
    expectCode(() => readZip(zipSync({ '/abs.html': strToU8('<p>x</p>') })), 'zip-unsafe-path');
  });

  it('rejects archives with too many entries', () => {
    const files: Record<string, Uint8Array> = {};
    for (let i = 0; i <= IMPORT_LIMITS.maxArchiveEntries; i++) files[`f${i}.txt`] = strToU8('x');
    expectCode(() => readZip(zipSync(files)), 'zip-too-many-entries');
  });

  it('rejects highly compressed entries (ZIP bomb)', () => {
    const zeros = new Uint8Array(4 * 1024 * 1024);
    expectCode(() => readZip(zipSync({ 'bomb.bin': zeros }, { level: 9 })), 'zip-bomb');
  });

  it('rejects entries whose declared size exceeds the limit', () => {
    const zip = patchDeclaredSize(
      zipSync({ 'index.html': strToU8('<p>x</p>') }),
      IMPORT_LIMITS.maxSingleEntryBytes + 1,
    );
    expectCode(() => readZip(zip), 'zip-too-large');
  });

  it('never inflates beyond the declared size', () => {
    const big = strToU8('<p>' + 'a'.repeat(10_000) + '</p>');
    const zip = patchDeclaredSize(zipSync({ 'index.html': big }), 16);
    const result = readZip(zip);
    expect(result.files[0]?.data.byteLength).toBeLessThanOrEqual(16);
  });

  it('rejects non-zip and corrupt data', () => {
    expectCode(() => readZip(strToU8('<html></html>')), 'zip-invalid');
    expectCode(() => readZip(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0])), 'zip-invalid');
  });
});

describe('findHtmlEntries', () => {
  it('prefers root index.html, then shallow index.html, then other html', () => {
    expect(findHtmlEntries(['b.html', 'sub/index.html', 'index.htm', 'a.css'])).toEqual([
      'index.htm',
      'sub/index.html',
      'b.html',
    ]);
    expect(findHtmlEntries(['dist/index.html', 'dist/about.html'])).toEqual(['dist/index.html', 'dist/about.html']);
    expect(findHtmlEntries(['a.css'])).toEqual([]);
  });
});
