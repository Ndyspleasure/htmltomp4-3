// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { ReferenceResolver } from '../../src/features/converter/preview/reference-resolver';
import { rewriteHtml } from '../../src/features/converter/preview/rewrite-html';

const paths = [
  'style.css',
  'app.js',
  'img/a.png',
  'img/a@2x.png',
  'media/s.mp3',
  'module.js',
  'dep.js',
  'poster.jpg',
  'icons.svg',
];
const index = new Map(paths.map((p, i) => [p, i]));

describe('rewriteHtml', () => {
  it('rewrites resource attributes, srcset, inline styles, style tags and inline modules', () => {
    const resolver = new ReferenceResolver(index, '');
    const deps = new Set<number>();
    const html = `<!DOCTYPE html><html><head><base href="https://evil.example/">
      <link rel="stylesheet" href="style.css"><script src="app.js"></script>
      <style>.x{background:url(img/a.png)}</style></head><body>
      <img src="img/a.png" srcset="img/a.png 1x, img/a@2x.png 2x">
      <div style="background-image:url('img/a.png')"></div>
      <audio src="media/s.mp3"></audio><video poster="poster.jpg"></video>
      <svg><use href="icons.svg#i"></use></svg>
      <a href="img/a.png">link stays</a>
      <script type="module">import d from './dep.js';</script>
      <img src="https://cdn.example.com/x.png"><img src="nope.png">
      </body></html>`;
    const { html: out, warnings } = rewriteHtml(html, '', resolver, deps);
    expect(out.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(out).not.toContain('<base');
    expect(warnings[0]).toMatch(/<base>/);
    expect(out).toContain('href="__H2M_ASSET_0__"');
    expect(out).toContain('src="__H2M_ASSET_1__"');
    expect(out).toContain('url("__H2M_ASSET_2__")');
    expect(out).toContain('srcset="__H2M_ASSET_2__ 1x, __H2M_ASSET_3__ 2x"');
    expect(out).toContain('src="__H2M_ASSET_4__"');
    expect(out).toContain('poster="__H2M_ASSET_7__"');
    expect(out).toContain('href="__H2M_ASSET_8__#i"');
    expect(out).toContain('<a href="img/a.png">');
    expect(out).toContain("from '__H2M_ASSET_6__'");
    expect(out).toContain('src="https://cdn.example.com/x.png"');
    expect([...resolver.missing]).toEqual(['nope.png']);
    expect(deps.has(1)).toBe(true);
  });

  it('keeps documents without doctype in quirks form', () => {
    const resolver = new ReferenceResolver(index, '');
    const { html } = rewriteHtml('<p>hi</p>', '', resolver, new Set());
    expect(html.startsWith('<html>')).toBe(true);
  });
});
