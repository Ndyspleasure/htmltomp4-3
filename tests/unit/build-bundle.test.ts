import { describe, expect, it } from 'vitest';
import { buildPreviewBundle } from '../../src/features/converter/preview/build-bundle';
import type { ImportedSource } from '../../src/features/converter/types';

const enc = (s: string) => new TextEncoder().encode(s);

function source(files: Record<string, string | Uint8Array>): ImportedSource {
  const list = Object.entries(files).map(([path, data]) => ({
    path,
    data: typeof data === 'string' ? enc(data) : data,
  }));
  return {
    kind: 'zip',
    name: 'p.zip',
    sizeBytes: 1,
    files: list,
    htmlEntries: list.filter((f) => f.path.endsWith('.html')).map((f) => f.path),
    totalExtractedBytes: 1,
  };
}

describe('buildPreviewBundle', () => {
  it('creates one asset per file, rewrites CSS/JS and leaves HTML for the sandbox', () => {
    const bundle = buildPreviewBundle(
      source({
        'site/index.html': '<link rel="stylesheet" href="css/a.css"><script type="module" src="js/main.js"></script>',
        'site/css/a.css': '.x{background:url(../img/p.png)}',
        'site/js/main.js': "import './util.js';",
        'site/js/util.js': 'export const a = 1;',
        'site/img/p.png': new Uint8Array([137, 80, 78, 71]),
        'site/other.html': '<p>other</p>',
      }),
      'site/index.html',
    );
    expect(bundle.baseDir).toBe('site');
    expect(bundle.html).toContain('css/a.css'); // raw, rewritten later in the sandbox
    const byPath = Object.fromEntries(bundle.assets.map((a) => [a.path, a]));
    expect(byPath['site/css/a.css']?.data).toBe(
      `.x{background:url("__H2M_ASSET_${bundle.pathIndex['site/img/p.png']}__")}`,
    );
    expect(byPath['site/css/a.css']?.mime).toBe('text/css');
    expect(byPath['site/js/main.js']?.data).toContain(`__H2M_ASSET_${bundle.pathIndex['site/js/util.js']}__`);
    expect(byPath['site/js/main.js']?.deps).toEqual([bundle.pathIndex['site/js/util.js']]);
    expect(byPath['site/img/p.png']?.data).toBeInstanceOf(ArrayBuffer);
    expect(byPath['site/other.html']?.rewriteInSandbox).toBe('html');
    expect(bundle.warnings).toEqual([]);
  });

  it('reports missing assets referenced from CSS', () => {
    const bundle = buildPreviewBundle(
      source({ 'index.html': '<p>x</p>', 'a.css': '.x{background:url(gone.png)}' }),
      'index.html',
    );
    expect(bundle.warnings.join(' ')).toContain('gone.png');
  });

  it('copies binary data so the upload buffer is never shared', () => {
    const data = new Uint8Array([1, 2, 3]);
    const bundle = buildPreviewBundle(source({ 'index.html': '<p>x</p>', 'a.bin': data }), 'index.html');
    const asset = bundle.assets.find((a) => a.path === 'a.bin');
    expect(asset?.data).not.toBe(data.buffer);
  });

  it('throws for an unknown entry point', () => {
    expect(() => buildPreviewBundle(source({ 'index.html': '<p>x</p>' }), 'missing.html')).toThrow(/tidak ditemukan/);
  });
});
