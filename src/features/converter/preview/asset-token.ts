/**
 * References to project files are replaced with tokens while building the preview bundle. The sandbox
 * loader swaps each token for a blob: URL it creates inside its own (opaque) origin.
 * The format must stay in sync with public/sandbox.html.
 */
export const ASSET_TOKEN_PATTERN = /__H2M_ASSET_(\d+)__/g;

export function assetToken(id: number): string {
  return `__H2M_ASSET_${id}__`;
}
