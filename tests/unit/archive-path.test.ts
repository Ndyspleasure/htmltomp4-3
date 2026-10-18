import { describe, expect, it } from 'vitest';
import {
  dirname,
  isExternalReference,
  normalizeArchivePath,
  resolveRelativePath,
} from '../../src/features/converter/validation/archive-path';

describe('normalizeArchivePath', () => {
  it('accepts normal nested paths and strips ./ segments', () => {
    expect(normalizeArchivePath('assets/./img/logo.png')).toEqual({ kind: 'file', path: 'assets/img/logo.png' });
    expect(normalizeArchivePath('index.html')).toEqual({ kind: 'file', path: 'index.html' });
  });

  it('treats backslashes as separators', () => {
    expect(normalizeArchivePath('css\\style.css')).toEqual({ kind: 'file', path: 'css/style.css' });
  });

  it.each([
    ['../evil.html', 'path traversal (..)'],
    ['a/../../evil', 'path traversal (..)'],
    ['..\\..\\windows\\system32', 'path traversal (..)'],
    ['/etc/passwd', 'path absolut'],
    ['C:/Windows/evil.dll', 'path dengan drive letter'],
    ['bad\u0000name.html', 'karakter kontrol pada path'],
  ])('rejects unsafe path %j', (name, reason) => {
    expect(normalizeArchivePath(name)).toEqual({ kind: 'unsafe', reason });
  });

  it('rejects overly long and deep paths', () => {
    expect(normalizeArchivePath('a/'.repeat(40) + 'x.html').kind).toBe('unsafe');
    expect(normalizeArchivePath('x'.repeat(600)).kind).toBe('unsafe');
  });

  it('marks directories and OS metadata', () => {
    expect(normalizeArchivePath('assets/')).toEqual({ kind: 'directory' });
    expect(normalizeArchivePath('__MACOSX/._index.html').kind).toBe('ignored');
    expect(normalizeArchivePath('img/.DS_Store').kind).toBe('ignored');
  });
});

describe('resolveRelativePath', () => {
  it('resolves relative, parent and root-relative references', () => {
    expect(resolveRelativePath('', 'img/a.png')).toBe('img/a.png');
    expect(resolveRelativePath('css', '../img/a.png')).toBe('img/a.png');
    expect(resolveRelativePath('css', './fonts/f.woff2?v=1#x')).toBe('css/fonts/f.woff2');
    expect(resolveRelativePath('dist/css', '/assets/x.js', 'dist')).toBe('dist/assets/x.js');
    expect(resolveRelativePath('', 'my%20image.png')).toBe('my image.png');
  });

  it('returns null for references escaping the root or empty references', () => {
    expect(resolveRelativePath('', '../outside.png')).toBeNull();
    expect(resolveRelativePath('', '#top')).toBeNull();
  });

  it('computes dirname', () => {
    expect(dirname('a/b/c.css')).toBe('a/b');
    expect(dirname('c.css')).toBe('');
  });
});

describe('isExternalReference', () => {
  it.each([
    'https://cdn.example.com/x.js',
    '//cdn.example.com/x.js',
    'data:image/png;base64,xx',
    'blob:abc',
    '#frag',
    'mailto:a@b.c',
    '',
  ])('treats %j as external', (value) => expect(isExternalReference(value)).toBe(true));
  it.each(['img/a.png', './a.js', '../b.css', '/root.js'])('treats %j as local', (value) =>
    expect(isExternalReference(value)).toBe(false),
  );
});
