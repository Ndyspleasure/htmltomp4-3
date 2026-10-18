import { isExternalReference, resolveRelativePath } from '../validation/archive-path';
import { assetToken } from './asset-token';

/**
 * Maps references found in project files to asset tokens. Collects the asset ids each file depends on
 * and the references that could not be found in the upload.
 */
export class ReferenceResolver {
  readonly missing = new Set<string>();

  constructor(
    private readonly idByPath: ReadonlyMap<string, number>,
    private readonly rootDir: string,
  ) {}

  /**
   * Returns the replacement for `reference` (token plus preserved #fragment), or null when the
   * reference is external or unknown and must stay untouched.
   */
  resolve(reference: string, fromDir: string, deps: Set<number>): string | null {
    const trimmed = reference.trim();
    if (isExternalReference(trimmed)) return null;
    const path = resolveRelativePath(fromDir, trimmed, this.rootDir);
    const id = path === null ? undefined : this.idByPath.get(path);
    if (id === undefined) {
      this.missing.add(path ?? trimmed);
      return null;
    }
    deps.add(id);
    const hashIndex = trimmed.indexOf('#');
    return assetToken(id) + (hashIndex === -1 ? '' : trimmed.slice(hashIndex));
  }
}
