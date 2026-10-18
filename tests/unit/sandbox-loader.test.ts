// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { buildUrls, createUrlMapper, prepareDocument } from '../../src/sandbox/loader';
import type { PreviewAsset, PreviewBundle } from '../../src/features/converter/types';

describe('sandbox loader', () => {
  it('resolves text asset dependencies before creating their URLs', () => {
    const assets: PreviewAsset[] = [
      { id: 0, path: 'a.css', mime: 'text/css', data: '@import "__H2M_ASSET_1__";', deps: [1] },
      { id: 1, path: 'b.css', mime: 'text/css', data: '.x{background:url("__H2M_ASSET_2__")}', deps: [2] },
      { id: 2, path: 'p.png', mime: 'image/png', data: new ArrayBuffer(4), deps: [] },
    ];
    const created: string[] = [];
    let n = 0;
    const { urls, replaceTokens } = buildUrls(assets, () => {
      const url = `blob:test/${n++}`;
      created.push(url);
      return url;
    });
    expect(urls.size).toBe(3);
    // p.png must be created first, then b.css, then a.css.
    expect(urls.get(2)).toBe('blob:test/0');
    expect(urls.get(1)).toBe('blob:test/1');
    expect(urls.get(0)).toBe('blob:test/2');
    expect(replaceTokens('<img src="__H2M_ASSET_2__">')).toBe('<img src="blob:test/0">');
  });

  it('still creates URLs for circular references', () => {
    const assets: PreviewAsset[] = [
      { id: 0, path: 'a.css', mime: 'text/css', data: '@import "__H2M_ASSET_1__";', deps: [1] },
      { id: 1, path: 'b.css', mime: 'text/css', data: '@import "__H2M_ASSET_0__";', deps: [0] },
    ];
    const { urls } = buildUrls(assets, () => 'blob:x');
    expect(urls.size).toBe(2);
  });

  it('maps runtime URLs relative to the entry directory', () => {
    const urls = new Map([
      [0, 'blob:a'],
      [1, 'blob:b'],
    ]);
    const map = createUrlMapper(urls, { 'site/data.json': 0, 'logo.png': 1 }, 'site', 'https://app.test/sandbox.html');
    expect(map('data.json')).toBe('blob:a');
    expect(map('./data.json?x=1#h')).toBe('blob:a#h');
    expect(map('/logo.png')).toBe('blob:b');
    expect(map('https://cdn.example.com/data.json')).toBe('https://cdn.example.com/data.json');
    expect(map('missing.json')).toBe('missing.json');
    expect(map('data:text/plain,hi')).toBe('data:text/plain,hi');
  });

  it('rewrites the entry and HTML assets and reports warnings', () => {
    const bundle: PreviewBundle = {
      entryPath: 'index.html',
      html: '<img src="a.png"><iframe src="inner.html"></iframe><img src="gone.png">',
      assets: [
        { id: 0, path: 'a.png', mime: 'image/png', data: new ArrayBuffer(1), deps: [] },
        { id: 1, path: 'inner.html', mime: 'text/html', data: '<img src="a.png">', deps: [], rewriteInSandbox: 'html' },
      ],
      warnings: [],
      pathIndex: { 'a.png': 0, 'inner.html': 1 },
      baseDir: '',
    };
    const prepared = prepareDocument(bundle);
    expect(prepared.html).toContain('src="__H2M_ASSET_0__"');
    expect(prepared.html).toContain('src="__H2M_ASSET_1__"');
    expect(prepared.assets[1]?.data).toContain('__H2M_ASSET_0__');
    expect(prepared.assets[1]?.deps).toEqual([0]);
    expect(prepared.warnings.join(' ')).toContain('gone.png');
  });
});
