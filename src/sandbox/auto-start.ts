/** Labels of buttons that start an animation/player (Indonesian and English). */
const START_LABEL =
  /^(?:[▶►⏵▷]\s*)?(putar|mainkan|mulai|play|start|tonton|watch|begin)(?:\s+(video|animasi|sekarang|now))?\s*[▶►⏵!]*$/i;

/**
 * Clicks the most likely "Play/Putar" control so animations that wait for a click start by themselves.
 * Returns a description of what was clicked, or null when nothing suitable was found.
 */
export function clickStartControl(doc: Document): string | null {
  const view = doc.defaultView;
  const candidates = [
    ...doc.querySelectorAll<HTMLElement>(
      'button, [role="button"], a, input[type="button"], .play, .play-btn, #play, #start',
    ),
  ];
  for (const element of candidates) {
    const label = (
      element.getAttribute('aria-label') ??
      element.textContent ??
      (element as HTMLInputElement).value ??
      ''
    )
      .trim()
      .replace(/\s+/g, ' ');
    const byId = /(^|[-_])(play|start|putar|mulai)([-_]|$)/i.test(`${element.id} ${element.className}`);
    if (!START_LABEL.test(label) && !byId) continue;
    if (element instanceof HTMLButtonElement && element.disabled) continue;
    const style = view?.getComputedStyle(element);
    if (style && (style.display === 'none' || style.visibility === 'hidden')) continue;
    element.click();
    return label || element.id || 'tombol play';
  }
  return null;
}
