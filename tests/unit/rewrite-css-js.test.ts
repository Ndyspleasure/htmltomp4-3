import { describe, expect, it } from 'vitest';
import { ReferenceResolver } from '../../src/features/converter/preview/reference-resolver';
import { rewriteCss } from '../../src/features/converter/preview/rewrite-css';
import { rewriteModuleImports } from '../../src/features/converter/preview/rewrite-js';

const paths = ['img/bg.png', 'fonts/a.woff2', 'css/base.css', 'js/util.js', 'js/lib/math.js', 'js/main.js'];
const index = new Map(paths.map((p, i) => [p, i]));

describe('rewriteCss', () => {
  it('rewrites url() in all quote styles and @import, keeps externals', () => {
    const resolver = new ReferenceResolver(index, '');
    const deps = new Set<number>();
    const css = `@import "base.css";
      .a{background:url(../img/bg.png)} .b{background:url('../img/bg.png#x')}
      @font-face{src:url("../fonts/a.woff2?v=2") format("woff2")}
      .c{background:url(https://cdn.example.com/x.png)} .d{background:url(data:image/png;base64,AAA)}`;
    const out = rewriteCss(css, 'css', resolver, deps);
    expect(out).toContain('@import "__H2M_ASSET_2__"');
    expect(out).toContain('url("__H2M_ASSET_0__")');
    expect(out).toContain('url("__H2M_ASSET_0__#x")');
    expect(out).toContain('url("__H2M_ASSET_1__")');
    expect(out).toContain('url(https://cdn.example.com/x.png)');
    expect(out).toContain('url(data:image/png;base64,AAA)');
    expect([...deps].sort()).toEqual([0, 1, 2]);
  });

  it('records missing references without changing them', () => {
    const resolver = new ReferenceResolver(index, '');
    const out = rewriteCss('.x{background:url(missing.png)}', '', resolver, new Set());
    expect(out).toBe('.x{background:url(missing.png)}');
    expect([...resolver.missing]).toEqual(['missing.png']);
  });
});

describe('rewriteModuleImports', () => {
  it('rewrites static, re-export and literal dynamic imports; keeps bare and URL specifiers', () => {
    const resolver = new ReferenceResolver(index, '');
    const deps = new Set<number>();
    const source = [
      "import { a } from './util.js';",
      "export * from './lib/math.js';",
      "import gsap from 'gsap';",
      "import x from 'https://cdn.example.com/x.js';",
      "const m = await import('./util.js');",
      'const g = import(`./lib/${name}.js`);',
    ].join('\n');
    const out = rewriteModuleImports(source, 'js', resolver, deps);
    expect(out).toContain("from '__H2M_ASSET_3__'");
    expect(out).toContain("export * from '__H2M_ASSET_4__'");
    expect(out).toContain("from 'gsap'");
    expect(out).toContain("from 'https://cdn.example.com/x.js'");
    expect(out).toContain("import('__H2M_ASSET_3__')");
    expect(out).toContain('import(`./lib/${name}.js`)');
    expect([...deps].sort()).toEqual([3, 4]);
  });

  it('returns classic scripts and unparsable code unchanged', () => {
    const resolver = new ReferenceResolver(index, '');
    expect(rewriteModuleImports('var a = 1; console.log(a);', 'js', resolver, new Set())).toBe(
      'var a = 1; console.log(a);',
    );
    expect(rewriteModuleImports('function (', 'js', resolver, new Set())).toBe('function (');
  });
});
