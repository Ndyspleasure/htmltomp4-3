import type { SuggestedLayout } from '../features/converter/render/sandbox-protocol';

export interface Stage {
  element: HTMLElement;
  layout: Exclude<SuggestedLayout, null>;
}

/**
 * Finds the animation's "stage": the largest visible, painted element that occupies most of the viewport
 * in at least one dimension (e.g. a 9:16 phone frame centred on the page with player controls
 * underneath). Returns null when no such element exists.
 */
export function findStage(doc: Document): Stage | null {
  const view = doc.defaultView;
  if (!view || !doc.body) return null;
  const vw = view.innerWidth;
  const vh = view.innerHeight;
  let best: { element: HTMLElement; area: number; ratio: number } | null = null;
  const elements = doc.body.querySelectorAll<HTMLElement>('*');
  for (let i = 0; i < elements.length && i < 3000; i++) {
    const element = elements[i]!;
    const rect = element.getBoundingClientRect();
    if (rect.width < 50 || rect.height < 50) continue;
    if (rect.height < vh * 0.6 && rect.width < vw * 0.6) continue;
    if (!isEffectivelyVisible(element, view)) continue;
    const style = view.getComputedStyle(element);
    const painted =
      (style.backgroundColor !== 'rgba(0, 0, 0, 0)' && style.backgroundColor !== 'transparent') ||
      style.backgroundImage !== 'none' ||
      element instanceof HTMLCanvasElement ||
      element instanceof HTMLVideoElement ||
      element instanceof HTMLImageElement;
    if (!painted) continue;
    const area = rect.width * rect.height;
    if (!best || area > best.area) best = { element, area, ratio: rect.width / rect.height };
  }
  if (!best) return null;
  // A stage that already fills the viewport is fine to crop to (it drops margins), but is not a "shape" hint.
  const layout = best.ratio < 0.8 ? 'portrait' : best.ratio <= 1.2 ? 'square' : 'landscape';
  return { element: best.element, layout };
}

export function detectLayout(doc: Document): SuggestedLayout {
  const stage = findStage(doc);
  if (!stage) return null;
  // Content that fills the viewport has no separate shape worth suggesting.
  const view = doc.defaultView;
  const rect = stage.element.getBoundingClientRect();
  if (view && rect.width >= view.innerWidth * 0.95 && rect.height >= view.innerHeight * 0.95) return null;
  return stage.layout;
}

/** False when the element or any ancestor is hidden, transparent (opacity 0) or not displayed. */
function isEffectivelyVisible(element: Element, view: Window): boolean {
  for (
    let node: Element | null = element;
    node && node !== element.ownerDocument.documentElement;
    node = node.parentElement
  ) {
    const style = view.getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
  }
  return true;
}
