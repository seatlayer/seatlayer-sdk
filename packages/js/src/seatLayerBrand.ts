/** Dependency-free canonical SeatLayer mark for distributed SDK attribution.
 *
 * Keep the geometry in sync with `SeatLayerMark` and
 * `scripts/generate-brand-assets.py`. The fixed dark-surface palette makes the
 * fragment safe inside the self-contained midnight attribution tile.
 */
export const SEATLAYER_ATTRIBUTION_MARK_SVG =
  '<svg viewBox="0 0 64 56" width="12" height="11" fill="none" aria-hidden="true" focusable="false" style="display:block">' +
  '<path d="M4 13 Q16 6 29 7 L28.5 17 Q17 16.5 7 22 Z" fill="#f4b740"/>' +
  '<path d="M4 13 Q16 6 29 7 L28.5 17 Q17 16.5 7 22 Z" fill="#f4b740" transform="translate(64 0) scale(-1 1)"/>' +
  '<path d="M8 28 Q18 22 28.6 23 L28.2 32 Q18 28.5 10 36 Z" fill="#fcf7ee"/>' +
  '<path d="M8 28 Q18 22 28.6 23 L28.2 32 Q18 28.5 10 36 Z" fill="#fcf7ee" transform="translate(64 0) scale(-1 1)"/>' +
  '<path d="M11 41 Q19 35 28.2 36 L27.8 45 Q19.5 42 13.5 49 Z" fill="#fcf7ee"/>' +
  '<path d="M11 41 Q19 35 28.2 36 L27.8 45 Q19.5 42 13.5 49 Z" fill="#fcf7ee" transform="translate(64 0) scale(-1 1)"/>' +
  '</svg>';
