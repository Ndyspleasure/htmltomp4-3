import { zipSync, strToU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import { ConverterError } from '../../src/features/converter/errors';
import { importSource } from '../../src/features/converter/import/import-source';

describe('importSource', () => {
  it('imports a single HTML file under a sanitized name', async () => {
    const file = new File(['<h1>Hi</h1>'], 'my anim (1).html', { type: 'text/html' });
    const { source } = await importSource(file);
    expect(source.kind).toBe('html');
    expect(source.htmlEntries).toEqual(['my_anim_1_.html']);
    expect(source.files[0]?.data.byteLength).toBe(11);
  });

  it('imports a zip and warns when index.html is missing', async () => {
    const zip = zipSync({ 'scene.html': strToU8('<p>x</p>'), 'a.js': strToU8('1') });
    const { source, warnings } = await importSource(new File([zip], 'p.zip'));
    expect(source.htmlEntries).toEqual(['scene.html']);
    expect(warnings.join(' ')).toMatch(/index\.html tidak ditemukan/);
  });

  it('fails when a zip has no HTML file', async () => {
    const zip = zipSync({ 'a.js': strToU8('1') });
    await expect(importSource(new File([zip], 'p.zip'))).rejects.toMatchObject({ code: 'zip-no-html' });
  });

  it('rejects an HTML file that is actually binary', async () => {
    const file = new File([new Uint8Array([0, 1, 2, 3])], 'x.html');
    await expect(importSource(file)).rejects.toBeInstanceOf(ConverterError);
  });
});
