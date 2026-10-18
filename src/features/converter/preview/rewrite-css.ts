import type { ReferenceResolver } from './reference-resolver';

const CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]*))\s*\)/gi;
const CSS_IMPORT_STRING = /@import\s+(?:"([^"]*)"|'([^']*)')/gi;

/** Rewrites url(...) and @import "..." references in CSS text to asset tokens. */
export function rewriteCss(css: string, fromDir: string, resolver: ReferenceResolver, deps: Set<number>): string {
  const withUrls = css.replace(CSS_URL, (match, dq?: string, sq?: string, bare?: string) => {
    const reference = dq ?? sq ?? bare ?? '';
    const replacement = resolver.resolve(reference, fromDir, deps);
    return replacement === null ? match : `url("${replacement}")`;
  });
  return withUrls.replace(CSS_IMPORT_STRING, (match, dq?: string, sq?: string) => {
    const reference = dq ?? sq ?? '';
    const replacement = resolver.resolve(reference, fromDir, deps);
    return replacement === null ? match : `@import "${replacement}"`;
  });
}
