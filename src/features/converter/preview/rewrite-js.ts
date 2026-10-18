import { parse } from 'es-module-lexer/js';
import type { ReferenceResolver } from './reference-resolver';

/** Only relative or root-relative specifiers point into the project; bare and URL specifiers stay as-is. */
function isProjectSpecifier(specifier: string): boolean {
  return specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('/');
}

/**
 * Rewrites static and literal dynamic import specifiers of ES modules to asset tokens, because modules
 * loaded from blob: URLs cannot resolve relative specifiers. Scripts that cannot be lexed are returned
 * unchanged (classic scripts without imports do not need rewriting).
 */
export function rewriteModuleImports(
  source: string,
  fromDir: string,
  resolver: ReferenceResolver,
  deps: Set<number>,
): string {
  let imports;
  try {
    [imports] = parse(source);
  } catch {
    return source;
  }

  const edits: { start: number; end: number; text: string }[] = [];
  for (const entry of imports) {
    if (entry.type !== 'static' && entry.type !== 'dynamic' && entry.type !== 'reexport-star') continue;
    const specifier = entry.specifier;
    if (typeof specifier !== 'string' || !isProjectSpecifier(specifier)) continue;
    let start = entry.start;
    let end = entry.end;
    const raw = source.slice(start, end);
    // Template-literal dynamic imports are globs (`./x/${name}.js`) and cannot be mapped statically.
    if (raw.startsWith('`')) continue;
    // Dynamic import positions include the quotes; static ones do not. Normalise to the inner text.
    if (/^['"]/.test(raw) && raw.length >= 2) {
      start += 1;
      end -= 1;
    }
    const replacement = resolver.resolve(specifier, fromDir, deps);
    if (replacement !== null) edits.push({ start, end, text: replacement });
  }

  if (edits.length === 0) return source;
  edits.sort((a, b) => b.start - a.start);
  let output = source;
  for (const edit of edits) output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
  return output;
}
