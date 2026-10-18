import type { ReferenceResolver } from './reference-resolver';
import { rewriteCss } from './rewrite-css';
import { rewriteModuleImports } from './rewrite-js';

/** Attributes that load a resource (navigation links such as <a href> are intentionally excluded). */
const URL_ATTRIBUTES: ReadonlyArray<{ selector: string; attribute: string }> = [
  { selector: 'script[src]', attribute: 'src' },
  { selector: 'img[src]', attribute: 'src' },
  { selector: 'iframe[src]', attribute: 'src' },
  { selector: 'frame[src]', attribute: 'src' },
  { selector: 'audio[src]', attribute: 'src' },
  { selector: 'video[src]', attribute: 'src' },
  { selector: 'video[poster]', attribute: 'poster' },
  { selector: 'source[src]', attribute: 'src' },
  { selector: 'track[src]', attribute: 'src' },
  { selector: 'embed[src]', attribute: 'src' },
  { selector: 'input[src]', attribute: 'src' },
  { selector: 'object[data]', attribute: 'data' },
  { selector: 'link[href]', attribute: 'href' },
  { selector: 'image[href]', attribute: 'href' },
  { selector: 'use[href]', attribute: 'href' },
  { selector: 'feImage[href]', attribute: 'href' },
];

const XLINK_NS = 'http://www.w3.org/1999/xlink';

export interface HtmlRewriteResult {
  html: string;
  warnings: string[];
}

/**
 * Parses untrusted HTML with DOMParser (scripts are inert there) and rewrites every reference to a
 * project file into an asset token. The document is never attached to the application DOM.
 */
export function rewriteHtml(
  html: string,
  fromDir: string,
  resolver: ReferenceResolver,
  deps: Set<number>,
): HtmlRewriteResult {
  const warnings: string[] = [];
  const doc = new DOMParser().parseFromString(html, 'text/html');

  const bases = doc.querySelectorAll('base');
  if (bases.length > 0) {
    bases.forEach((base) => base.remove());
    warnings.push('Elemen <base> dihapus agar aset lokal dapat dimuat di preview.');
  }

  for (const { selector, attribute } of URL_ATTRIBUTES) {
    doc.querySelectorAll(selector).forEach((element) => {
      const value = element.getAttribute(attribute);
      if (value === null) return;
      const replacement = resolver.resolve(value, fromDir, deps);
      if (replacement !== null) element.setAttribute(attribute, replacement);
    });
  }

  doc.querySelectorAll('*').forEach((element) => {
    const xlink = element.getAttributeNS(XLINK_NS, 'href');
    if (xlink !== null) {
      const replacement = resolver.resolve(xlink, fromDir, deps);
      if (replacement !== null) element.setAttributeNS(XLINK_NS, 'xlink:href', replacement);
    }
  });

  doc.querySelectorAll('img[srcset], source[srcset]').forEach((element) => {
    const value = element.getAttribute('srcset');
    if (value) element.setAttribute('srcset', rewriteSrcset(value, fromDir, resolver, deps));
  });

  doc.querySelectorAll('[style]').forEach((element) => {
    const value = element.getAttribute('style');
    if (value) element.setAttribute('style', rewriteCss(value, fromDir, resolver, deps));
  });

  doc.querySelectorAll('style').forEach((element) => {
    element.textContent = rewriteCss(element.textContent ?? '', fromDir, resolver, deps);
  });

  doc.querySelectorAll('script:not([src])').forEach((element) => {
    if (element.getAttribute('type')?.trim().toLowerCase() !== 'module') return;
    element.textContent = rewriteModuleImports(element.textContent ?? '', fromDir, resolver, deps);
  });

  const doctype = doc.doctype ? `<!DOCTYPE ${doc.doctype.name}>\n` : '';
  return { html: doctype + doc.documentElement.outerHTML, warnings };
}

function rewriteSrcset(value: string, fromDir: string, resolver: ReferenceResolver, deps: Set<number>): string {
  return value
    .split(',')
    .map((candidate) => {
      const parts = candidate.trim().split(/\s+/);
      const url = parts[0];
      if (!url) return candidate;
      const replacement = resolver.resolve(url, fromDir, deps);
      return [replacement ?? url, ...parts.slice(1)].join(' ');
    })
    .join(', ');
}
