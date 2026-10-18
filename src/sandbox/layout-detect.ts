import type { SuggestedLayout } from '../features/converter/render/sandbox-protocol';

/**
 * Guesses the shape of the animation's "stage": the largest visible element that is clearly smaller than
 * the viewport and occupies most of it in one dimension (e.g. a 9:16 phone frame centred on the page).
 * Returns null when the content simply fills the viewport.
 */
export function detectLayout(doc: Document): SuggestedLayout {
  const view = doc.defaultView;
  if (!view || !doc.body) return null;
  const vw = view.innerWidth;
  const vh = view.innerHeight;
  let best: { area: number; ratio: number } | null = null;
  const elements = doc.body.querySelectorAll<HTMLElement>('*');
  for (let i = 0; i < elements.length && i < 3000; i++) {
    const element = elements[i]!;
    const rect = element.getBoundingClientRect();
    if (rect.width < 50 || rect.height < 50) continue;
    const coversHeight = rect.height >= vh * 0.6;
    const coversWidth = rect.width >= vw * 0.6;
    if (!coversHeight && !coversWidth) continue;
    if (rect.width >= vw * 0.95 && rect.height >= vh * 0.95) continue;
    const style = view.getComputedStyle(element);
    const painted =
      (style.backgroundColor !== 'rgba(0, 0, 0, 0)' && style.backgroundColor !== 'transparent') ||
      style.backgroundImage !== 'none' ||
      element instanceof HTMLCanvasElement ||
      element instanceof HTMLVideoElement ||
      element instanceof HTMLImageElement;
    if (!painted) continue;
    const area = rect.width * rect.height;
    if (!best || area > best.area) best = { area, ratio: rect.width / rect.height };
  }
  if (!best) return null;
  if (best.ratio < 0.8) return 'portrait';
  if (best.ratio <= 1.2) return 'square';
  return 'landscape';
}
