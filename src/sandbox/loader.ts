/**
 * Sandbox loader for untrusted uploads, built to public/generated/sandbox-loader.js (classic script)
 * and loaded by public/sandbox.html.
 *
 * sandbox.html is only ever embedded with sandbox="allow-scripts" (no allow-same-origin), so this code
 * and the user's content run in an opaque origin without access to the application's DOM, storage or
 * cookies. The loader receives the preview bundle via postMessage, rewrites HTML references to asset
 * tokens (HTML is never parsed in the application origin), creates blob: URLs inside its own origin,
 * installs a small URL shim for fetch/XHR/src, then replaces the document with the user's HTML.
 */
import { ASSET_TOKEN_PATTERN } from '../features/converter/preview/asset-token';
import { ReferenceResolver } from '../features/converter/preview/reference-resolver';
import { rewriteHtml } from '../features/converter/preview/rewrite-html';
import type { PreviewAsset, PreviewBundle } from '../features/converter/types';
import { dirname } from '../features/converter/validation/archive-path';

const PROTOCOL = 1;
const MAX_REPORTED_MISSING = 10;
const appOrigin = new URL(location.href).origin;
let loaded = false;

type SandboxMessage =
  | { type: 'h2m:sandbox-ready' }
  | { type: 'h2m:sandbox-loaded'; warnings: string[] }
  | { type: 'h2m:sandbox-error'; message: string }
  | { type: 'h2m:sandbox-runtime-error'; message: string };

function post(message: SandboxMessage): void {
  parent.postMessage({ ...message, protocol: PROTOCOL }, '*');
}

interface PreparedDocument {
  html: string;
  assets: PreviewAsset[];
  warnings: string[];
}

/** Rewrites the entry document and any HTML assets inside the sandbox origin. */
export function prepareDocument(bundle: PreviewBundle): PreparedDocument {
  const idByPath = new Map<string, number>(Object.entries(bundle.pathIndex));
  const resolver = new ReferenceResolver(idByPath, bundle.baseDir);
  const warnings = new Set<string>();

  const assets = bundle.assets.map((asset) => {
    if (asset.rewriteInSandbox !== 'html' || typeof asset.data !== 'string') return asset;
    const deps = new Set<number>();
    const result = rewriteHtml(asset.data, dirname(asset.path), resolver, deps);
    deps.delete(asset.id);
    return { ...asset, data: result.html, deps: [...deps] };
  });

  const entry = rewriteHtml(bundle.html, bundle.baseDir, resolver, new Set<number>());
  entry.warnings.forEach((warning) => warnings.add(warning));
  const missing = [...resolver.missing];
  if (missing.length > 0) {
    const more = missing.length > MAX_REPORTED_MISSING ? ` dan ${missing.length - MAX_REPORTED_MISSING} lainnya` : '';
    warnings.add(`Aset tidak ditemukan di upload: ${missing.slice(0, MAX_REPORTED_MISSING).join(', ')}${more}.`);
  }
  return { html: entry.html, assets, warnings: [...warnings] };
}

/** Creates blob: URLs for all assets, resolving dependencies of text assets first. */
export function buildUrls(assets: PreviewAsset[], createUrl: (blob: Blob) => string = (b) => URL.createObjectURL(b)) {
  const urls = new Map<number, string>();
  const known = new Set(assets.map((asset) => asset.id));
  const pending = new Map(assets.map((asset) => [asset.id, asset]));
  const replaceTokens = (text: string) =>
    text.replace(ASSET_TOKEN_PATTERN, (match, id: string) => urls.get(Number(id)) ?? match);
  const create = (asset: PreviewAsset) => {
    const body = typeof asset.data === 'string' ? replaceTokens(asset.data) : asset.data;
    urls.set(asset.id, createUrl(new Blob([body], { type: asset.mime })));
    pending.delete(asset.id);
  };

  let progressed = true;
  while (pending.size > 0 && progressed) {
    progressed = false;
    for (const asset of [...pending.values()]) {
      const ready = typeof asset.data !== 'string' || asset.deps.every((dep) => urls.has(dep) || !known.has(dep));
      if (ready) {
        create(asset);
        progressed = true;
      }
    }
  }
  // Circular references (rare, e.g. CSS @import cycles): create what is left with partial tokens.
  [...pending.values()].forEach(create);
  return { urls, replaceTokens };
}

