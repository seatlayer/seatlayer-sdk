/**
 * Establish a positioning context only when the host is genuinely static.
 *
 * Buyer overlays are positioned by stylesheet rules. Checking only the inline
 * style would overwrite `position:absolute` and collapse the 3D canvas.
 */
export function establishPositioningContext(container: HTMLElement): () => void {
  const originalInline = container.style.position;
  if (getComputedStyle(container).position !== 'static') return () => {};

  container.style.position = 'relative';
  return () => {
    // Preserve any host change made while the renderer was mounted.
    if (container.style.position === 'relative') container.style.position = originalInline;
  };
}
