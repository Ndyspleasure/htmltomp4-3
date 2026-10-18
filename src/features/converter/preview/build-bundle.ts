import { ConverterError } from '../errors';
import type { ImportedSource, PreviewAsset, PreviewBundle } from '../types';
import { dirname } from '../validation/archive-path';
import { decodeHtml } from '../validation/validate-file';
import { mimeForPath, textAssetKind } from './mime';
import { ReferenceResolver } from './reference-resolver';
import { rewriteCss } from './rewrite-css';
import { rewriteModuleImports } from './rewrite-js';

const MAX_MISSING_WARNINGS = 10;

/**
 * Turns an imported source into a self-contained bundle for the sandbox loader: every project file
 * becomes an asset and every local reference in CSS/JS becomes a token that the loader resolves to a
 * blob: URL created inside the sandbox's opaque origin. HTML documents are rewritten by the loader.
 */
export function buildPreviewBundle(source: ImportedSource, entryPath: string): PreviewBundle {
  const entry = source.files.find((file) => file.path === entryPath);
  if (!entry) throw new ConverterError('preview-failed', `Entry point "${entryPath}" tidak ditemukan.`);

  const idByPath = new Map<string, number>();
  source.files.forEach((file, index) => idByPath.set(file.path, index));

  const baseDir = dirname(entryPath);
  const resolver = new ReferenceResolver(idByPath, baseDir);
  const decoder = new TextDecoder('utf-8');
  const warnings: string[] = [];

  const assets: PreviewAsset[] = source.files.map((file, id) => {
    const mime = mimeForPath(file.path);
    const kind = textAssetKind(file.path);
    if (kind === null) return { id, path: file.path, mime, data: toArrayBuffer(file.data), deps: [] };

    const text = decoder.decode(file.data).replace(/^\uFEFF/, '');
    if (kind === 'html') {
      // HTML is parsed only by the sandbox loader, so untrusted markup never touches the app origin's DOM.
      return { id, path: file.path, mime, data: text, deps: [], rewriteInSandbox: 'html' as const };
    }
    const deps = new Set<number>();
    const fileDir = dirname(file.path);
    const rewritten =
      kind === 'css' ? rewriteCss(text, fileDir, resolver, deps) : rewriteModuleImports(text, fileDir, resolver, deps);
    deps.delete(id);
    return { id, path: file.path, mime, data: rewritten, deps: [...deps] };
  });

  const html = decodeHtml(entry.data);

  const missing = [...resolver.missing];
  if (missing.length > 0) {
    const shown = missing.slice(0, MAX_MISSING_WARNINGS).join(', ');
    const more = missing.length > MAX_MISSING_WARNINGS ? ` dan ${missing.length - MAX_MISSING_WARNINGS} lainnya` : '';
    warnings.push(`Aset tidak ditemukan di upload: ${shown}${more}.`);
  }

  return {
    entryPath,
    html,
    assets,
    warnings,
    pathIndex: Object.fromEntries(idByPath),
    baseDir,
  };
}

function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  // Copy so that transferring/cloning never detaches or exposes the original upload buffer.
  return data.slice().buffer;
}