/** Maps URLs that point at project files (relative to the entry document) to their blob: URLs. */
export function createUrlMapper(
  urls: Map<number, string>,
  pathIndex: Record<string, number>,
  baseDir: string,
  documentBase: string,
) {
  const origin = new URL(documentBase).origin;
  return (input: string): string => {
    if (/^(blob:|data:|about:|javascript:)/i.test(input)) return input;
    let parsed: URL;
    try {
      parsed = new URL(input, documentBase);
    } catch {
      return input;
    }
    if (parsed.origin !== origin) return input;
    let path = parsed.pathname;
    try {
      path = decodeURIComponent(path);
    } catch {
      /* keep the raw path */
    }
    path = path.replace(/^\/+/, '');
    const candidates = baseDir ? [`${baseDir}/${path}`, path] : [path];
    for (const candidate of candidates) {
      const id = pathIndex[candidate];
      const url = id === undefined ? undefined : urls.get(id);
      if (url) return url + parsed.hash;
    }
    return input;
  };
}

function installShim(mapUrl: (input: string) => string): void {
  const originalFetch = window.fetch;
  window.fetch = function patchedFetch(this: unknown, resource: RequestInfo | URL, init?: RequestInit) {
    if (typeof resource === 'string' || resource instanceof URL) {
      return originalFetch.call(this, mapUrl(String(resource)), init);
    }
    const mapped = mapUrl(resource.url);
    return originalFetch.call(this, mapped === resource.url ? resource : new Request(mapped, resource), init);
  } as typeof window.fetch;

  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function patchedOpen(this: XMLHttpRequest, ...args: unknown[]) {
    if (args.length > 1) args[1] = mapUrl(String(args[1]));
    return (originalOpen as (...a: unknown[]) => void).apply(this, args);
  } as typeof XMLHttpRequest.prototype.open;

  const urlAttributes = new Set(['src', 'href', 'poster', 'data']);
  const originalSetAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function patchedSetAttribute(this: Element, name: string, value: string) {
    const mapped =
      this.tagName !== 'A' && urlAttributes.has(String(name).toLowerCase()) ? mapUrl(String(value)) : value;
    return originalSetAttribute.call(this, name, mapped);
  };

  const wrapSetter = (ctor: { prototype: object } | undefined, property: string) => {
    if (!ctor) return;
    const descriptor = Object.getOwnPropertyDescriptor(ctor.prototype, property);
    if (!descriptor?.set || !descriptor.get) return;
    const { get, set } = descriptor;
    Object.defineProperty(ctor.prototype, property, {
      configurable: true,
      enumerable: descriptor.enumerable ?? true,
      get,
      set(this: unknown, value: unknown) {
        set.call(this, typeof value === 'string' ? mapUrl(value) : value);
      },
    });
  };
  wrapSetter(window.HTMLImageElement, 'src');
  wrapSetter(window.HTMLMediaElement, 'src');
  wrapSetter(window.HTMLSourceElement, 'src');
  wrapSetter(window.HTMLScriptElement, 'src');
  wrapSetter(window.HTMLIFrameElement, 'src');
  wrapSetter(window.HTMLEmbedElement, 'src');
  wrapSetter(window.HTMLTrackElement, 'src');
  wrapSetter(window.HTMLLinkElement, 'href');
  wrapSetter(window.HTMLVideoElement, 'poster');

  const OriginalAudio = window.Audio;
  if (typeof OriginalAudio === 'function') {
    const PatchedAudio = function Audio(src?: string) {
      return src === undefined ? new OriginalAudio() : new OriginalAudio(mapUrl(String(src)));
    } as unknown as typeof Audio;
    PatchedAudio.prototype = OriginalAudio.prototype;
    window.Audio = PatchedAudio;
  }
}

function onMessage(event: MessageEvent): void {
  if (event.source !== parent || event.origin !== appOrigin) return;
  const data = event.data as { type?: unknown; bundle?: PreviewBundle } | null;
  if (!data || data.type !== 'h2m:load' || !data.bundle || loaded) return;
  loaded = true;
  window.removeEventListener('message', onMessage);
  try {
    const bundle = data.bundle;
    const prepared = prepareDocument(bundle);
    const { urls, replaceTokens } = buildUrls(prepared.assets);
    installShim(createUrlMapper(urls, bundle.pathIndex, bundle.baseDir, document.baseURI));
    const html = replaceTokens(prepared.html);
    document.open();
    document.write(html);
    document.close();
    window.addEventListener('error', (errorEvent) => {
      post({ type: 'h2m:sandbox-runtime-error', message: String(errorEvent.message || 'Error') });
    });
    post({ type: 'h2m:sandbox-loaded', warnings: prepared.warnings });
  } catch (error) {
    post({ type: 'h2m:sandbox-error', message: error instanceof Error ? error.message : String(error) });
  }
}

if (typeof window !== 'undefined' && window.parent !== window) {
  window.addEventListener('message', onMessage);
  post({ type: 'h2m:sandbox-ready' });
}
