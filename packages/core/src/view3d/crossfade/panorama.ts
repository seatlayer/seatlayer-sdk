/**
 * Slice 3 hand-off — the DOM panorama overlay the fly-to-seat cinematic
 * dissolves into. Decoupled by design: the CALLER supplies the equirectangular
 * image (via mountVenue3D's getSeatView), so view3d never imports the app's
 * panorama generator and the chunk stays lean.
 *
 * Technique (mirrors SeatPicker.openSeatView, reimplemented small): an equirect
 * image panned with `repeat-x`; the initial horizontal offset is set so the
 * panorama's bearing matches the final camera yaw — the dissolve reads as the
 * same view sharpening, not a cut. CSS opacity fade is compositor-only.
 */

export interface SeatView {
  url: string;
  /** Bearing (deg, 0 = facing the focal/stage) the panorama should open centred
   * on, to match the camera's final yaw. Default 0 (both face the stage). */
  initialBearingDeg?: number;
}

export interface PanoramaHandle {
  /** Fade out and return to the (frozen) 3D view; calls opts.onClose after. */
  close(): void;
  /** Immediate teardown (dispose) — no fade, no onClose. */
  dispose(): void;
}

/**
 * Horizontal background-position (px) that centres `bearingDeg` in the viewport,
 * assuming the equirect image's yaw 0 sits at its horizontal centre. `repeat-x`
 * handles the wrap, so any real value is valid.
 */
export function bearingToOffsetPx(bearingDeg: number, viewportW: number, bgW: number): number {
  const col = (0.5 + bearingDeg / 360) * bgW; // image column (px) for the bearing
  return viewportW / 2 - col;
}

export interface PanoramaOptions {
  fadeMs?: number;
  seatLabel?: string;
  onClose?: () => void;
}

export function mountPanorama(container: HTMLElement, view: SeatView, opts: PanoramaOptions = {}): PanoramaHandle {
  const fadeMs = opts.fadeMs ?? 400;
  const bearing = view.initialBearingDeg ?? 0;

  const root = document.createElement('div');
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', opts.seatLabel ? `View from ${opts.seatLabel}` : 'View from seat');
  Object.assign(root.style, {
    position: 'absolute', inset: '0', zIndex: '10', opacity: '0',
    transition: `opacity ${fadeMs}ms ease`, background: '#05070c',
    overflow: 'hidden', touchAction: 'none',
  } as CSSStyleDeclaration);

  const pano = document.createElement('div');
  Object.assign(pano.style, {
    position: 'absolute', inset: '0',
    backgroundImage: `url("${view.url}")`, backgroundRepeat: 'repeat-x',
    cursor: 'grab',
  } as CSSStyleDeclaration);
  root.appendChild(pano);

  // Close affordance.
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.textContent = '✕';
  Object.assign(closeBtn.style, {
    position: 'absolute', top: '12px', right: '12px', zIndex: '2',
    width: '34px', height: '34px', borderRadius: '999px', cursor: 'pointer',
    border: '1px solid rgba(255,255,255,0.25)', background: 'rgba(8,12,18,0.6)',
    color: '#e6edf3', fontSize: '15px', lineHeight: '1',
  } as CSSStyleDeclaration);
  root.appendChild(closeBtn);

  const hint = document.createElement('div');
  hint.textContent = 'Drag to look around · Esc to close';
  Object.assign(hint.style, {
    position: 'absolute', bottom: '12px', left: '0', right: '0', textAlign: 'center',
    color: 'rgba(230,237,243,0.7)', font: '12px ui-sans-serif, system-ui, sans-serif',
    pointerEvents: 'none',
  } as CSSStyleDeclaration);
  root.appendChild(hint);

  container.appendChild(root);

  // Layout: size the image to the viewport height, pan horizontally. bgW comes
  // from the loaded image's aspect; until then a first guess (2:1 equirect).
  let bgW = 0;
  let posX = 0;
  let posY = 0;
  const layout = (): void => {
    const vh = root.clientHeight || 1;
    const vw = root.clientWidth || 1;
    const natW = img.naturalWidth || vw * 2;
    const natH = img.naturalHeight || vh;
    bgW = vh * (natW / natH);
    pano.style.backgroundSize = `${bgW}px ${vh}px`;
    if (!posInitialised) { posX = bearingToOffsetPx(bearing, vw, bgW); posInitialised = true; }
    pano.style.backgroundPosition = `${posX}px ${posY}px`;
  };
  let posInitialised = false;

  const img = new Image();
  img.onload = layout;
  img.src = view.url;
  // If it's already cached, onload may not fire — lay out on next frame too.
  requestAnimationFrame(layout);

  // Horizontal pan (v1: horizontal only; repeat-x wraps seamlessly).
  let dragging = false;
  let lastX = 0;
  const onDown = (e: PointerEvent): void => {
    dragging = true; lastX = e.clientX; pano.style.cursor = 'grabbing';
    try { pano.setPointerCapture?.(e.pointerId); } catch { /* no active pointer */ }
  };
  const onMove = (e: PointerEvent): void => {
    if (!dragging) return;
    posX += e.clientX - lastX;
    lastX = e.clientX;
    pano.style.backgroundPosition = `${posX}px ${posY}px`;
  };
  const onUp = (e: PointerEvent): void => {
    dragging = false; pano.style.cursor = 'grab';
    try { pano.releasePointerCapture?.(e.pointerId); } catch { /* no active pointer */ }
  };
  pano.addEventListener('pointerdown', onDown);
  pano.addEventListener('pointermove', onMove);
  pano.addEventListener('pointerup', onUp);
  pano.addEventListener('pointercancel', onUp);

  let closed = false;
  let disposed = false;
  let fadeTimer = 0;
  const removeListeners = (): void => {
    pano.removeEventListener('pointerdown', onDown);
    pano.removeEventListener('pointermove', onMove);
    pano.removeEventListener('pointerup', onUp);
    pano.removeEventListener('pointercancel', onUp);
    window.removeEventListener('keydown', onKey);
  };
  const teardown = (): void => {
    if (fadeTimer) { window.clearTimeout(fadeTimer); fadeTimer = 0; }
    removeListeners();
    if (root.parentNode) root.parentNode.removeChild(root);
  };
  const close = (): void => {
    if (closed) return;
    closed = true;
    root.style.opacity = '0';
    // Guard the fade callback: a dispose() (or a retarget that disposes us) inside
    // the fade window clears the timer AND flips `disposed`, so a stray fire can
    // never call onClose into a newer flight/panorama.
    const done = (): void => {
      fadeTimer = 0;
      if (disposed) return;
      teardown();
      opts.onClose?.();
    };
    fadeTimer = window.setTimeout(done, fadeMs);
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
  };
  window.addEventListener('keydown', onKey);
  closeBtn.addEventListener('click', close);

  // Fade in on the next frame (0 → 1).
  requestAnimationFrame(() => { root.style.opacity = '1'; });

  return {
    close,
    dispose(): void { closed = true; disposed = true; teardown(); },
  };
}
